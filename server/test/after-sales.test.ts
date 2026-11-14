import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildTestApp } from './helpers/fixtures.ts'
import { withReturnShipping } from './helpers/return-shipping.ts'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackup, verifyBackup } from '../src/backup.ts'
import { buildApp } from '../src/app.ts'
import { DatabaseSync } from 'node:sqlite'
import { removeAfterSaleSchema } from './helpers/legacy-v11.ts'
import { Database } from '../src/database.ts'
import { MockPaymentChannel } from '../src/payment-channel.ts'

const DAY = 86400000
const address = { receiver: '售后收件人', contact: '13800000000', address: '测试退货地址一号' }
test('AS-R2 启动时渠道异常不阻断服务，取消及售后退款保留原号重试',async()=>{
 const root=await mkdtemp(join(tmpdir(),'after-sale-startup-')),databasePath=join(root,'mall.sqlite'),uploadsPath=join(root,'uploads')
 const f=await fixture(databasePath,uploadsPath)
 let restored:Awaited<ReturnType<typeof buildApp>>|undefined
 try {
  const sale=await f.requested(await f.create(),'refund-missing')
  const order=await f.create();f.ctx.db.run('UPDATE orders SET state=2,shipped_at=NULL WHERE id=?',order)
  assert.equal((await f.call('POST',`/member/order/${order}/cancel-requests`,{requestKey:randomUUID()})).status,200)
  let now=f.now()+3*DAY;await f.ctx.app.close()
  const channel=new MockPaymentChannel('development-payment-callback-secret-32-bytes')
  let unavailable=true
  channel.refund=()=>{if(unavailable)throw new Error('temporary channel outage');return 'success'}
  restored=await buildApp({databasePath,uploadsPath,publicUrl:'http://localhost',mockPayments:true,paymentChannel:channel,clock:{now:()=>now}})
  assert.equal((await restored.app.inject({method:'POST',url:'/login',payload:{account:'seller',password:'test-password-123'}})).statusCode,200)
  const ids=restored.db.all<{id:string}>('SELECT id FROM refunds ORDER BY id').map(r=>r.id)
  assert.equal(ids.length,2)
  assert.equal(restored.db.one<{state:string}>('SELECT state FROM after_sales WHERE id=?',sale)!.state,'refunding')
  assert.equal(restored.db.one<{state:number}>('SELECT state FROM orders WHERE id=?',order)!.state,6)
  unavailable=false;now+=60000;await restored.payments.reconcile()
  assert.deepEqual(restored.db.all<{id:string}>('SELECT id FROM refunds ORDER BY id').map(r=>r.id),ids)
  assert.equal(restored.db.one<{n:number}>("SELECT COUNT(*) n FROM refunds WHERE state='succeeded'")!.n,2)
  assert.equal(restored.db.one<{state:string}>('SELECT state FROM after_sales WHERE id=?',sale)!.state,'refunded')
 } finally {
  if(restored)await restored.app.close()
  await f.ctx.app.close()
  await rm(root,{recursive:true,force:true}).catch(error=>{if(restored)throw error;console.error('Startup fixture cleanup deferred until process exit:',root)})
 }
})
test('AS-R1 同意后撤回的备份仍有效',async()=>{
 const root=await mkdtemp(join(tmpdir(),'withdraw-approved-')),path=join(root,'data','mall.sqlite'),uploads=join(root,'uploads')
 const f=await fixture(path,uploads)
 try {
  const id=await f.requested(await f.create());await f.action(id,'approve',{returnAddress:address});await f.action(id,'withdraw')
  const backup=await createBackup({databasePath:path,uploadsPath:uploads,destination:join(root,'backup')})
  assert.deepEqual(backup.manifest.issues,[])
 }finally{await f.ctx.app.close();await rm(root,{recursive:true,force:true})}
})
test('AS-R1 同意后撤回恢复全部数量，寄回后禁止撤回', async () => {
 const f=await fixture()
 try {
  const order=await f.create(),id=await f.requested(order)
  assert.equal((await f.action(id,'approve',{returnAddress:address})).status,200)
  assert.equal((await f.action(id,'withdraw')).status,200)
  const detail=(await f.call('GET',`/member/order/${order}`)).body.result
  assert.equal(detail.skus[0].afterSaleRemaining,3);assert.equal(detail.canApplyAfterSale,true)
  const next=await f.requested(order,'return-no-reason',3)
  await f.action(next,'approve');await f.action(next,'ship-back',{carrier:'SF',trackingNo:'SF12345678'})
  assert.equal((await f.action(next,'withdraw')).status,409)
  assert.equal(f.ctx.db.one<{state:string}>('SELECT state FROM after_sales WHERE id=?',next)!.state,'returned')
 } finally {await f.ctx.app.close()}
})
test('AS-R2 验收及少件同意返回前立即退款，失败保留重试且重放不提前重试',async()=>{
 const f=await fixture()
 try {
  const order=await f.create(),id=await f.requested(order)
  await f.action(id,'approve',{returnAddress:address});await f.action(id,'ship-back',{carrier:'SF',trackingNo:'SF12345678'})
  assert.equal((await f.action(id,'inspect',{items:[{skuId:f.sku.id,restockCount:1}]})).status,200)
  assert.equal(f.ctx.db.one<{state:string}>('SELECT state FROM refunds')!.state,'succeeded')
  const missing=await f.requested(order,'refund-missing',1),key=randomUUID()
  f.ctx.testData.payments({paymentId:f.ctx.payments.effectivePaymentId(order)!,preset:{outcome:'success',refundFailures:1}})
  await f.action(missing,'approve',{},key)
  const refund=f.ctx.db.one<{state:string;attempts:number;next_attempt_at:number}>('SELECT * FROM refunds WHERE after_sale_id=?',missing)!
  assert.equal(refund.state,'failed');assert.equal(refund.attempts,1);assert.ok(refund.next_attempt_at>f.now())
  await f.action(missing,'approve',{},key)
  assert.equal(f.ctx.db.one<{attempts:number}>('SELECT attempts FROM refunds WHERE after_sale_id=?',missing)!.attempts,1)
  f.advance(60000);await f.ctx.payments.reconcile()
  assert.equal(f.ctx.db.one<{state:string}>('SELECT state FROM refunds WHERE after_sale_id=?',missing)!.state,'succeeded')
 } finally {await f.ctx.app.close()}
})
test('AS-R5 退款渠道无响应时限时返回并保留后台重试',async t=>{
 const f=await fixture()
 try {
  const realSetTimeout=globalThis.setTimeout.bind(globalThis)
  t.mock.timers.enable({apis:['setTimeout']})
  const order=await f.create(),id=await f.requested(order,'refund-missing')
  let called=false
  f.ctx.payments.channel!.refund=()=>{called=true;return new Promise(()=>{})}
  const action=f.action(id,'approve')
  for(let i=0;i<20&&!called;i++) await new Promise<void>(resolve=>setImmediate(resolve))
  assert.ok(called,'测试前置未调用退款渠道')
  t.mock.timers.tick(15_000)
  await new Promise<void>(resolve=>setImmediate(resolve))
  const result=await Promise.race([
   action,
   new Promise<null>(resolve=>realSetTimeout(()=>resolve(null),1_000)),
  ])
  assert.ok(result,'退款渠道无响应时商家操作仍被挂住')
  assert.equal(result.status,200)
  assert.equal(f.ctx.db.one<{state:string}>('SELECT state FROM after_sales WHERE id=?',id)!.state,'refunding')
  assert.equal(f.ctx.db.one<{state:string;next_attempt_at:number|null}>('SELECT * FROM refunds WHERE after_sale_id=?',id)!.state,'pending')
  assert.ok(f.ctx.db.one<{next_attempt_at:number}>('SELECT next_attempt_at FROM refunds WHERE after_sale_id=?',id)!.next_attempt_at>f.now())
 }finally{await f.ctx.app.close()}
})
test('AS-R2 自动同意及十天退款扫描立即执行，取消同意也立即执行',async()=>{
 const f=await fixture()
 try {
  const order=await f.create(),id=await f.requested(order)
  await f.action(id,'approve',{returnAddress:address});await f.action(id,'ship-back',{carrier:'SF',trackingNo:'SF12345678'})
  f.advance(10*DAY);await f.ctx.afterSales.processDue()
  assert.equal(f.ctx.db.one<{state:string}>('SELECT state FROM after_sales WHERE id=?',id)!.state,'refunded')
  const missing=await f.requested(await f.create(),'refund-missing')
  f.advance(2*DAY);await f.ctx.afterSales.processDue()
  assert.equal(f.ctx.db.one<{state:string}>('SELECT state FROM after_sales WHERE id=?',missing)!.state,'refunded')
  for(const auto of [false,true]) {
   const cancelOrder=await f.create();f.ctx.db.run('UPDATE orders SET state=2,shipped_at=NULL WHERE id=?',cancelOrder)
   const request=(await f.call('POST',`/member/order/${cancelOrder}/cancel-requests`,{requestKey:randomUUID()})).body.result
   if(auto){f.advance(3*DAY);await f.ctx.orders.processDueCancelRequests()}
   else assert.equal((await f.call('POST',`/merchant/orders/${cancelOrder}/cancel-requests/${request.cancelRequestId}/resolve`,{requestKey:randomUUID(),decision:'approve'},f.merchant.token)).status,200)
   assert.equal(f.ctx.db.one<{state:string}>('SELECT r.state FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.order_id=?',cancelOrder)!.state,'succeeded')
  }
 } finally {await f.ctx.app.close()}
})
test('AS-R4 商家列表提供买家账号与筛选数量，不提供订单收货地址',async()=>{
 const f=await fixture()
 try {
  await f.requested(await f.create())
  const page=(await f.call('GET','/merchant/after-sales?state=pending&page=1',undefined,f.merchant.token)).body.result
  assert.equal(page.items[0].buyerAccount,'buyer');assert.equal(page.items[0].orderAddress,undefined)
  assert.deepEqual(page.stateCounts,{pending:1,returned:0,all:1})
 }finally{await f.ctx.app.close()}
})
test('AS-R5 超时后渠道迟到成功与原号重试只退款一次',async t=>{
 const f=await fixture();let lateSuccess:(()=>void)|undefined
 try {
  const realSetTimeout=globalThis.setTimeout.bind(globalThis)
  t.mock.timers.enable({apis:['setTimeout']})
  const order=await f.create(),id=await f.requested(order,'refund-missing'),ids:string[]=[]
  const channelRefund=f.ctx.payments.channel!.refund.bind(f.ctx.payments.channel!)
  let calls=0
  f.ctx.payments.channel!.refund=(refundId,paymentId,amount)=>{
   calls++;ids.push(refundId)
   if(calls===1)return new Promise(resolve=>{lateSuccess=()=>{resolve(channelRefund(refundId,paymentId,amount))}})
   return channelRefund(refundId,paymentId,amount)
  }
  const action=f.action(id,'approve')
  await waitFor(()=>calls===1)
  t.mock.timers.tick(15_000);await new Promise<void>(resolve=>setImmediate(resolve))
  const result=await Promise.race([action,new Promise<null>(resolve=>realSetTimeout(()=>resolve(null),1_000))])
  assert.ok(result,'渠道无响应时接口未及时返回')
  assert.equal(result.status,200)
  f.advance(60_000);lateSuccess?.()
  await f.ctx.payments.reconcile()
  assert.equal(calls,2);assert.deepEqual(ids,[ids[0],ids[0]])
  const payment=f.ctx.db.one<{id:string;amount:number}>('SELECT id,amount FROM payments WHERE order_id=?',order)!
  const refunded=f.ctx.db.one<{amount:number}>('SELECT amount FROM refunds WHERE after_sale_id=?',id)!.amount
  assert.equal(await channelRefund(randomUUID(),payment.id,payment.amount-refunded),'success')
  assert.equal(await channelRefund(randomUUID(),payment.id,1),'fail')
  assert.equal(f.ctx.db.one<{state:string}>('SELECT state FROM refunds WHERE after_sale_id=?',id)!.state,'succeeded')
 }finally{await f.ctx.app.close()}
})
test('AS-R5 连续退款超时满24小时转人工并停止扫描重试',async t=>{
 const f=await fixture()
 try {
  const realSetTimeout=globalThis.setTimeout.bind(globalThis)
  t.mock.timers.enable({apis:['setTimeout']})
  const order=await f.create(),id=await f.requested(order,'refund-missing')
  let called=false
  f.ctx.payments.channel!.refund=()=>{called=true;return new Promise(()=>{})}
  const action=f.action(id,'approve')
  await waitFor(()=>called)
  t.mock.timers.tick(15_000);await new Promise<void>(resolve=>setImmediate(resolve))
  const result=await Promise.race([action,new Promise<null>(resolve=>realSetTimeout(()=>resolve(null),1_000))])
  assert.ok(result);assert.equal(result.status,200)
  for(const delay of [60_000,300_000,1_800_000,3_600_000]){
   const row=f.ctx.db.one<{next_attempt_at:number;attempts:number}>('SELECT next_attempt_at,attempts FROM refunds WHERE after_sale_id=?',id)!
   assert.equal(row.next_attempt_at-f.now(),delay)
   f.advance(delay-1);called=false;await f.ctx.payments.reconcile();assert.equal(called,false)
   f.advance(1);const retry=f.ctx.payments.reconcile();await waitFor(()=>called)
   t.mock.timers.tick(15_000);await retry
   assert.equal(f.ctx.db.one<{attempts:number}>('SELECT attempts FROM refunds WHERE after_sale_id=?',id)!.attempts,row.attempts+1)
  }
  const before=f.ctx.db.one<{attempts:number}>('SELECT attempts FROM refunds WHERE after_sale_id=?',id)!.attempts
  f.advance(DAY+1);await f.ctx.payments.reconcile()
  const refund=f.ctx.db.one<{state:string;attempts:number;review_at:number|null;next_attempt_at:number|null}>('SELECT * FROM refunds WHERE after_sale_id=?',id)!
  assert.equal(refund.state,'pending');assert.equal(refund.attempts,before);assert.ok(refund.review_at!==null);assert.equal(refund.next_attempt_at,null)
 }finally{await f.ctx.app.close()}
})
test('AS-R5 商家验收退款超时后订单仍显示退款中',async t=>{
 const f=await fixture()
 try {
  const realSetTimeout=globalThis.setTimeout.bind(globalThis)
  t.mock.timers.enable({apis:['setTimeout']})
  const order=await f.create(),id=await f.requested(order)
  assert.equal((await f.action(id,'approve',{returnAddress:address})).status,200)
  assert.equal((await f.action(id,'ship-back',{carrier:'SF',trackingNo:'SF12345678'})).status,200)
  let called=false
  f.ctx.payments.channel!.refund=()=>{called=true;return new Promise(()=>{})}
  const action=f.action(id,'inspect',{items:[{skuId:f.sku.id,restockCount:1}]})
  await waitFor(()=>called)
  t.mock.timers.tick(15_000);await new Promise<void>(resolve=>setImmediate(resolve))
  const result=await Promise.race([action,new Promise<null>(resolve=>realSetTimeout(()=>resolve(null),1_000))])
  assert.ok(result,'验收接口因退款渠道无响应而挂起');assert.equal(result.status,200)
  const detail=(await f.call('GET',`/member/order/${order}`)).body.result
  assert.equal(detail.afterSales[0].state,'refunding');assert.equal(detail.afterSales[0].refundState,'pending')
 }finally{await f.ctx.app.close()}
})
async function waitFor(predicate:()=>boolean):Promise<void>{for(let i=0;i<100&&!predicate();i++)await new Promise<void>(resolve=>setImmediate(resolve));assert.ok(predicate(),'异步请求没有进入预期状态')}
async function fixture(databasePath = ':memory:', uploadsPath = './unused') {
  let now = Date.UTC(2026, 10, 9, 5)
  const ctx = await buildTestApp({ databasePath, uploadsPath, publicUrl: 'http://localhost', mockPayments: true, clock: { now: () => now } })
  const buyer = ctx.testData.account({ account: 'buyer', password: 'test-password-123' })
  const merchant = ctx.testData.account({ account: 'seller', password: 'test-password-123', role: 'merchant' })
  const other = ctx.testData.account({ account: 'other', password: 'test-password-123' })
  const delivery = ctx.testData.address({ userId: buyer.id, ...address })
  const product = ctx.testData.product({ name: '售后测试', category: '售后测试', skus: [{ spec: '标准', priceCents: 2475, stock: 100 }] })
  const sku = product.skus[0]!
  const call = async (method: string, url: string, payload?: object, token = buyer.token) => {
    payload = withReturnShipping(ctx, uploadsPath, url, payload, token)
    const res = await ctx.app.inject({ method: method as never, url, headers: { authorization: 'Bearer ' + token }, payload })
    return { status: res.statusCode, body: res.json() }
  }
  const create = async (family = false) => {
    const res = await call('POST', '/member/order', { addressId: delivery.id, requestKey: randomUUID(), expectedAmountCents: 7425, goods: [{ skuId: sku.id, count: 3 }] })
    assert.equal(res.status, 200)
    const id = res.body.result.id as string
    if (family) {
      ctx.testData.relation({ownerId:buyer.id,friendId:other.id})
      assert.equal((await call('PUT',`/member/order/${id}/payer`,{friendId:other.id})).status,200)
    }
    assert.equal((await call('POST', `/member/order/${id}/mock-pay`, { amountCents: 7425 }, family ? other.token : buyer.token)).status, 200)
    assert.equal((await call('POST', `/merchant/orders/${id}/ship`, {carrier:'顺丰',trackingNo:'SF12345678'}, merchant.token)).status, 200)
    return id
  }
  const apply = (id: string, kind = 'return-no-reason', count = 2, requestKey = randomUUID(), token = buyer.token) => call('POST', `/member/order/${id}/after-sales`, { requestKey, kind, description: kind === 'return-no-reason' ? '' : '商品存在问题需要处理', items: [{ skuId: sku.id, count }], imageIds: [] }, token)
  const action = (id: string, act: string, extra: object = {}, requestKey = randomUUID()) => call('POST', `/${['withdraw', 'ship-back'].includes(act) ? 'member' : 'merchant'}/after-sales/${id}/${act}`, { requestKey, ...extra }, ['withdraw', 'ship-back'].includes(act) ? buyer.token : merchant.token)
  const requested = async (orderId: string, kind = 'return-no-reason', count = 2) => { const r = await apply(orderId, kind, count); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.result.afterSaleId as string }
  const advance = (ms: number) => { now += ms; ctx.db.run('UPDATE sessions SET expires=?', now + DAY) }
  const stock = () => ctx.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', sku.id)!.stock
  return { ctx, buyer, merchant, other, sku, call, create, apply, action, requested, advance, stock, now: () => now }
}

