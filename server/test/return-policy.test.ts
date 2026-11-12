import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { buildTestApp } from './helpers/fixtures.ts'
import { withReturnShipping } from './helpers/return-shipping.ts'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Database } from '../src/database.ts'
import { createBackup, restoreBackup } from '../src/backup.ts'
import { removeReturnPolicySchema } from './helpers/legacy-v14.ts'

async function fixture(databasePath=':memory:',uploadsPath='./unused') {
  const ctx=await buildTestApp({databasePath,uploadsPath,mockPayments:true,publicUrl:'http://localhost'})
  const password=randomBytes(24).toString('hex')
  const buyer=ctx.testData.account({account:'policy_buyer',password})
  const merchant=ctx.testData.account({account:'policy_seller',password,role:'merchant'})
  const address=ctx.testData.address({userId:buyer.id,receiver:'Buyer',contact:'13800000000',address:'测试地址'})
  const product=ctx.testData.product({name:'退货规则商品',skus:[{spec:'标准款',priceCents:1900,stock:100}]})
  const sku=product.skus[0]!
  const call=async(method:string,url:string,payload?:object,token=merchant.token)=>{
    payload=withReturnShipping(ctx,uploadsPath,url,payload,token)
    const r=await ctx.app.inject({method:method as never,url,headers:{authorization:'Bearer '+token},payload})
    return {status:r.statusCode,body:r.json()}
  }
  const edit=async(reason:string,note='',policy=reason==='standard'?'standard':['custom','perishable','digital','periodical'].includes(reason)?'law-excluded':'confirm-required')=>{
    const current=(await call('GET',`/merchant/products/${product.id}`)).body.result
    return call('PUT',`/merchant/products/${product.id}`,{requestKey:randomUUID(),expectedRevision:current.revision,returnPolicy:policy,returnPolicyReason:reason==='standard'?'':reason,returnPolicyNote:note})
  }
  const quote=async()=> (await call('GET',`/member/order/pre?skuId=${sku.id}&count=1`,undefined,buyer.token)).body.result
  const body=()=>({addressId:address.id,requestKey:randomUUID(),expectedAmountCents:1900,goods:[{skuId:sku.id,count:1}]})
  const create=(data:object)=>call('POST','/member/order',data,buyer.token)
  const paid=async()=>{
    const q=await quote(),r=await create({...body(),returnPolicyConfirmed:true,expectedReturnPolicyToken:q.returnPolicyToken})
    assert.equal(r.status,200);const id=r.body.result.id as string
    assert.equal((await call('POST',`/member/order/${id}/mock-pay`,{amountCents:1900},buyer.token)).status,200)
    assert.equal((await call('POST',`/merchant/orders/${id}/ship`,{})).status,200)
    return id
  }
  const detail=async(id:string)=>(await call('GET',`/member/order/${id}`,undefined,buyer.token)).body.result
  const sale=(id:string,kind='return-no-reason',condition?:string)=>call('POST',`/member/order/${id}/after-sales`,{requestKey:randomUUID(),kind,description:'发现其他质量问题',items:[{skuId:sku.id,count:1,...(condition?{conditionDeclared:condition}:{})}]},buyer.token)
  return {ctx,buyer,merchant,address,product,sku,call,edit,quote,body,create,paid,detail,sale}
}

test('RP01 固定规则枚举、组合与瑕疵说明校验及买家403',async()=>{
 const f=await fixture();try{
  for(const [reason,note,policy] of [['invented','','confirm-required'],['defect','','confirm-required'],['defect','四个字','confirm-required'],['defect','字'.repeat(101),'confirm-required'],['custom','','confirm-required'],['near-expiry','','law-excluded']]){
    assert.equal((await f.edit(reason!,note!,policy!)).status,400)
  }
  assert.equal((await f.edit('defect','外包装有轻微划痕')).status,200)
  assert.equal((await f.call('PUT',`/merchant/products/${f.product.id}`,{requestKey:randomUUID(),returnPolicy:'standard'},f.buyer.token)).status,403)
 }finally{await f.ctx.app.close()}
})

test('RP02 下单默认未确认、最新确认快照和幂等回放',async()=>{
 const f=await fixture();try{
  assert.equal((await f.edit('unsealed')).status,200)
  const refused=await f.create(f.body());assert.equal(refused.status,409);assert.equal(refused.body.reason,'RETURN_POLICY_CONFIRM_REQUIRED');assert.equal(refused.body.result.goods[0].skuId,f.sku.id)
  const q=await f.quote();assert.ok(q.returnPolicyToken)
  const body={...f.body(),returnPolicyConfirmed:true,expectedReturnPolicyToken:q.returnPolicyToken}
  const r=await f.create(body);assert.equal(r.status,200)
  const snapshot=f.ctx.db.one<{return_policy:string;return_policy_reason:string;return_policy_confirmed:number}>('SELECT * FROM order_items WHERE order_id=?',r.body.result.id)!
  assert.equal(snapshot.return_policy,'confirm-required');assert.equal(snapshot.return_policy_reason,'unsealed');assert.equal(snapshot.return_policy_confirmed,1)
  await f.edit('custom');assert.equal((await f.create(body)).body.result.id,r.body.result.id)
  assert.equal((await f.create({...body,returnPolicyConfirmed:false})).status,409)
 }finally{await f.ctx.app.close()}
})

