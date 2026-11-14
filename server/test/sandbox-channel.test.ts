import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, verify, createHash } from 'node:crypto'
import { AlipayChannel, canonicalParameters, parseAlipayResponse } from '../src/alipay-channel.ts'
import { KdniaoChannel } from '../src/kdniao-channel.ts'
import { readConfig } from '../src/config.ts'

const appKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const platformKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKey = appKeys.privateKey.export({type:'pkcs8',format:'pem'}).toString()
const publicKey = platformKeys.publicKey.export({type:'spki',format:'pem'}).toString()
const now=Date.parse('2026-11-14T08:00:00+08:00')
const payment={id:'payment-1',orderId:'order-1',payerId:'user-1',amount:1234,created:now,graceDeadline:now+600000}
const config={appId:'2026000000000001',sellerId:'2088000000000001',privateKey,publicKey,returnUrl:'https://demo.example.test/payments/return'}
function response(method:string,data:object) {
  const raw=JSON.stringify(data)
  return new Response(`{"${method.replaceAll('.','_')}_response":${raw},"sign":${JSON.stringify(sign('RSA-SHA256',Buffer.from(raw),platformKeys.privateKey).toString('base64'))}}`)
}
const queryData={code:'10000',out_trade_no:payment.id,trade_no:'202611140001',total_amount:'12.34',trade_status:'TRADE_SUCCESS',send_pay_date:'2026-11-14 08:01:00'}
test('G RSA2 手机网站下单只生成沙箱地址，金额订单号和截止时间由服务端签名',async()=>{
  const channel=new AlipayChannel(config)
  const result=await channel.create(payment)
  assert.equal(result.accepted,true)
  const url=new URL(result.checkoutUrl!)
  assert.equal(url.origin,'https://openapi-sandbox.dl.alipaydev.com')
  const params=Object.fromEntries(url.searchParams),signature=params.sign!
  delete params.sign
  assert.equal(verify('RSA-SHA256',Buffer.from(canonicalParameters(params)),appKeys.publicKey,Buffer.from(signature,'base64')),true)
  assert.deepEqual(JSON.parse(params.biz_content!).total_amount,'12.34')
  assert.equal(JSON.parse(params.biz_content!).out_trade_no,payment.id)
  assert.equal(params.method,'alipay.trade.wap.pay')
})
test('G 原始响应子串验签保持空白和键顺序，篡改与缺少签名拒绝',()=>{
  // 使用包含括号和转义字符的合法 JSON，不允许解析后重新序列化验签。
  const body=JSON.stringify({code:'10000',text:'brace } " quote'},null,2)
  const signature=sign('RSA-SHA256',Buffer.from(body),platformKeys.privateKey).toString('base64')
  const signed=`{"alipay_trade_query_response":${body},"sign":"${signature}"}`
  assert.equal(parseAlipayResponse(signed,'alipay.trade.query',publicKey).code,'10000')
  assert.throws(()=>parseAlipayResponse(signed.replace('10000','10001'),'alipay.trade.query',publicKey))
  assert.throws(()=>parseAlipayResponse('{"alipay_trade_query_response":{}}','alipay.trade.query',publicKey))
})
test('G 查单核对交易号金额及北京时间，网络与错单不确认成功',async()=>{
  const channel=new AlipayChannel(config,async()=>response('alipay.trade.query',queryData))
  assert.deepEqual(await channel.query(payment.id),{state:'success',amount:1234,paidAt:now+60000,channelTransactionId:'202611140001'})
  const wrong=new AlipayChannel(config,async()=>response('alipay.trade.query',{...queryData,out_trade_no:'other'}))
  assert.deepEqual(await wrong.query(payment.id),{state:'unknown'})
  const offline=new AlipayChannel(config,async()=>{throw new Error('upstream private detail')})
  assert.deepEqual(await offline.query(payment.id),{state:'unknown'})
})
test('G 通知验签校验商户应用金额，拒绝重复表单字段且仅解码一次',()=>{
  const channel=new AlipayChannel(config)
  const fields={app_id:config.appId,seller_id:config.sellerId,out_trade_no:payment.id,total_amount:'12.34',trade_status:'TRADE_SUCCESS',gmt_payment:'2026-11-14 08:01:00',trade_no:'202611140001',subject:'订单+测试%20'}
  const signature=sign('RSA-SHA256',Buffer.from(canonicalParameters(fields)),platformKeys.privateKey).toString('base64')
  const form=new URLSearchParams({...fields,sign_type:'RSA2',sign:signature}).toString()
  assert.equal(channel.verifyNotification(form).amount,1234)
  assert.throws(()=>channel.verifyNotification(form+'&total_amount=0.01'))
  assert.throws(()=>channel.verifyNotification(form.replace('12.34','12.35')))
  const bad={...fields,seller_id:'other'}
  const badSign=sign('RSA-SHA256',Buffer.from(canonicalParameters(bad)),platformKeys.privateKey).toString('base64')
  assert.throws(()=>channel.verifyNotification(new URLSearchParams({...bad,sign_type:'RSA2',sign:badSign}).toString()))
})
test('G 退款先查询幂等结果，已成功不重复退款，10000不等于退款成功',async()=>{
  let calls=0
  const channel=new AlipayChannel(config,async()=>{calls++;return response('alipay.trade.fastpay.refund.query',{code:'10000',out_trade_no:payment.id,out_request_no:'refund-1',refund_amount:'12.34',refund_status:'REFUND_SUCCESS',refund_settlement_id:'settlement-1'})})
  assert.equal(await channel.refund('refund-1',payment.id,1234),'success')
  assert.equal(channel.refundReference('refund-1'),'settlement-1')
  assert.equal(calls,1)
  const notConfirmed=new AlipayChannel(config,async(_url,init)=>{
    const method=new URLSearchParams(String(init?.body)).get('method')!
    return response(method,{code:'10000',out_trade_no:payment.id,out_request_no:'refund-2',refund_amount:'12.34',refund_fee:'12.34',fund_change:'N'})
  })
  assert.equal(await notConfirmed.refund('refund-2',payment.id,1234),'fail')
})
test('G 快递鸟签名与真实报文解析，按事件时间签收、去重、复用查询',async()=>{
  let calls=0
  const channel=new KdniaoChannel({businessId:'test-business',appKey:'local-test-value'},async(_url,init)=>{
    calls++
    const params=new URLSearchParams(String(init?.body)),data=params.get('RequestData')!
    const expected=Buffer.from(createHash('md5').update(data+'local-test-value').digest('hex')).toString('base64')
    assert.equal(params.get('DataSign'),expected)
    return new Response(JSON.stringify({EBusinessID:'test-business',ShipperCode:'YTO',LogisticCode:'YT12345678',Success:true,State:'3',Traces:[
      {AcceptTime:'2026/11/14 09:00:00',AcceptStation:'已签收'},
      {AcceptTime:'2026/11/14 08:00:00',AcceptStation:'运输中'},
      {AcceptTime:'2026/11/14 08:00:00',AcceptStation:'运输中'}]}))
  })
  const shipment={orderId:'o1',carrier:'圆通',trackingNo:'YT12345678',source:'carrier',state:'waiting',created:now-1000}
  const events=await channel.query(shipment)
  assert.equal(events.length,2)
  assert.equal(events[0]!.state,'transit')
  assert.equal(events[1]!.state,'signed')
  assert.deepEqual(await channel.query(shipment),events)
  assert.equal(calls,1)
})
test('G 快递查询错单与网络错误不能制造签收',async()=>{
  const shipment={orderId:'o1',carrier:'圆通',trackingNo:'YT12345678',source:'carrier',state:'waiting',created:now}
  const offline=new KdniaoChannel({businessId:'test-business',appKey:'local-test-value'},async()=>{throw new Error('sensitive upstream')})
  await assert.rejects(()=>offline.query(shipment),/物流查询暂时不可用/)
  const wrong=new KdniaoChannel({businessId:'test-business',appKey:'local-test-value'},async()=>new Response(JSON.stringify({Success:true,LogisticCode:'other',State:3,Traces:[]})))
  await assert.rejects(()=>wrong.query(shipment))
  for (const [name,code] of [['京东物流','JD'],['邮政EMS','EMS']]) {
    const mapped=new KdniaoChannel({businessId:'test-business',appKey:'local-test-value'},async(_url,init)=>{
      const request=JSON.parse(new URLSearchParams(String(init?.body)).get('RequestData')!)
      assert.equal(request.ShipperCode,code)
      return new Response(JSON.stringify({EBusinessID:'test-business',ShipperCode:code,LogisticCode:shipment.trackingNo,Success:true,State:'0',Traces:[]}))
    })
    assert.deepEqual(await mapped.query({...shipment,carrier:name!}),[])
  }
})
test('G 配置缺失只报告字段，拒绝正式环境沙箱和未知渠道，mock保持兼容',()=>{
  assert.throws(()=>readConfig({PAYMENT_CHANNEL:'alipay-sandbox'}),/ALIPAY_APP_ID/)
  assert.throws(()=>readConfig({PAYMENT_CHANNEL:'unexpected'}))
  assert.throws(()=>readConfig({LOGISTICS_CHANNEL:'kdniao'}),/KDNIAO_BUSINESS_ID/)
  assert.throws(()=>readConfig({NODE_ENV:'production',PAYMENT_CHANNEL:'alipay-sandbox'}),/沙箱/)
  assert.equal(readConfig({PAYMENT_CHANNEL:'mock'}).appOptions.mockPayments,true)
  assert.equal(readConfig({MOCK_PAYMENTS:'true'}).appOptions.mockPayments,true)
})