test('AS-10 亲友代付退回原付款人、售后隐私隔离、失败重试与转人工', async () => {
  const f=await fixture()
  try {
    const order=await f.create(true), id=await f.requested(order,'refund-missing',1)
    const payment=f.ctx.payments.effectivePaymentId(order)!
    f.ctx.testData.payments({paymentId:payment,preset:{outcome:'success',refundFailures:100}})
    assert.equal((await f.action(id,'approve')).status,200)
    await f.ctx.payments.reconcile()
    assert.equal(f.ctx.db.one<{state:string}>('SELECT state FROM refunds')!.state,'failed')
    f.advance(DAY+1); await f.ctx.payments.reconcile()
    assert.ok(f.ctx.db.one<{review_at:number}>('SELECT review_at FROM refunds')!.review_at)
    const detail=(await f.call('GET',`/member/order/${order}`,undefined,f.other.token)).body.result
    assert.equal(detail.address,undefined); assert.equal(detail.afterSales[0].returnAddress,undefined); assert.equal(detail.afterSales[0].images,undefined)
    assert.equal(detail.refunds[0].payerAccount,'other'); assert.equal(detail.canApplyAfterSale,false)
    assert.equal((await f.apply(order,'refund-missing',1,randomUUID(),f.other.token)).status,403)
    assert.equal((await f.call('POST',`/member/after-sales/${id}/withdraw`,{requestKey:randomUUID()},f.other.token)).status,403)
    assert.equal((await f.call('POST',`/member/after-sales/${id}/ship-back`,{requestKey:randomUUID(),carrier:'顺丰',trackingNo:'SF1234567'},f.other.token)).status,403)
    const refund=f.ctx.db.one<{id:string}>('SELECT id FROM refunds')!
    f.ctx.testData.payments({paymentId:payment,preset:{outcome:'success',refundFailures:0}})
    assert.equal((await f.call('POST',`/merchant/refunds/${refund.id}/retry`,{requestKey:randomUUID()},f.merchant.token)).status,200)
    assert.equal(f.ctx.db.one<{state:string}>('SELECT state FROM after_sales WHERE id=?',id)!.state,'refunded')
    assert.equal(f.ctx.payments.effectivePaymentId(order),payment)
  } finally {await f.ctx.app.close()}
})

