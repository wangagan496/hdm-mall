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

async function fixture(logisticsChannel?: LogisticsChannel) {
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
  const address=ctx.testData.address({userId:buyer.id,receiver:'买家',contact:'13800000000',address:'测试地址'})
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
  return {ctx,call,orderId,buyer,payer,merchant,notify,refunds,requests,
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

test('G 快递渠道经订单权限读取，重复乱序轨迹不倒退，签收不替代买家确认',async()=>{
  let calls=0
  const channel=new KdniaoChannel({businessId:'local-business',appKey:'local-key'},async()=>{
    calls++
    return new Response(JSON.stringify({EBusinessID:'local-business',ShipperCode:'YTO',LogisticCode:'YT12345678',Success:true,State:'3',Traces:[
      {AcceptTime:'2026-11-14 08:02:00',AcceptStation:'已签收'},
      {AcceptTime:'2026-11-14 08:01:00',AcceptStation:'运输中'},
      {AcceptTime:'2026-11-14 08:01:00',AcceptStation:'运输中'}]}))
  })
  const f=await fixture(channel)
  try {
    const started=await f.call('POST',`/member/order/${f.orderId}/payments`,f.buyer.token,{amountCents:2475})
    f.paid();await f.notify(started.body.result.paymentId)
    assert.equal((await f.call('POST',`/merchant/orders/${f.orderId}/ship`,f.merchant.token,{carrier:'圆通',trackingNo:'YT12345678'})).status,200)
    f.advance(180000)
    const path=`/member/order/${f.orderId}/logistics`
    assert.equal((await f.call('GET',path,f.payer.token)).status,403);assert.equal(calls,0)
    const first=await f.call('GET',path),second=await f.call('GET',path)
    assert.equal(first.status,200);assert.deepEqual(first.body.result,second.body.result)
    assert.equal(first.body.result.source,'carrier');assert.equal(first.body.result.state,'signed');assert.equal(first.body.result.events.length,2)
    assert.equal(calls,1)
    const detail=(await f.call('GET',`/member/order/${f.orderId}`)).body.result
    assert.equal(detail.orderState,3);assert.equal(detail.signedAt,Date.parse('2026-11-14T08:02:00+08:00'));assert.equal(detail.receivedAt,null)
  } finally {await f.ctx.app.close()}
})
