import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { buildTestApp } from './helpers/fixtures.ts'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Database } from '../src/database.ts'
import { removeAuditSchema } from './helpers/legacy-v13.ts'
import { createBackup } from '../src/backup.ts'

const DAY = 86400000
async function fixture(databasePath=':memory:',uploadsPath='./unused') {
  let now = Date.UTC(2026,10,10)
  const ctx = await buildTestApp({databasePath,uploadsPath,publicUrl:'http://localhost',mockPayments:true,clock:{now:()=>now}})
  const password = randomBytes(24).toString('hex')
  const buyer = ctx.testData.account({account:'audit_buyer',password})
  const merchant = ctx.testData.account({account:'audit_seller',password,role:'merchant'})
  const address = ctx.testData.address({userId:buyer.id,receiver:'Buyer',contact:'13800000000',address:'Private buyer street'})
  ctx.db.run("INSERT INTO categories(id,name,source_key) VALUES('audit-category','测试分类','audit-category')")
  const product = ctx.testData.product({name:'审计商品',skus:[{spec:'标准款',priceCents:1900,stock:100}]})
  const sku = product.skus[0]!
  const call = async(method:string,url:string,payload?:object,token=merchant.token)=>{
    const r = await ctx.app.inject({method:method as never,url,headers:{authorization:'Bearer '+token},payload})
    return {status:r.statusCode,body:r.json()}
  }
  const logs = ()=>ctx.db.all<{action:string;actor_id:string|null;actor_kind:string;target_id:string;order_id:string|null;summary:string;result:string}>('SELECT * FROM audit_log ORDER BY id')
  const create = async(ship=false)=>{
    const r=await call('POST','/member/order',{addressId:address.id,requestKey:randomUUID(),expectedAmountCents:1900,goods:[{skuId:sku.id,count:1}]},buyer.token)
    assert.equal(r.status,200);const id=r.body.result.id as string
    assert.equal((await call('POST',`/member/order/${id}/mock-pay`,{amountCents:1900},buyer.token)).status,200)
    if(ship)assert.equal((await call('POST',`/merchant/orders/${id}/ship`,{})).status,200)
    return id
  }
  const sale=async(kind='return-no-reason')=>{
    const order=await create(true)
    const r=await call('POST',`/member/order/${order}/after-sales`,{requestKey:randomUUID(),kind,description:'测试售后说明文本',items:[{skuId:sku.id,count:1}]},buyer.token)
    assert.equal(r.status,200);return {order,id:r.body.result.afterSaleId as string}
  }
  const act=(id:string,action:string,data:object={},token=merchant.token)=>call('POST',`/${token===buyer.token?'member':'merchant'}/after-sales/${id}/${action}`,{requestKey:randomUUID(),...data},token)
  return {ctx,buyer,merchant,password,product,sku,call,logs,create,sale,act,now:()=>now,advance:(ms:number)=>{now+=ms;ctx.db.run('UPDATE sessions SET expires=?',now+DAY)}}
}

test('AL01 商品审计前后值、操作人、幂等与冲突回滚',async()=>{
  const f=await fixture()
  try{
    const created=await f.call('POST','/merchant/products',{requestKey:randomUUID(),name:'新商品',categoryId:'audit-category',skus:[{spec:'标准',priceCents:100,stock:3}]})
    assert.equal(created.status,200)
    const before=(await f.call('GET',`/merchant/products/${f.product.id}`)).body.result
    const body={requestKey:randomUUID(),expectedRevision:before.revision,name:'新名称',description:'Private buyer street 13800000000',status:'off',skus:[{id:f.sku.id,priceCents:2200,stock:80,expectedStock:100,enabled:false}]}
    assert.equal((await f.call('PUT',`/merchant/products/${f.product.id}`,body)).status,200)
    const rows=f.logs();assert.deepEqual(rows.map(x=>x.action).sort(),['product.create','product.edit','product.status','sku.enable','sku.price','sku.stock'].sort())
    assert.ok(rows.every(x=>x.actor_id===f.merchant.id&&x.actor_kind==='merchant'))
    const price=JSON.parse(rows.find(x=>x.action==='sku.price')!.summary)
    assert.equal(price.before,1900);assert.equal(price.after,2200)
    assert.equal((await f.call('PUT',`/merchant/products/${f.product.id}`,body)).status,200)
    assert.equal((await f.call('PUT',`/merchant/products/${f.product.id}`,{...body,requestKey:randomUUID()})).status,409)
    assert.equal(f.logs().length,rows.length)
    assert.doesNotMatch(JSON.stringify(rows),/Private buyer street|13800000000/)
  }finally{await f.ctx.app.close()}
})