test('RP03 规则变化必须重新确认，法定排除无需勾选，旧订单不受修改影响',async()=>{
 const f=await fixture();try{
  const old=await f.create(f.body());assert.equal(old.status,200)
  await f.edit('unsealed');const q=await f.quote();await f.edit('activated')
  const stale=await f.create({...f.body(),returnPolicyConfirmed:true,expectedReturnPolicyToken:q.returnPolicyToken})
  assert.equal(stale.status,409);assert.equal(stale.body.reason,'RETURN_POLICY_CHANGED');assert.equal(stale.body.result.goods[0].returnPolicyReason,'activated')
  const fresh=await f.quote();assert.equal((await f.create({...f.body(),returnPolicyConfirmed:true,expectedReturnPolicyToken:fresh.returnPolicyToken})).status,200)
  await f.edit('custom');const excluded=await f.create(f.body());assert.equal(excluded.status,200)
  assert.equal(f.ctx.db.one<{return_policy:string}>('SELECT return_policy FROM order_items WHERE order_id=?',old.body.result.id)!.return_policy,'standard')
  assert.equal(f.ctx.db.one<{return_policy_confirmed:number}>('SELECT return_policy_confirmed FROM order_items WHERE order_id=?',excluded.body.result.id)!.return_policy_confirmed,0)
 }finally{await f.ctx.app.close()}
})

for(const reason of ['unsealed','activated'])test(`RP04 ${reason} 未声明和已拆封拒绝，未拆封可申请且商家查看声明并验收拒绝`,async()=>{
 const f=await fixture();try{
  await f.edit(reason);const id=await f.paid(),detail=await f.detail(id)
  assert.ok(detail.skus[0].afterSaleKinds.includes('return-no-reason'))
  assert.equal((await f.sale(id)).status,400);assert.equal((await f.sale(id,'return-no-reason','unsealed')).status,409)
  const r=await f.sale(id,'return-no-reason','sealed');assert.equal(r.status,200)
  const saleId=r.body.result.afterSaleId
  const list=(await f.call('GET','/merchant/after-sales?state=all')).body.result
  assert.equal(list.items[0].items[0].conditionDeclared,'sealed')
  const act=(action:string,data:object)=>f.call('POST',`/merchant/after-sales/${saleId}/${action}`,{requestKey:randomUUID(),...data})
  assert.equal((await act('approve',{returnAddress:{receiver:'仓库',contact:'13800000000',address:'测试退货仓库'}})).status,200)
  assert.equal((await f.call('POST',`/member/after-sales/${saleId}/ship-back`,{requestKey:randomUUID(),carrier:'SF',trackingNo:'SF123456789'},f.buyer.token)).status,200)
  assert.equal((await act('refund-reject',{reason:'实际已拆封，密封已损坏'})).status,200)
 }finally{await f.ctx.app.close()}
})

test('RP05 临期瑕疵法定排除不能无理由，质量和少件仍可申请',async()=>{
 for(const reason of ['near-expiry','defect','custom']){
  const f=await fixture();try{
   assert.equal((await f.edit(reason,reason==='defect'?'外包装有轻微划痕':'')).status,200)
   for(const kind of ['return-no-reason','return-quality','refund-missing']){
    const id=await f.paid(),d=await f.detail(id)
    assert.ok(!d.afterSaleKinds.includes('return-no-reason'));assert.ok(!d.skus[0].afterSaleKinds.includes('return-no-reason'))
    assert.equal((await f.sale(id,kind)).status,kind==='return-no-reason'?409:200)
   }
  }finally{await f.ctx.app.close()}
 }
})

test('RP06 未确认的第七条快照按标准处理，同单按规格筛选',async()=>{
 const f=await fixture();try{
  await f.edit('near-expiry');const id=await f.paid()
  f.ctx.db.run('UPDATE order_items SET return_policy_confirmed=0 WHERE order_id=?',id)
  assert.ok((await f.detail(id)).skus[0].afterSaleKinds.includes('return-no-reason'))
  assert.equal((await f.sale(id)).status,200)
  const other=f.ctx.testData.product({name:'普通商品',skus:[{spec:'普通',priceCents:100,stock:10}]}).skus[0]!
  await f.edit('custom')
  const r=await f.create({...f.body(),expectedAmountCents:2000,goods:[{skuId:f.sku.id,count:1},{skuId:other.id,count:1}]});assert.equal(r.status,200)
  const mixed=r.body.result.id
  await f.call('POST',`/member/order/${mixed}/mock-pay`,{amountCents:2000},f.buyer.token);await f.call('POST',`/merchant/orders/${mixed}/ship`,{})
  const d=await f.detail(mixed)
  assert.ok(d.afterSaleKinds.includes('return-no-reason'));assert.ok(!d.skus.find((s:{id:string})=>s.id===f.sku.id).afterSaleKinds.includes('return-no-reason'))
  assert.ok(d.skus.find((s:{id:string})=>s.id===other.id).afterSaleKinds.includes('return-no-reason'))
  assert.equal((await f.sale(mixed)).status,409)
  assert.equal((await f.call('POST',`/member/order/${mixed}/after-sales`,{requestKey:randomUUID(),kind:'return-no-reason',items:[{skuId:other.id,count:1}]},f.buyer.token)).status,200)
 }finally{await f.ctx.app.close()}
})