test('AS-11 v11迁移v12保留退款通知和库存流水、重开不重复', async () => {
  const root=await mkdtemp(join(tmpdir(),'after-sale-v11-')), path=join(root,'data','mall.sqlite')
  const f=await fixture(path,join(root,'uploads'))
  let closed=false
  try {
    const order=await f.create()
    const payments=f.ctx.db.all<Record<string,unknown>>('SELECT * FROM payments ORDER BY id').map(row=>Object.assign(Object.create(null),row,{channel_transaction_id:null})), movements=f.ctx.db.all('SELECT * FROM inventory_movements ORDER BY id')
    await f.ctx.app.close(); closed=true
    const raw=new DatabaseSync(path); removeAfterSaleSchema(raw); raw.close()
    for(let i=0;i<2;i++) {
      const db=new Database(path)
      try {assert.equal(db.one<{user_version:number}>('PRAGMA user_version')!.user_version, 18); assert.deepEqual(db.all('SELECT * FROM payments ORDER BY id'),payments);assert.deepEqual(db.all('SELECT * FROM inventory_movements ORDER BY id'),movements);assert.deepEqual(db.all('PRAGMA foreign_key_check'),[]);assert.equal(db.one<{state:number}>('SELECT state FROM orders WHERE id=?',order)!.state,3)} finally {db.close()}
    }
  } finally {if(!closed)await f.ctx.app.close();await rm(root,{recursive:true,force:true})}
})

