import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { buildTestApp } from './helpers/fixtures.ts'
import { AlipayChannel, canonicalParameters } from '../src/alipay-channel.ts'
import { beijingTime } from '../src/channel-http.ts'
import { KdniaoChannel } from '../src/kdniao-channel.ts'
import type { LogisticsChannel } from '../src/logistics.ts'

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const config = { appId:'2026000000000001', sellerId:'2088000000000001',
  privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),
  publicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString(), returnUrl:'http://127.0.0.1:3000/payments/return' }

async function fixture(logisticsChannel?: LogisticsChannel, contact='13800000000') {
  let now = Date.parse('2026-11-14T08:00:00+08:00'), paidAt = now, state = 'WAIT_BUYER_PAY', offline = false
  const refunds = new Set<string>(), requests: string[] = []
  const channel = new AlipayChannel(config, async (_url, init) => {
    if (offline) throw new Error('network unavailable')
    const params = new URLSearchParams(String(init?.body)), method = params.get('method')!
    requests.push(method)
    const biz = JSON.parse(params.get('biz_content')!)
    let data: object = {code:'10000',out_trade_no:biz.out_trade_no,trade_no:'sandbox-transaction',total_amount:'24.75',trade_status:state,send_pay_date:beijingTime(paidAt)}
    if (method === 'alipay.trade.close') { state='TRADE_CLOSED'; data={code:'10000',out_trade_no:biz.out_trade_no} }
    if (method === 'alipay.trade.fastpay.refund.query') data = refunds.has(biz.out_request_no) ?
      {code:'10000',out_trade_no:biz.out_trade_no,out_request_no:biz.out_request_no,refund_amount:'24.75',refund_status:'REFUND_SUCCESS'} : {code:'40004',sub_code:'ACQ.TRADE_NOT_EXIST'}
    if (method === 'alipay.trade.refund') { refunds.add(biz.out_request_no); data={code:'10000',out_trade_no:biz.out_trade_no,refund_fee:biz.refund_amount,fund_change:'Y'} }
    const raw=JSON.stringify(data),signature=sign('RSA-SHA256',Buffer.from(raw),keys.privateKey).toString('base64')
    return new Response(JSON.stringify({[method.replaceAll('.','_')+'_response']:data,sign:signature}))
  })
  const ctx = await buildTestApp({databasePath:':memory:',uploadsPath:'./unused',publicUrl:'http://127.0.0.1:3000',mockPayments:false,paymentChannel:channel,clock:{now:()=>now},...(logisticsChannel?{logisticsChannel}:{})})
  const account = (name:string, role:'buyer'|'merchant'='buyer') => ctx.testData.account({account:name+randomUUID().slice(0,8),password:'sandbox-test-password',role})
  const buyer=account('buyer'),payer=account('payer'),merchant=account('merchant','merchant')
  ctx.testData.relation({ownerId:buyer.id,friendId:payer.id})
  const address=ctx.testData.address({userId:buyer.id,receiver:'买家',contact,address:'测试地址'})
  const product=ctx.testData.product({name:'沙箱测试商品',category:'测试',skus:[{spec:'标准',priceCents:2475,stock:10}]})
  const call=async(method:string,url:string,token=buyer.token,payload?:object) => {
    const response=await ctx.app.inject({method:method as never,url,headers:token?{authorization:`Bearer ${token}`}:{},payload})
    return {status:response.statusCode,body:response.json()}
  }
  const order = await call('POST','/member/order',buyer.token,{addressId:address.id,requestKey:randomUUID(),expectedAmountCents:2475,goods:[{skuId:product.skus[0]!.id,count:1}]})
  assert.equal(order.status,200)
  const orderId=order.body.result.id as string
  const notify = (paymentId:string, amount='24.75') => {
    const fields={app_id:config.appId,seller_id:config.sellerId,out_trade_no:paymentId,total_amount:amount,trade_no:'sandbox-transaction',trade_status:'TRADE_SUCCESS',gmt_payment:beijingTime(paidAt)}
    return ctx.app.inject({method:'POST',url:'/payments/alipay/notify',headers:{'content-type':'application/x-www-form-urlencoded'},payload:new URLSearchParams({...fields,sign_type:'RSA2',sign:sign('RSA-SHA256',Buffer.from(canonicalParameters(fields)),keys.privateKey).toString('base64')}).toString()})
  }
  return {ctx,call,orderId,buyer,payer,merchant,address,notify,refunds,requests,
    advance:(ms:number)=>{now+=ms},paid:()=>{state='TRADE_SUCCESS';paidAt=now},setOffline:(value:boolean)=>{offline=value}}
}