test('AL02 只追加及事务整体回滚',async()=>{
 const f=await fixture()
 try{
  await f.create(true)
  assert.throws(()=>f.ctx.db.run("UPDATE audit_log SET result='denied'"),/append|追加/i)
  assert.throws(()=>f.ctx.db.run('DELETE FROM audit_log'),/append|追加/i)
  const id=await f.create(),count=f.logs().length
  f.ctx.db.run("CREATE TRIGGER audit_test_fail BEFORE INSERT ON audit_log WHEN NEW.action='order.ship' BEGIN SELECT RAISE(ABORT,'test audit failure'); END")
  assert.equal((await f.call('POST',`/merchant/orders/${id}/ship`,{})).status,500)
  assert.equal(f.ctx.db.one<{state:number}>('SELECT state FROM orders WHERE id=?',id)!.state,2)
  assert.equal(f.logs().length,count)
 }finally{await f.ctx.app.close()}
})

test('AL03 买家拒绝与同接口一分钟节流，不保存请求或凭据',async()=>{
 const f=await fixture()
 try{
  for(let i=0;i<2;i++)assert.equal((await f.call('GET','/merchant/audit-log?orderId=private',undefined,f.buyer.token)).status,403)
  assert.equal((await f.call('POST','/merchant/products',{password:f.password,address:'Private buyer street'},f.buyer.token)).status,403)
  assert.equal(f.logs().length,2);assert.ok(f.logs().every(x=>x.result==='denied'&&x.actor_id===f.buyer.id))
  f.advance(60000);await f.call('GET','/merchant/audit-log',undefined,f.buyer.token)
  assert.equal(f.logs().length,3)
  assert.doesNotMatch(JSON.stringify(f.logs()),new RegExp(f.password+'|Private buyer street|orderId=private'))
 }finally{await f.ctx.app.close()}
})

test('AL04 筛选分页和注销后的操作人展示',async()=>{
 const f=await fixture()
 try{
  const a=await f.create(true);f.advance(1);const b=await f.create(true)
  await f.call('GET','/merchant/audit-log',undefined,f.buyer.token)
  const query=(q:string)=>f.call('GET','/merchant/audit-log?'+q)
  const page=(await query('group=shipping&pageSize=1')).body.result
  assert.equal(page.counts,2);assert.equal(page.items[0].orderId,b);assert.equal(page.pages,2)
  assert.equal((await query('orderId='+a)).body.result.items[0].orderId,a)
  assert.equal((await query('productId='+f.product.id)).body.result.counts,2)
  assert.equal((await query('actorId='+f.merchant.id)).body.result.counts,2)
  assert.equal((await query('from='+f.now()+'&to='+f.now())).body.result.counts,2)
  assert.equal((await query('from=bad')).status,400)
  assert.equal((await query('group=wrong')).status,400)
  f.ctx.db.run("UPDATE users SET status='deleted',account=? WHERE id=?",'deleted:'+f.buyer.id,f.buyer.id)
  const denied=(await query('group=denied')).body.result.items[0]
  assert.equal(denied.actorAccount,'已注销用户')
 }finally{await f.ctx.app.close()}
})