test('AS-12 七日无理由次日起算与15天毫秒边界、重复取消退款仍唯一', async () => {
  const f=await fixture()
  try {
    const order=await f.create();await f.call('PUT',`/member/order/${order}/receipt`,{})
    const detail=(await f.call('GET',`/member/order/${order}`)).body.result
    assert.equal(detail.noReasonDeadline,Date.UTC(2026,10,16,16))
    f.advance(detail.noReasonDeadline-f.now()-1)
    const id=await f.requested(order);await f.action(id,'withdraw')
    f.advance(1);assert.equal((await f.apply(order)).status,409)
    assert.equal((await f.apply(order,'return-quality')).status,200)
    const p=f.ctx.payments.effectivePaymentId(order)!
    f.ctx.db.run("INSERT INTO refunds(id,payment_id,amount,reason,state,created) VALUES('old',?,1,'cancelled','pending',?)",p,f.now())
    assert.throws(()=>f.ctx.db.run("INSERT INTO refunds(id,payment_id,amount,reason,state,created) VALUES('repeat',?,1,'late','pending',?)",p,f.now()),/UNIQUE/)
  } finally {await f.ctx.app.close()}
})

test('AS-08 售后照片本人上传、限3张、同号同内容、读取隔离及备份校验', async () => {
  const root = await mkdtemp(join(tmpdir(),'after-sale-images-'))
  const f = await fixture(join(root,'data','mall.sqlite'),join(root,'uploads'))
  try {
    const order = await f.create(), applicationKey = randomUUID()
    const user = f.ctx.accounts.authenticate('Bearer ' + f.buyer.token)
    const other = f.ctx.accounts.authenticate('Bearer ' + f.other.token)
    const bytes = Buffer.from([255,216,255,217])
    assert.throws(() => f.ctx.afterSales.uploadImage(other,order,applicationKey,randomUUID(),bytes,join(root,'uploads')), /下单人/)
    assert.throws(() => f.ctx.afterSales.uploadImage(user,order,applicationKey,randomUUID(),Buffer.from('bad'),join(root,'uploads')), /JPEG/)
    assert.throws(() => f.ctx.afterSales.uploadImage(user,order,applicationKey,randomUUID(),Buffer.alloc(524289),join(root,'uploads')), /过大/)
    const key = randomUUID(), img = f.ctx.afterSales.uploadImage(user,order,applicationKey,key,bytes,join(root,'uploads'))
    assert.deepEqual(f.ctx.afterSales.uploadImage(user,order,applicationKey,key,bytes,join(root,'uploads')),img)
    assert.throws(() => f.ctx.afterSales.uploadImage(user,order,applicationKey,key,Buffer.from([255,216,255,0]),join(root,'uploads')), /更换/)
    for(let i=0;i<2;i++) f.ctx.afterSales.uploadImage(user,order,applicationKey,randomUUID(),bytes,join(root,'uploads'))
    assert.throws(() => f.ctx.afterSales.uploadImage(user,order,applicationKey,randomUUID(),bytes,join(root,'uploads')), /3张/)
    assert.equal((await f.ctx.app.inject({method:'GET',url:img.path})).statusCode,401)
    assert.equal((await f.ctx.app.inject({method:'GET',url:img.path,headers:{authorization:'Bearer '+f.other.token}})).statusCode,403)
    assert.equal((await f.ctx.app.inject({method:'GET',url:img.path,headers:{authorization:'Bearer '+f.buyer.token}})).statusCode,200)
    assert.equal((await f.call('POST',`/member/order/${order}/after-sales`,{requestKey:applicationKey,kind:'return-quality',description:'质量问题照片说明',items:[{skuId:f.sku.id,count:1}],imageIds:[img.imageId]})).status,200)
    assert.equal((await f.ctx.app.inject({method:'GET',url:img.path,headers:{authorization:'Bearer '+f.merchant.token}})).statusCode,200)
    const backup = await createBackup({databasePath:join(root,'data','mall.sqlite'),uploadsPath:join(root,'uploads'),destination:join(root,'backup')})
    assert.equal(backup.manifest.schemaVersion, 18)
    assert.deepEqual(backup.manifest.issues,[])
    await verifyBackup(join(root,'backup'))
    await writeFile(join(root,'uploads',img.imageId+'.jpg'),Buffer.from([255,216,255,0]))
    const bad = await createBackup({databasePath:join(root,'data','mall.sqlite'),uploadsPath:join(root,'uploads'),destination:join(root,'bad')})
    assert.ok(bad.manifest.issues.some(i=>i.type==='after-sale-image-hash-mismatch'))
  } finally {await f.ctx.app.close(); await rm(root,{recursive:true,force:true})}
})