test('G 续开仅当前付款人可用，服务端金额、同一支付单与截止时间不变',async()=>{
  const f=await fixture()
  try {
    assert.equal((await f.call('POST',`/member/order/${f.orderId}/payments`,f.buyer.token,{amountCents:1})).status,409)
    await f.call('PUT',`/member/order/${f.orderId}/payer`,f.buyer.token,{friendId:f.payer.id})
    const start=await f.call('POST',`/member/order/${f.orderId}/payments`,f.payer.token,{amountCents:2475})
    assert.equal(start.status,200); assert.equal(start.body.result.sandbox,true)
    const path=`/member/order/${f.orderId}/payments/checkout`
    for(const token of [f.buyer.token,f.merchant.token,'']) assert.ok([401,403].includes((await f.call('POST',path,token)).status))
    const reopened=await f.call('POST',path,f.payer.token)
    assert.equal(reopened.status,200); assert.equal(reopened.body.result.paymentId,start.body.result.paymentId)
    const biz=JSON.parse(new URL(reopened.body.result.checkoutUrl).searchParams.get('biz_content')!)
    assert.equal(biz.total_amount,'24.75')
    assert.equal(f.ctx.db.one<{count:number}>('SELECT COUNT(*) count FROM payments')!.count,1)
    const detail=(await f.call('GET',`/member/order/${f.orderId}`,f.payer.token)).body.result
    assert.equal(detail.paymentMode,'family'); assert.equal(detail.paymentChannel,'alipay-sandbox'); assert.equal(detail.canResumePayment,true)
    assert.equal(detail.serverManaged,true); assert.equal(detail.payMoney,24.75)
    f.advance(600001)
    assert.equal((await f.call('POST',path,f.payer.token)).status,409)
  } finally {await f.ctx.app.close()}
})

test('G 验签通知仍以查单确认，重复通知不重复推进，伪造金额和模拟回调被拒',async()=>{
  const f=await fixture()
  try {
    const started=await f.call('POST',`/member/order/${f.orderId}/payments`,f.buyer.token,{amountCents:2475}),id=started.body.result.paymentId
    assert.equal((await f.notify(id,'0.01')).statusCode,400)
    assert.equal((await f.call('POST','/payments/callback','',{paymentId:id})).status,404)
    f.setOffline(true)
    assert.equal((await f.notify(id)).body,'success')
    assert.equal(f.ctx.db.one<{state:number}>('SELECT state FROM orders WHERE id=?',f.orderId)!.state,1)
    f.setOffline(false);f.paid()
    assert.equal((await f.notify(id)).body,'success');assert.equal((await f.notify(id)).body,'success')
    assert.equal(f.ctx.db.one<{state:number}>('SELECT state FROM orders WHERE id=?',f.orderId)!.state,2)
    assert.equal(f.refunds.size,0)
    assert.equal((await f.call('POST',`/member/order/${f.orderId}/payments/checkout`)).status,409)
  } finally {await f.ctx.app.close()}
})

test('G 迟到成功自动原路退款，退款请求号稳定且重复通知不重复退款',async()=>{
  const f=await fixture()
  try {
    const started=await f.call('POST',`/member/order/${f.orderId}/payments`,f.buyer.token,{amountCents:2475}),id=started.body.result.paymentId
    f.advance(601000);f.paid()
    assert.equal((await f.notify(id)).body,'success');assert.equal((await f.notify(id)).body,'success')
    assert.equal(f.ctx.db.one<{state:number}>('SELECT state FROM orders WHERE id=?',f.orderId)!.state,6)
    const refund=f.ctx.db.one<{state:string;reason:string;amount:number;payment_id:string}>('SELECT * FROM refunds')!
    assert.equal(refund.state,'succeeded');assert.equal(refund.reason,'late');assert.equal(refund.amount,2475);assert.equal(refund.payment_id,id)
    assert.equal(f.refunds.size,1);assert.equal(f.requests.filter(x=>x==='alipay.trade.refund').length,1)
  } finally {await f.ctx.app.close()}
})