test('AL05 售后验收及退款记录、隐私和退款对象',async()=>{
 const f=await fixture()
 try{
  const s=await f.sale()
  const returnAddress={receiver:'Seller',contact:'13900000000',address:'Private return street'}
  assert.equal((await f.act(s.id,'approve',{returnAddress})).status,200)
  assert.equal((await f.act(s.id,'ship-back',{carrier:'顺丰',trackingNo:'SF123456'},f.buyer.token)).status,200)
  assert.equal((await f.act(s.id,'inspect',{items:[{skuId:f.sku.id,restockCount:1}]})).status,200)
  const rows=f.logs()
  for(const action of ['order.ship','settings.return_address','aftersale.approve','aftersale.inspect','refund.create','refund.result'])assert.ok(rows.some(x=>x.action===action),action)
  const inspect=JSON.parse(rows.find(x=>x.action==='aftersale.inspect')!.summary)
  assert.equal(inspect.items[0].restockCount,1)
  const refund=rows.find(x=>x.action==='refund.create')!
  assert.equal(refund.actor_id,f.merchant.id);assert.equal(JSON.parse(refund.summary).amountCents,1900)
  const items=(await f.call('GET','/merchant/audit-log?orderId='+s.order)).body.result.items
  assert.equal(items.find((x:{action:string})=>x.action==='refund.create').summary.payerAccount,'audit_buyer')
  assert.doesNotMatch(JSON.stringify(rows),/Private return street|13900000000|Private buyer street|13800000000|SF123456/)
 }finally{await f.ctx.app.close()}
})

test('AL06 库存调整与取消三种结论，拒绝发货不重复普通发货',async()=>{
 const f=await fixture()
 try{
  const body={requestKey:randomUUID(),delta:2,expectedStock:100,reason:'盘点库存更正'}
  assert.equal((await f.call('PUT',`/merchant/inventory/${f.sku.id}/adjustments`,body)).status,200)
  assert.equal((await f.call('PUT',`/merchant/inventory/${f.sku.id}/adjustments`,body)).status,200)
  assert.equal(f.logs().filter(r=>r.action==='stock.adjust').length,1)
  assert.deepEqual(JSON.parse(f.logs()[0]!.summary),{before:100,after:102,spec:'标准款',reason:'盘点库存更正'})
  for(const decision of ['approve','reject-and-ship','auto']){
   const order=await f.create()
   const request=await f.call('POST',`/member/order/${order}/cancel-requests`,{requestKey:randomUUID()},f.buyer.token)
   assert.equal(request.status,200)
   const data={requestKey:randomUUID(),decision,...(decision==='reject-and-ship'?{reason:'已交付物流无法拦截'}:{})}
   if(decision==='auto'){f.advance(3*DAY);await f.ctx.orders.processDueCancelRequests()}
   else{
    const url=`/merchant/orders/${order}/cancel-requests/${request.body.result.cancelRequestId}/resolve`
    assert.equal((await f.call('POST',url,data)).status,200)
    const count=f.logs().length;assert.equal((await f.call('POST',url,data)).status,200);assert.equal(f.logs().length,count)
   }
   const action=decision==='auto'?'cancel.auto_approve':decision==='approve'?'cancel.approve':'order.reject_and_ship'
   const entry=f.logs().find(r=>r.action===action&&r.order_id===order)!
   assert.ok(entry);assert.equal(entry.actor_id,decision==='auto'?null:f.merchant.id)
   assert.equal(f.logs().filter(r=>r.order_id===order&&r.action==='order.ship').length,0)
   if(decision==='approve')assert.equal(f.logs().find(r=>r.order_id===order&&r.action==='refund.create')!.actor_id,f.merchant.id)
  }
 }finally{await f.ctx.app.close()}
})