test('AS-09 重启启动扫描继续处理超时申请和旧数据备份', async () => {
  const root=await mkdtemp(join(tmpdir(),'after-sale-restart-')), path=join(root,'data','mall.sqlite')
  const f=await fixture(path,join(root,'uploads'))
  let closed=false
  try {
    const order=await f.create(), id=await f.requested(order,'refund-missing')
    f.advance(2*DAY)
    await f.ctx.app.close(); closed=true
    const next=await buildApp({databasePath:path,uploadsPath:join(root,'uploads'),publicUrl:'http://localhost',mockPayments:true,clock:{now:f.now}})
    try {
      assert.equal(next.db.one<{state:string}>('SELECT state FROM after_sales WHERE id=?',id)!.state,'refunding')
      // The in-memory mock channel loses its payment on restart, but startup attempts the refund immediately.
      assert.equal(next.db.one<{attempts:number;state:string}>('SELECT attempts,state FROM refunds WHERE after_sale_id=?',id)!.attempts,1)
      assert.equal(next.db.one<{state:string}>('SELECT state FROM refunds WHERE after_sale_id=?',id)!.state,'failed')
      const backup=await createBackup({databasePath:path,uploadsPath:join(root,'uploads'),destination:join(root,'backup')})
      assert.deepEqual(backup.manifest.issues,[])
      next.db.run("UPDATE after_sale_items SET count=3 WHERE after_sale_id=?",id)
      const broken=await createBackup({databasePath:path,uploadsPath:join(root,'uploads'),destination:join(root,'broken')})
      assert.ok(broken.manifest.issues.some(i=>i.type==='after-sale-mismatch'))
    } finally {await next.app.close()}
  } finally {if(!closed) await f.ctx.app.close(); await rm(root,{recursive:true,force:true})}
})