test('G 快递渠道使用订单地址快照中的数字电话尾号核验，去重且签收不替代收货',async()=>{
  const requests: Record<string,unknown>[]=[]
  const channel=new KdniaoChannel({businessId:'local-business',appKey:'local-key'},async(_url,init)=>{
    const fields=new URLSearchParams(String(init?.body))
    assert.equal(fields.get('RequestType'),'8002')
    requests.push(JSON.parse(fields.get('RequestData')!))
    return new Response(JSON.stringify({EBusinessID:'local-business',ShipperCode:'YTO',LogisticCode:'YT12345678',Success:true,State:'3',Traces:[
      {AcceptTime:'2026-11-14 08:02:00',AcceptStation:'已签收'},
      {AcceptTime:'2026-11-14 08:01:00',AcceptStation:'运输中'},
      {AcceptTime:'2026-11-14 08:01:00',AcceptStation:'运输中'}]}))
  })
  const expectedTail='0427'
  for (const length of [8,4,11,20]) {
    requests.length=0
    const contact='1'.repeat(length-4)+expectedTail
    const f=await fixture(channel,contact.padStart(6,'1'))
    try {
      if (length<6) f.ctx.db.run("UPDATE orders SET address=json_set(address,'$.contact',?) WHERE id=?",contact,f.orderId)
      assert.equal((await f.call('PUT','/member/address/'+f.address.id,f.buyer.token,
        {receiver:'买家',contact:'2'.repeat(8),address:'新地址',isDefault:0})).status,200)
      const path='/member/order/'+f.orderId
      const started=await f.call('POST',path+'/payments',f.buyer.token,{amountCents:2475})
      f.paid();await f.notify(started.body.result.paymentId)
      assert.equal((await f.call('POST','/merchant/orders/'+f.orderId+'/ship',f.merchant.token,{carrier:'圆通',trackingNo:'YT12345678'})).status,200)
      f.advance(180000)
      assert.equal((await f.call('GET',path+'/logistics',f.payer.token)).status,403);assert.equal(requests.length,0)
      const first=await f.call('GET',path+'/logistics'),second=await f.call('GET',path+'/logistics')
      assert.equal(first.status,200,'纯数字联系电话的物流查询应成功')
      assert.equal(requests.length,1)
      assert.ok(requests[0]?.CustomerName===expectedTail,'快递鸟请求未携带订单地址快照的电话后四位')
      assert.deepEqual(Object.keys(requests[0]!).sort(),['CustomerName','LogisticCode','ShipperCode'])
      assert.deepEqual(first.body.result,second.body.result)
      assert.equal(first.body.result.source,'carrier');assert.equal(first.body.result.state,'signed');assert.equal(first.body.result.events.length,2)
      assert.equal('CustomerName' in first.body.result,false)
      const detail=(await f.call('GET',path)).body.result
      assert.equal(detail.orderState,3);assert.equal(detail.signedAt,Date.parse('2026-11-14T08:02:00+08:00'));assert.equal(detail.receivedAt,null)
    } finally {await f.ctx.app.close()}
  }
})

test('G 地址快照电话缺失、非纯数字或不足四位时，明确拒绝且不调用快递鸟',async()=>{
  let calls=0
  const channel=new KdniaoChannel({businessId:'local-business',appKey:'local-key'},async()=>{
    calls++
    return new Response(null,{status:503})
  })
  for (const patch of [{},{contact:'12-34'},{contact:'123'},{contact:123456}]) {
    const f=await fixture(channel)
    try {
      f.ctx.db.run("UPDATE orders SET address=? WHERE id=?",JSON.stringify(patch),f.orderId)
      const started=await f.call('POST',`/member/order/${f.orderId}/payments`,f.buyer.token,{amountCents:2475})
      f.paid();await f.notify(started.body.result.paymentId)
      assert.equal((await f.call('POST',`/merchant/orders/${f.orderId}/ship`,f.merchant.token,{carrier:'顺丰',trackingNo:'SF12345678'})).status,200)
      const response=await f.call('GET',`/member/order/${f.orderId}/logistics`)
      assert.equal(calls,0)
      assert.equal(response.status,400)
      assert.equal(response.body.reason,'LOGISTICS_PHONE_TAIL_UNAVAILABLE')
      assert.match(response.body.msg,/收货电话.*至少4位.*无法核验运单/)
      assert.doesNotMatch(response.body.msg,/重试/)
    } finally {await f.ctx.app.close()}
  }
})