test('RP07 规则修改审计前后值、重放唯一、详情购物车预览一致',async()=>{
 const f=await fixture();try{
  const edited=await f.edit('near-expiry');assert.equal(edited.status,200)
  const rows=f.ctx.db.all<{summary:string}>("SELECT summary FROM audit_log WHERE action='product.return_policy'")
  assert.equal(rows.length,1);const s=JSON.parse(rows[0]!.summary);assert.match(s.before,/standard/);assert.match(s.after,/near-expiry/)
  const d=(await f.call('GET',`/goods?id=${f.product.id}`,undefined,f.buyer.token)).body
  assert.equal(d.returnPolicyReason,'near-expiry')
  await f.call('POST','/member/cart',{skuId:f.sku.id,count:1,requestKey:randomUUID()},f.buyer.token)
  const cart=(await f.call('GET','/member/cart',undefined,f.buyer.token)).body.result
  assert.equal(cart[0].returnPolicyReason,'near-expiry');assert.equal((await f.quote()).goods[0].returnPolicyReason,'near-expiry')
 }finally{await f.ctx.app.close()}
})

test('RP08 014迁移旧商品订单默认支持且未确认，备份14兼容和15恢复校验',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hdm-return-policy-')),path=join(root,'live','mall.sqlite'),uploads=join(root,'uploads')
 await mkdir(uploads)
 const f=await fixture(path,uploads)
 try{
  const order=await f.paid(),before=f.ctx.db.all('SELECT * FROM payments')
  await f.ctx.app.close()
  const legacy=new DatabaseSync(path);try{removeReturnPolicySchema(legacy)}finally{legacy.close()}
  const oldBackup=await createBackup({databasePath:path,uploadsPath:uploads,destination:join(root,'v14')})
  assert.equal(oldBackup.manifest.schemaVersion,14)
  const next=new Database(path)
  try{
   assert.equal(next.one<{user_version:number}>('PRAGMA user_version')!.user_version,17)
   assert.deepEqual({...next.one<Record<string,unknown>>('SELECT return_policy,return_policy_reason,return_policy_note,return_policy_confirmed FROM order_items WHERE order_id=?',order)},
    {return_policy:'standard',return_policy_reason:'',return_policy_note:'',return_policy_confirmed:0})
   assert.equal(next.one<{return_policy:string}>('SELECT return_policy FROM products WHERE id=?',f.product.id)!.return_policy,'standard')
   assert.deepEqual(next.all('SELECT * FROM payments'),before)
  }finally{next.close()}
  const backup=await createBackup({databasePath:path,uploadsPath:uploads,destination:join(root,'v15')})
  assert.equal(backup.manifest.schemaVersion,17);assert.deepEqual(backup.manifest.issues,[])
  const restored=await restoreBackup({backupPath:backup.root,destination:join(root,'restored')})
  const db=new Database(join(restored.root,'mall.sqlite'));try{assert.equal(db.one<{return_policy:string}>('SELECT return_policy FROM order_items WHERE order_id=?',order)!.return_policy,'standard')}finally{db.close()}
  const broken=new DatabaseSync(path);try{broken.exec("PRAGMA ignore_check_constraints=ON; UPDATE products SET return_policy='confirm-required',return_policy_reason='defect',return_policy_note=''")}finally{broken.close()}
  await assert.rejects(createBackup({databasePath:path,uploadsPath:uploads,destination:join(root,'broken')}))
 }finally{await f.ctx.app.close();await rm(root,{recursive:true,force:true})}
})

test('RP09 规则保存回执唯一、冲突和审计失败整体回滚',async()=>{
 const f=await fixture();try{
  const current=(await f.call('GET',`/merchant/products/${f.product.id}`)).body.result
  const body={requestKey:randomUUID(),expectedRevision:current.revision,returnPolicy:'confirm-required',returnPolicyReason:'activated',returnPolicyNote:''}
  const url=`/merchant/products/${f.product.id}`
  assert.equal((await f.call('PUT',url,body)).status,200)
  assert.equal((await f.call('PUT',url,body)).status,200)
  assert.equal((await f.call('PUT',url,{...body,requestKey:randomUUID()})).status,409)
  assert.equal(f.ctx.db.one<{n:number}>("SELECT COUNT(*) n FROM audit_log WHERE action='product.return_policy'")!.n,1)
  f.ctx.db.run("CREATE TRIGGER test_policy_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action='product.return_policy' BEGIN SELECT RAISE(ABORT,'test audit failure'); END")
  assert.equal((await f.edit('standard')).status,500)
  assert.equal((await f.call('GET',url)).body.result.returnPolicyReason,'activated')
 }finally{await f.ctx.app.close()}
})