test('AS-01 迁移12、申请原子确认收货、下单价和剩余数量、权限与幂等', async () => {
  const f = await fixture()
  try {
    assert.equal(f.ctx.db.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 18)
    const id = await f.create(), key = randomUUID()
    assert.equal((await f.apply(id, 'return-no-reason', 2, randomUUID(), f.other.token)).status, 403)
    assert.equal((await f.apply(id, 'return-no-reason', 4)).status, 409)
    assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', id)!.state, 3)
    const r = await f.apply(id, 'return-no-reason', 2, key)
    assert.equal(r.status, 200)
    assert.deepEqual((await f.apply(id, 'return-no-reason', 2, key)).body, r.body)
    assert.equal((await f.apply(id, 'return-no-reason', 1, key)).status, 409)
    assert.equal((await f.apply(id)).status, 409)
    const detail = (await f.call('GET', `/member/order/${id}`)).body.result
    assert.equal(detail.orderState, 4); assert.equal(detail.canEvaluate, true)
    assert.equal(detail.afterSales[0].amountCents, 4950)
    assert.equal(detail.canApplyAfterSale, false)
    assert.equal(detail.skus[0].afterSaleRemaining, 1)
    assert.equal(f.stock(), 97)
  } finally { await f.ctx.app.close() }
})