test('AL07 售后拒绝、拒绝退款、自动同意关闭与自动退款',async()=>{
 const f=await fixture()
 try{
  await f.call('PUT','/merchant/settings/return-address',{receiver:'Seller',contact:'13900000000',address:'Private return street'})
  for(const mode of ['reject','refund-reject','auto-close','auto-refund']){
   const s=await f.sale()
   if(mode==='reject')assert.equal((await f.act(s.id,'reject',{reason:'商品情况不符合条件 13800000000'})).status,200)
   else if(mode==='auto-close'){
    f.advance(2*DAY);await f.ctx.afterSales.processDue()
    assert.ok(f.logs().some(r=>r.action==='aftersale.auto_approve'&&r.actor_id===null&&r.order_id===s.order))
    f.advance(7*DAY);await f.ctx.afterSales.processDue()
   }else{
    assert.equal((await f.act(s.id,'approve')).status,200)
    assert.equal((await f.act(s.id,'ship-back',{carrier:'顺丰',trackingNo:'SF123456'},f.buyer.token)).status,200)
    if(mode==='refund-reject')assert.equal((await f.act(s.id,'refund-reject',{reason:'商品已使用且缺少包装'})).status,200)
    else{f.advance(10*DAY);await f.ctx.afterSales.processDue()}
   }
   const action='aftersale.'+mode.replaceAll('-','_')
   const row=f.logs().find(r=>r.action===action&&r.order_id===s.order)!
   assert.ok(row,action);assert.equal(row.actor_id,mode.startsWith('auto')?null:f.merchant.id)
  }
  assert.doesNotMatch(JSON.stringify(f.logs()),/13800000000|13900000000|Private return street/)
 }finally{await f.ctx.app.close()}
})

test('AL08 退款失败转人工重试成功、付款核实及重放',async()=>{
 const f=await fixture()
 try{
  const order=await f.create(),payment=f.ctx.db.one<{id:string}>('SELECT id FROM payments WHERE order_id=?',order)!.id
  f.ctx.testData.payments({paymentId:payment,preset:{outcome:'success',refundFailures:99}})
  const request=(await f.call('POST',`/member/order/${order}/cancel-requests`,{requestKey:randomUUID()},f.buyer.token)).body.result
  assert.equal((await f.call('POST',`/merchant/orders/${order}/cancel-requests/${request.cancelRequestId}/resolve`,{requestKey:randomUUID(),decision:'approve'})).status,200)
  const refund=f.ctx.db.one<{id:string}>('SELECT id FROM refunds WHERE payment_id=?',payment)!.id
  f.advance(DAY);await f.ctx.payments.reconcile()
  const results=()=>f.logs().filter(r=>r.action==='refund.result').map(r=>JSON.parse(r.summary).outcome)
  assert.deepEqual(results(),['fail','review'])
  f.ctx.testData.payments({paymentId:payment,preset:{outcome:'success',refundFailures:0}})
  const retry={requestKey:randomUUID()}
  assert.equal((await f.call('POST',`/merchant/refunds/${refund}/retry`,retry)).status,200)
  const count=f.logs().length
  assert.equal((await f.call('POST',`/merchant/refunds/${refund}/retry`,retry)).status,200);assert.equal(f.logs().length,count)
  assert.deepEqual(results(),['fail','review','success'])
  assert.equal(f.logs().find(r=>r.action==='refund.retry')!.actor_id,f.merchant.id)
  const r=await f.call('POST','/member/order',{addressId:f.ctx.db.one<{id:string}>('SELECT id FROM addresses WHERE user_id=?',f.buyer.id)!.id,requestKey:randomUUID(),expectedAmountCents:1900,goods:[{skuId:f.sku.id,count:1}]},f.buyer.token)
  f.ctx.testData.payments({paymentId:'next',preset:{outcome:'unknown'}})
  const started=await f.call('POST',`/member/order/${r.body.result.id}/payments`,{amountCents:1900},f.buyer.token)
  assert.equal(started.status,200)
  f.advance(DAY);await f.ctx.payments.reconcile()
  const data={requestKey:randomUUID(),outcome:'unpaid',reason:'渠道核实没有扣款'},url=`/merchant/payments/${started.body.result.paymentId}/resolution`
  assert.equal((await f.call('PUT',url,data)).status,200)
  const review=f.logs().find(r=>r.action==='payment.review')!;assert.equal(review.actor_id,f.merchant.id);assert.equal(JSON.parse(review.summary).outcome,'unpaid')
  const n=f.logs().length;assert.equal((await f.call('PUT',url,data)).status,200);assert.equal(f.logs().length,n)
 }finally{await f.ctx.app.close()}
})