for (const kind of ['return-no-reason', 'return-quality', 'refund-missing']) test(`AS-02 ${kind} 撤回和拒绝后释放数量、同号恢复`, async () => {
  const f = await fixture()
  try {
    const order = await f.create(), id = await f.requested(order, kind)
    const key = randomUUID(), first = await f.action(id, 'withdraw', {}, key)
    assert.equal(first.status, 200)
    assert.deepEqual((await f.action(id, 'withdraw', {}, key)).body, first.body)
    const next = await f.requested(order, kind, 3)
    assert.equal((await f.action(next, 'reject', { reason: '少' })).status, 400)
    assert.equal((await f.action(next, 'reject', { reason: '经核实暂不符合条件' })).status, 200)
    assert.equal((await f.apply(order, kind, 3)).status, 200)
  } finally { await f.ctx.app.close() }
})

test('AS-03 部分退货、逐项验收入库一次、部分退款后有效支付和二次申请', async () => {
  const f = await fixture()
  try {
    const order = await f.create(), id = await f.requested(order)
    assert.equal((await f.action(id, 'approve')).status, 400)
    assert.equal((await f.action(id, 'approve', { returnAddress: address })).status, 200)
    assert.deepEqual((await f.call('GET', '/merchant/settings/return-address', undefined, f.merchant.token)).body.result, address)
    assert.equal((await f.action(id, 'ship-back', { carrier: '顺丰', trackingNo: 'SF12345678' })).status, 200)
    assert.equal((await f.action(id, 'inspect', { items: [{ skuId: f.sku.id, restockCount: 3 }] })).status, 400)
    const key = randomUUID(), payload = { items: [{ skuId: f.sku.id, restockCount: 1 }] }
    const r = await f.action(id, 'inspect', payload, key)
    assert.equal(r.status, 200)
    assert.deepEqual((await f.action(id, 'inspect', payload, key)).body, r.body)
    assert.equal((await f.action(id, 'inspect', { items: [{ skuId: f.sku.id, restockCount: 0 }] }, key)).status, 409)
    assert.equal(f.stock(), 98)
    assert.equal(f.ctx.db.one<{ n: number }>("SELECT COUNT(*) n FROM inventory_movements WHERE kind='return'")!.n, 1)
    assert.throws(() => f.ctx.db.run("UPDATE inventory_movements SET delta=2 WHERE kind='return'"), /append-only/)
    await f.ctx.payments.reconcile()
    const detail = (await f.call('GET', `/member/order/${order}`)).body.result
    assert.equal(detail.paymentState, 'paid'); assert.equal(detail.orderState, 4)
    assert.equal(detail.afterSales[0].state, 'refunded')
    assert.equal(detail.refunds[0].amount, 49.5)
    assert.equal((await f.apply(order, 'refund-missing', 2)).status, 409)
    const last = await f.requested(order, 'refund-missing', 1)
    assert.equal((await f.action(last, 'approve')).status, 200)
    assert.equal(f.ctx.db.one<{ n: number }>("SELECT SUM(amount) n FROM refunds WHERE reason<>'shipping'")!.n, 7425)
    assert.equal(f.ctx.db.one<{ n: number }>("SELECT SUM(amount) n FROM refunds WHERE reason='shipping'")!.n, 1)
    assert.throws(() => f.ctx.db.run("INSERT INTO refunds(id,payment_id,amount,reason,state,created) SELECT 'extra',payment_id,1,'late','pending',0 FROM refunds LIMIT 1"), /refund|Refund/)
  } finally { await f.ctx.app.close() }
})

test('AS-04 无理由验收拒绝退款，质量问题不得走此操作', async () => {
  const f = await fixture()
  try {
    for (const kind of ['return-no-reason', 'return-quality']) {
      const id = await f.requested(await f.create(), kind)
      await f.action(id, 'approve', { returnAddress: address })
      await f.action(id, 'ship-back', { carrier: '顺丰', trackingNo: 'SF12345678' })
      assert.equal((await f.action(id, 'refund-reject', { reason: '商品污损不满足完好条件' })).status, kind === 'return-no-reason' ? 200 : 409)
    }
  } finally { await f.ctx.app.close() }
})

test('AS-05 48小时有地址自动同意、7天未寄回关闭、10天自动退款不入库', async () => {
  const f = await fixture()
  try {
    await f.call('PUT', '/merchant/settings/return-address', address, f.merchant.token)
    const id = await f.requested(await f.create())
    f.advance(2 * DAY)
    await f.ctx.afterSales.processDue()
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM after_sales WHERE id=?', id)!.state, 'awaiting-return')
    f.advance(7 * DAY); await f.ctx.afterSales.processDue()
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM after_sales WHERE id=?', id)!.state, 'closed')
    const next = await f.requested(await f.create())
    await f.action(next, 'approve')
    await f.action(next, 'ship-back', { carrier: '顺丰', trackingNo: 'SF12345678' })
    f.advance(10 * DAY); await f.ctx.afterSales.processDue(); await f.ctx.afterSales.processDue()
    await f.ctx.payments.reconcile()
    assert.equal(f.ctx.db.one<{ n: number }>("SELECT COUNT(*) n FROM inventory_movements WHERE kind='return'")!.n, 0)
    assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM refunds')!.n, 2)
  } finally { await f.ctx.app.close() }
})

test('AS-06 无默认地址不自动同意，设置后立即生效；少件退款不受阻碍', async () => {
  const f = await fixture()
  try {
    const a = await f.requested(await f.create()), b = await f.requested(await f.create(), 'refund-missing')
    f.advance(2 * DAY); await f.ctx.afterSales.processDue()
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM after_sales WHERE id=?', a)!.state, 'pending')
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM after_sales WHERE id=?', b)!.state, 'refunded')
    const list = (await f.call('GET', '/merchant/after-sales?state=pending&page=1', undefined, f.merchant.token)).body.result
    assert.equal(list.items[0].needsReturnAddress, true)
    await f.call('PUT', '/merchant/settings/return-address', address, f.merchant.token)
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM after_sales WHERE id=?', a)!.state, 'awaiting-return')
  } finally { await f.ctx.app.close() }
})

for (const [kind, days] of [['return-no-reason', 8], ['return-quality', 15], ['refund-missing', 15]] as const) test(`AS-07 ${kind} 截止拒绝且不消耗数量`, async () => {
  const f = await fixture()
  try {
    const order = await f.create()
    await f.call('PUT', `/member/order/${order}/receipt`, {})
    f.advance(days * DAY)
    assert.equal((await f.apply(order, kind)).status, 409)
    assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM after_sales')!.n, 0)
  } finally { await f.ctx.app.close() }
})