test('AL09 013迁移补录可确认历史且重开不重复，版本14备份校验',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hdm-audit-')),path=join(root,'data','mall.sqlite'),uploads=join(root,'uploads')
 await mkdir(uploads)
 const f=await fixture(path,uploads)
 try{
  const create=(await f.call('POST','/merchant/products',{requestKey:randomUUID(),name:'历史商品',categoryId:'audit-category',skus:[{spec:'标准',priceCents:100,stock:3}]})).body.result
  await f.call('PUT',`/merchant/products/${create.id}`,{requestKey:randomUUID(),expectedRevision:create.revision,skus:[{id:create.skus[0].id,priceCents:200}]})
  assert.equal((await f.call('PUT',`/merchant/inventory/${f.sku.id}/adjustments`,{requestKey:randomUUID(),delta:1,expectedStock:100,reason:'盘点库存更正'})).status,200)
  const order=await f.create(true)
  const receipts=f.ctx.db.all('SELECT * FROM product_changes ORDER BY rowid')
  await f.ctx.app.close()
  const old=new DatabaseSync(path);try{removeAuditSchema(old)}finally{old.close()}
  const db=new Database(path)
  let rows:unknown[]=[]
  try{
   assert.equal(db.one<{user_version:number}>('PRAGMA user_version')!.user_version,14)
   assert.deepEqual(db.all('SELECT * FROM product_changes ORDER BY rowid'),receipts)
   rows=db.all('SELECT * FROM audit_log ORDER BY id')
   const price=db.one<{summary:string}>("SELECT summary FROM audit_log WHERE action='sku.price'")!
   assert.deepEqual(JSON.parse(price.summary),{spec:'标准',before:100,after:200,backfilled:true})
   const ship=db.one<{actor_id:null;summary:string}>("SELECT * FROM audit_log WHERE order_id=? AND action='order.ship'",order)!
   assert.equal(ship.actor_id,null);assert.match(JSON.parse(ship.summary).note,/未记录操作人/)
   assert.ok(db.all<{summary:string}>('SELECT summary FROM audit_log').every(r=>JSON.parse(r.summary).backfilled))
  }finally{db.close()}
  const next=new Database(path);try{assert.deepEqual(next.all('SELECT * FROM audit_log ORDER BY id'),rows)}finally{next.close()}
  const backup=await createBackup({databasePath:path,uploadsPath:uploads,destination:join(root,'backup')})
  assert.equal(backup.manifest.schemaVersion,14);assert.deepEqual(backup.manifest.issues,[])
  const broken=new DatabaseSync(path);try{broken.exec('DROP TRIGGER audit_log_no_delete')}finally{broken.close()}
  await assert.rejects(createBackup({databasePath:path,uploadsPath:uploads,destination:join(root,'broken')}),/审计只追加保护无效/)
 }finally{await f.ctx.app.close();await rm(root,{recursive:true,force:true})}
})

test('AL10 审计订单可由商家查看，普通买家入口权限不扩大',async()=>{
 const f=await fixture()
 try{
  const order=await f.create(true)
  const detail=await f.call('GET',`/merchant/orders/${order}`)
  assert.equal(detail.status,200);assert.equal(detail.body.result.id,order)
  assert.equal(detail.body.result.skus[0].name,'审计商品')
  assert.equal((await f.call('GET',`/merchant/orders/${order}`,undefined,f.buyer.token)).status,403)
  assert.equal((await f.call('GET',`/member/order/${order}`)).status,403)
 }finally{await f.ctx.app.close()}
})
