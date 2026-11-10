import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { buildTestApp } from './helpers/fixtures.ts'
import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { removeLifecycleSchema } from './helpers/legacy-v12.ts'
import { Database } from '../src/database.ts'
import { createBackup } from '../src/backup.ts'
import { buildApp } from '../src/app.ts'

const DAY = 86_400_000
async function fixture(databasePath=':memory:',uploadsPath='./unused') {
 let now = Date.UTC(2026,10,9)
 const ctx = await buildTestApp({databasePath,uploadsPath,publicUrl:'http://localhost',mockPayments:true,clock:{now:()=>now}})
 const password=randomBytes(24).toString('hex')
 const buyer=ctx.testData.account({account:'lifecycle_buyer',password})
 const merchant=ctx.testData.account({account:'lifecycle_seller',password,role:'merchant'})
 const friend=ctx.testData.account({account:'lifecycle_friend',password})
 const address=ctx.testData.address({userId:buyer.id,receiver:'Test',contact:'13800000000',address:'Test street'})
 const sku=ctx.testData.product({name:'Lifecycle',skus:[{spec:'one',priceCents:100,stock:30}]}).skus[0]!
 const call=async(method:string,url:string,payload?:object,token=buyer.token)=>{
  const r=await ctx.app.inject({method:method as never,url,headers:{authorization:'Bearer '+token},payload})
  return {status:r.statusCode,body:r.json()}
 }
 const create=async(paid=false)=>{
  const r=await call('POST','/member/order',{addressId:address.id,requestKey:randomUUID(),expectedAmountCents:100,goods:[{skuId:sku.id,count:1}]})
  assert.equal(r.status,200)
  if(paid)assert.equal((await call('POST',`/member/order/${r.body.result.id}/mock-pay`,{amountCents:100})).status,200)
  return r.body.result.id as string
 }
 const apply=()=>call('POST','/member/account-deletion',{password,acknowledged:true,requestKey:randomUUID()})
 const login=()=>ctx.accounts.login(buyer.account,password).token
 return {ctx,buyer,merchant,friend,password,sku,call,create,apply,login,now:()=>now,advance:(ms:number)=>{now+=ms;ctx.db.run('UPDATE sessions SET expires=?',now+DAY)}}
}
test('CD01 同意同版本幂等、异参拒绝、撤回保留历史并退出',async()=>{
 const f=await fixture()
 try {
  const body={version:'2026-11-09',agreedAt:f.now(),source:'startup',requestKey:randomUUID()}
  const first=await f.call('POST','/member/consents',body)
  assert.equal(first.status,200)
  assert.deepEqual((await f.call('POST','/member/consents',body)).body,first.body)
  assert.equal((await f.call('POST','/member/consents',{...body,source:'login'})).status,409)
  const second={...body,requestKey:randomUUID()}
  assert.equal((await f.call('POST','/member/consents',second)).status,200)
  assert.equal((await f.call('POST','/member/consents',{...second,version:'2026-11-10'})).status,409)
  assert.equal(f.ctx.db.one<{n:number}>("SELECT COUNT(*) n FROM consents WHERE action='agreed'")!.n,1)
  assert.equal((await f.call('POST','/member/consents/withdraw',{version:body.version,requestKey:randomUUID()})).status,200)
  assert.equal((await f.call('GET','/member/profile')).status,401)
  assert.equal(f.ctx.db.one<{n:number}>('SELECT COUNT(*) n FROM consents')!.n,2)
 }finally{await f.ctx.app.close()}
})
test('CD02 注销立即受理、会话失效、未付款归库、亲友解除并通知',async()=>{
 const f=await fixture()
 try {
  f.ctx.testData.relation({ownerId:f.buyer.id,friendId:f.friend.id})
  const id=await f.create(),other=f.login()
  assert.equal((await f.apply()).status,200)
  assert.equal((await f.call('GET','/member/profile',undefined,other)).status,401)
  assert.equal(f.ctx.db.one<{state:number}>('SELECT state FROM orders WHERE id=?',id)!.state,6)
  assert.equal(f.ctx.db.one<{stock:number}>('SELECT stock FROM skus WHERE id=?',f.sku.id)!.stock,30)
  assert.equal(f.ctx.db.one<{n:number}>('SELECT COUNT(*) n FROM relations')!.n,0)
  const notices=await f.call('GET','/member/account-notices',undefined,f.friend.token)
  assert.equal(notices.status,200);assert.match(notices.body.result[0].message,/已申请注销/)
 }finally{await f.ctx.app.close()}
})
test('CD03 注销账号可读、不能加购下单，商家不能自助注销',async()=>{
 const f=await fixture()
 try {
  assert.equal((await f.apply()).status,200)
  const token=f.login()
  assert.equal((await f.call('GET','/member/account-deletion',undefined,token)).status,200)
  const denied=await f.call('POST','/member/cart',{skuId:f.sku.id,count:1,requestKey:randomUUID()},token)
  assert.equal(denied.status,403);assert.equal(denied.body.msg,'账号正在注销中')
  assert.equal((await f.call('POST','/member/account-deletion',{password:f.password,acknowledged:true,requestKey:randomUUID()},f.merchant.token)).status,403)
 }finally{await f.ctx.app.close()}
})
test('CD04 冷静期撤销恢复active但不恢复订单与关系',async()=>{
 const f=await fixture()
 try {
  const order=await f.create();await f.apply()
  const token=f.login(),requestKey=randomUUID()
  assert.equal((await f.call('POST','/member/account-deletion/cancel',{requestKey},token)).status,200)
  assert.equal((await f.call('POST','/member/account-deletion/cancel',{requestKey},token)).status,200)
  assert.equal(f.ctx.db.one<{status:string}>('SELECT status FROM users WHERE id=?',f.buyer.id)!.status,'active')
  assert.equal(f.ctx.db.one<{state:number}>('SELECT state FROM orders WHERE id=?',order)!.state,6)
 }finally{await f.ctx.app.close()}
})
test('CD05 满15天删除个人资料，原账号名可注册，历史订单保留',async()=>{
 const f=await fixture()
 try {
  const order=await f.create();await f.apply();f.advance(15*DAY)
  await f.ctx.lifecycle.scan()
  const user=f.ctx.db.one<{status:string;account:string;password:string;profile:string;nickname:string}>('SELECT * FROM users WHERE id=?',f.buyer.id)!
  assert.equal(user.status,'deleted');assert.equal(user.account,'deleted:'+f.buyer.id);assert.equal(user.password,'');assert.equal(user.profile,'{}');assert.equal(user.nickname,'已注销用户')
  assert.ok(f.ctx.db.one('SELECT id FROM orders WHERE id=?',order))
  assert.throws(()=>f.ctx.accounts.login(user.account,f.password))
  assert.doesNotThrow(()=>f.ctx.accounts.register(f.buyer.account,f.password))
 }finally{await f.ctx.app.close()}
})
test('CD06 已付订单继续发货、注销中账号15天自动收货、普通账号不自动收货',async()=>{
 const f=await fixture()
 try {
  const order=await f.create(true)
  const normal=await f.create(true)
  f.ctx.db.run('UPDATE orders SET owner_id=?,paid_by=? WHERE id=?',f.friend.id,f.friend.id,normal)
  f.ctx.db.run('UPDATE payments SET payer_id=? WHERE order_id=?',f.friend.id,normal)
  assert.equal((await f.call('POST',`/merchant/orders/${normal}/ship`,{},f.merchant.token)).status,200)
  await f.apply();f.advance(15*DAY);await f.ctx.lifecycle.scan()
  assert.equal(f.ctx.db.one<{status:string}>('SELECT status FROM users WHERE id=?',f.buyer.id)!.status,'deleting')
  assert.equal((await f.call('POST',`/merchant/orders/${order}/ship`,{},f.merchant.token)).status,200)
  f.advance(15*DAY-1);await f.ctx.lifecycle.scan()
  assert.equal(f.ctx.db.one<{state:number}>('SELECT state FROM orders WHERE id=?',order)!.state,3)
  f.advance(1);await f.ctx.lifecycle.scan()
  assert.equal(f.ctx.db.one<{state:number}>('SELECT state FROM orders WHERE id=?',order)!.state,4)
  assert.equal(f.ctx.db.one<{state:number}>('SELECT state FROM orders WHERE id=?',normal)!.state,3)
  // Automatic receipt starts a full quality after-sales window; it must not erase access in the same scan.
  assert.equal(f.ctx.db.one<{status:string}>('SELECT status FROM users WHERE id=?',f.buyer.id)!.status,'deleting')
  assert.equal(f.ctx.db.one<{received_at:number}>('SELECT received_at FROM orders WHERE id=?',order)!.received_at,f.now())
  f.advance(15*DAY-1);await f.ctx.lifecycle.scan()
  assert.equal(f.ctx.db.one<{status:string}>('SELECT status FROM users WHERE id=?',f.buyer.id)!.status,'deleting')
  f.advance(1);await f.ctx.lifecycle.scan()
  assert.equal(f.ctx.db.one<{status:string}>('SELECT status FROM users WHERE id=?',f.buyer.id)!.status,'deleted')
 }finally{await f.ctx.app.close()}
})

test('CD13 注销中真实multipart上传及新售后、已付取消可用，其他写操作仍禁止',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hdm-deleting-upload-')),f=await fixture(':memory:',root)
 try{
  const shipped=await f.create(true),paid=await f.create(true)
  await f.call('POST',`/merchant/orders/${shipped}/ship`,{},f.merchant.token)
  await f.apply();const token=f.login(),applicationKey=randomUUID(),boundary='hdm-'+randomUUID()
  const parts=Object.entries({orderId:shipped,applicationKey,requestKey:randomUUID()}).map(([name,value])=>Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  // A decodable 2x2 JPEG, sent through Fastify's actual multipart parser and file storage.
  const photo=Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD1Dw54R8NXPhfSZ5/D2kyzS2ULySSWUbM7FASSSuSSe9FFFfZ4f+DD0X5GFT42f//Z','base64')
  const payload=Buffer.concat([...parts,Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="proof.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),photo,Buffer.from(`\r\n--${boundary}--\r\n`)])
  const uploaded=await f.ctx.app.inject({method:'POST',url:'/member/after-sales/images',headers:{authorization:'Bearer '+token,'content-type':'multipart/form-data; boundary='+boundary},payload})
  assert.equal(uploaded.statusCode,200,uploaded.body)
  const sale=await f.call('POST',`/member/order/${shipped}/after-sales`,{requestKey:applicationKey,kind:'return-quality',description:'收到的商品存在质量问题',items:[{skuId:f.sku.id,count:1}],imageIds:[uploaded.json().result.imageId]},token)
  assert.equal(sale.status,200,JSON.stringify(sale.body))
  assert.equal((await f.call('POST',`/member/order/${paid}/cancel-requests`,{requestKey:randomUUID()},token)).status,200)
  for(const [method,url] of [['POST','/member/order'],['POST','/member/cart'],['PUT','/member/profile'],['POST','/member/relations']]){
   const denied=await f.call(method!,url!,{},token);assert.equal(denied.status,403,url)
  }
  const status=await f.call('GET','/member/account-deletion',undefined,token)
  assert.equal(status.body.result.matters.length,2)
  assert.equal(status.body.result.matters[0].productName,'Lifecycle')
  assert.equal(status.body.result.matters[0].createdAt,f.now())
  assert.match(status.body.result.message,/最早 11 月 24 日删除资料；还有 2 件事需先完成/)
  f.advance(15*DAY);await f.ctx.lifecycle.scan()
  assert.equal(f.ctx.db.one<{status:string}>('SELECT status FROM users WHERE id=?',f.buyer.id)!.status,'deleting')
 }finally{await f.ctx.app.close();await rm(root,{recursive:true,force:true})}
})

test('CD14 代付人不被他人收货阻塞，删除后退款仍回原支付',async()=>{
 const f=await fixture()
 try{
  const order=await f.create(true)
  f.ctx.db.run('UPDATE orders SET owner_id=? WHERE id=?',f.friend.id,order)
  await f.call('POST',`/merchant/orders/${order}/ship`,{},f.merchant.token)
  await f.apply();assert.equal(f.ctx.lifecycle.matters(f.buyer.id).length,0)
  f.advance(15*DAY);await f.ctx.lifecycle.scan()
  assert.equal(f.ctx.db.one<{status:string}>('SELECT status FROM users WHERE id=?',f.buyer.id)!.status,'deleted')
  assert.equal(f.ctx.db.one<{state:number}>('SELECT state FROM orders WHERE id=?',order)!.state,3)
  const sale=await f.call('POST',`/member/order/${order}/after-sales`,{requestKey:randomUUID(),kind:'refund-missing',description:'商品缺少一件请退款',items:[{skuId:f.sku.id,count:1}]},f.friend.token)
  assert.equal(sale.status,200)
  assert.equal((await f.call('POST',`/merchant/after-sales/${sale.body.result.afterSaleId}/approve`,{requestKey:randomUUID()},f.merchant.token)).status,200)
  const refund=f.ctx.db.one<{payer_id:string;state:string}>('SELECT p.payer_id,r.state FROM refunds r JOIN payments p ON p.id=r.payment_id')!
  assert.equal(refund.payer_id,f.buyer.id);assert.equal(refund.state,'succeeded')
 }finally{await f.ctx.app.close()}
})

test('CD15 本人代付确认中仍阻塞注销，他人的付款确认不阻塞',async()=>{
 const f=await fixture()
 try{
  const order=await f.create()
  f.ctx.testData.payments({paymentId:'next',preset:{outcome:'unknown'}})
  assert.equal((await f.call('POST',`/member/order/${order}/payments`,{amountCents:100})).status,200)
  f.ctx.db.run('UPDATE orders SET owner_id=? WHERE id=?',f.friend.id,order)
  await f.apply();f.advance(15*DAY);await f.ctx.lifecycle.scan()
  assert.equal(f.ctx.db.one<{status:string}>('SELECT status FROM users WHERE id=?',f.buyer.id)!.status,'deleting')
  assert.equal(f.ctx.lifecycle.matters(f.buyer.id).length,1)
  f.ctx.db.run('UPDATE payments SET payer_id=? WHERE order_id=?',f.friend.id,order)
  await f.ctx.lifecycle.scan()
  assert.equal(f.ctx.db.one<{status:string}>('SELECT status FROM users WHERE id=?',f.buyer.id)!.status,'deleted')
 }finally{await f.ctx.app.close()}
})

test('CD16 代付人只等待退给本人的未完成退款，其他人退款不阻塞',async()=>{
 const f=await fixture()
 try{
  const order=await f.create(true)
  f.ctx.db.run('UPDATE orders SET owner_id=? WHERE id=?',f.friend.id,order)
  const payment=f.ctx.db.one<{id:string}>('SELECT id FROM payments WHERE order_id=?',order)!
  const refund=randomUUID()
  f.ctx.db.run("INSERT INTO refunds(id,payment_id,amount,reason,state,attempts,next_attempt_at,created) VALUES(?,?,100,'late','pending',1,?,?)",refund,payment.id,f.now()+60_000,f.now())
  await f.apply();f.advance(15*DAY);await f.ctx.lifecycle.scan()
  assert.equal(f.ctx.lifecycle.matters(f.buyer.id).length,1)
  assert.equal(f.ctx.db.one<{status:string}>('SELECT status FROM users WHERE id=?',f.buyer.id)!.status,'deleting')
  f.ctx.db.run("UPDATE refunds SET state='failed',next_attempt_at=NULL WHERE id=?",refund)
  assert.equal(f.ctx.lifecycle.matters(f.buyer.id).length,1)
  f.ctx.db.run("UPDATE refunds SET state='succeeded',completed_at=? WHERE id=?",f.now(),refund)
  assert.equal(f.ctx.lifecycle.matters(f.buyer.id).length,0)
  await f.ctx.lifecycle.scan()
  assert.equal(f.ctx.db.one<{status:string}>('SELECT status FROM users WHERE id=?',f.buyer.id)!.status,'deleted')
 }finally{await f.ctx.app.close()}
})
test('CD07 未结售后阻止删除，寄回可跟进，自动退款后原交易保留',async()=>{
 const f=await fixture()
 try {
  const order=await f.create(true)
  await f.call('POST',`/merchant/orders/${order}/ship`,{},f.merchant.token)
  const apply=await f.call('POST',`/member/order/${order}/after-sales`,{requestKey:randomUUID(),kind:'return-no-reason',items:[{skuId:f.sku.id,count:1}]})
  const id=apply.body.result.afterSaleId
  await f.call('POST',`/merchant/after-sales/${id}/approve`,{requestKey:randomUUID(),returnAddress:{receiver:'Return',contact:'13800000000',address:'Return street'}},f.merchant.token)
  await f.apply()
  assert.equal((await f.call('POST',`/member/after-sales/${id}/ship-back`,{requestKey:randomUUID(),carrier:'SF',trackingNo:'SF123456'},f.login())).status,200)
  f.advance(15*DAY);await f.ctx.lifecycle.scan()
  assert.equal(f.ctx.db.one<{status:string}>('SELECT status FROM users WHERE id=?',f.buyer.id)!.status,'deleting')
  await f.ctx.afterSales.processDue()
  await f.ctx.lifecycle.scan()
  assert.equal(f.ctx.db.one<{status:string}>('SELECT status FROM users WHERE id=?',f.buyer.id)!.status,'deleted')
  assert.equal((await f.call('GET','/merchant/after-sales',undefined,f.merchant.token)).status,200)
  assert.equal(f.ctx.db.one<{payer_id:string}>('SELECT p.payer_id FROM payments p JOIN refunds r ON r.payment_id=p.id')!.payer_id,f.buyer.id)
 }finally{await f.ctx.app.close()}
})

test('CD10 注销错误密码及事务失败不改变账号、库存、关系，同号可重试',async()=>{
 const f=await fixture()
 try{
  const order=await f.create(),requestKey=randomUUID(),body={password:f.password,acknowledged:true,requestKey}
  assert.equal((await f.call('POST','/member/account-deletion',{...body,password:randomBytes(24).toString('hex')})).status,400)
  f.ctx.db.run("CREATE TRIGGER fail_deletion BEFORE INSERT ON account_deletions BEGIN SELECT RAISE(ABORT,'test rollback'); END")
  assert.equal((await f.call('POST','/member/account-deletion',body)).status,500)
  assert.equal(f.ctx.db.one<{status:string}>('SELECT status FROM users WHERE id=?',f.buyer.id)!.status,'active')
  assert.equal(f.ctx.db.one<{state:number}>('SELECT state FROM orders WHERE id=?',order)!.state,1)
  assert.equal(f.ctx.db.one<{stock:number}>('SELECT stock FROM skus WHERE id=?',f.sku.id)!.stock,29)
  f.ctx.db.run('DROP TRIGGER fail_deletion')
  const first=await f.call('POST','/member/account-deletion',body)
  assert.equal(first.status,200)
  assert.deepEqual((await f.call('POST','/member/account-deletion',body,f.login())).body,first.body)
  assert.equal(f.ctx.db.one<{stock:number}>('SELECT stock FROM skus WHERE id=?',f.sku.id)!.stock,30)
 }finally{await f.ctx.app.close()}
})

test('CD11 待代付邀请解除，已付交易退款仍退原付款人',async()=>{
 const f=await fixture()
 try{
  const invited=await f.create(),paid=await f.create(true)
  f.ctx.db.run('UPDATE orders SET owner_id=?,invited_payer=? WHERE id=?',f.friend.id,f.buyer.id,invited)
  f.ctx.db.run('UPDATE payments SET payer_id=? WHERE order_id=?',f.friend.id,paid)
  f.ctx.db.run('UPDATE orders SET paid_by=? WHERE id=?',f.friend.id,paid)
  const request=await f.call('POST',`/member/order/${paid}/cancel-requests`,{requestKey:randomUUID()})
  assert.equal(request.status,200)
  await f.apply()
  assert.equal(f.ctx.db.one<{invited_payer:string|null}>('SELECT invited_payer FROM orders WHERE id=?',invited)!.invited_payer,null)
  const approval=await f.call('POST',`/merchant/orders/${paid}/cancel-requests/${request.body.result.cancelRequestId}/resolve`,{requestKey:randomUUID(),decision:'approve'},f.merchant.token)
  assert.equal(approval.status,200)
  const refund=f.ctx.db.one<{payer_id:string;state:string}>('SELECT p.payer_id,r.state FROM refunds r JOIN payments p ON p.id=r.payment_id')!
  assert.equal(refund.payer_id,f.friend.id);assert.equal(refund.state,'succeeded')
 }finally{await f.ctx.app.close()}
})

test('CD12 冷静期无效或同意回执被篡改时拒绝备份',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hdm-lifecycle-invalid-')),path=join(root,'data','mall.sqlite'),uploads=join(root,'uploads')
 const f=await fixture(path,uploads)
 try{
  await f.call('POST','/member/consents',{version:'2026-11-09',agreedAt:f.now(),source:'startup',requestKey:randomUUID()})
  f.ctx.db.run("UPDATE consent_requests SET request_body='{}'")
  await assert.rejects(createBackup({databasePath:path,uploadsPath:uploads,destination:join(root,'invalid-consent')}),/同意回执无效/)
  f.ctx.db.run('UPDATE consent_requests SET request_body=(SELECT request_body FROM consents WHERE id=consent_id)')
  await f.apply()
  f.ctx.db.run('UPDATE users SET deletion_due_at=NULL WHERE id=?',f.buyer.id)
  await assert.rejects(createBackup({databasePath:path,uploadsPath:uploads,destination:join(root,'invalid-due')}),/注销冷静期无效/)
 }finally{await f.ctx.app.close();await rm(root,{recursive:true,force:true})}
})
test('CD08 三年到期清除地址和售后照片，头像立即删除，备份13有效',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hdm-lifecycle-')),uploads=join(root,'uploads'),path=join(root,'data','mall.sqlite')
 const f=await fixture(path,uploads)
 try {
  await mkdir(uploads);const avatar=randomUUID()+'.jpg',photo=randomUUID()+'.jpg'
  await writeFile(join(uploads,avatar),Buffer.from([255,216,255]));await writeFile(join(uploads,photo),Buffer.from([255,216,255]))
  f.ctx.db.run('UPDATE users SET profile=? WHERE id=?',JSON.stringify({avatar:'/uploads/'+avatar}),f.buyer.id)
  const order=await f.create(true)
  await f.call('POST',`/merchant/orders/${order}/ship`,{},f.merchant.token)
  await f.call('PUT',`/member/order/${order}/receipt`,{})
  f.ctx.db.run('INSERT INTO after_sale_images(image_id,actor_id,order_id,application_key,request_key,sha256,path,created) VALUES(?,?,?,?,?,?,?,?)',randomUUID(),f.buyer.id,order,randomUUID(),randomUUID(),'0'.repeat(64),'/uploads/'+photo,f.now())
  const completed=f.now(),due=new Date(completed);due.setUTCFullYear(due.getUTCFullYear()+3)
  await f.apply();f.advance(15*DAY);await f.ctx.lifecycle.scan()
  await assert.rejects(access(join(uploads,avatar)));await access(join(uploads,photo))
  const stored=f.ctx.db.one<{retain_until:number}>('SELECT retain_until FROM orders WHERE id=?',order)!
  assert.equal(stored.retain_until,due.getTime())
  f.advance(due.getTime()-f.now()-1);await f.ctx.lifecycle.scan();await access(join(uploads,photo))
  f.advance(1);await f.ctx.lifecycle.scan();await assert.rejects(access(join(uploads,photo)))
  const address=JSON.parse(f.ctx.db.one<{address:string}>('SELECT address FROM orders WHERE id=?',order)!.address)
  assert.equal(address.receiver,'');assert.equal(address.contact,'');assert.equal(address.address,'')
  const backup=await createBackup({databasePath:path,uploadsPath:uploads,destination:join(root,'backup')})
  assert.equal(backup.manifest.schemaVersion,13);assert.deepEqual(backup.manifest.issues,[])
 }finally{await f.ctx.app.close();await rm(root,{recursive:true,force:true})}
})
test('CD09 012升级013保留账号订单，重启扫描执行到期注销',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hdm-lifecycle-migration-')),path=join(root,'mall.sqlite'),uploads=join(root,'uploads')
 const f=await fixture(path,uploads)
 let next:Awaited<ReturnType<typeof buildApp>>|undefined
 try {
  const order=await f.create();await f.ctx.app.close()
  const old=new DatabaseSync(path)
  try{removeLifecycleSchema(old)}finally{old.close()}
  const migrated=new Database(path)
  try{
   assert.equal(migrated.one<{user_version:number}>('PRAGMA user_version')!.user_version,13)
   assert.equal(migrated.one<{account:string}>('SELECT account FROM users WHERE id=?',f.buyer.id)!.account,f.buyer.account)
   assert.ok(migrated.one('SELECT id FROM orders WHERE id=?',order))
   migrated.run("UPDATE users SET status='deleting',deletion_requested_at=?,deletion_due_at=? WHERE id=?",f.now(),f.now()+15*DAY,f.buyer.id)
   migrated.run('UPDATE orders SET state=6 WHERE id=?',order)
  }finally{migrated.close()}
  next=await buildApp({databasePath:path,uploadsPath:uploads,publicUrl:'http://localhost',mockPayments:true,clock:{now:()=>f.now()+15*DAY}})
  assert.equal(next.db.one<{status:string}>('SELECT status FROM users WHERE id=?',f.buyer.id)!.status,'deleted')
 }finally{if(next)await next.app.close();await f.ctx.app.close();await rm(root,{recursive:true,force:true})}
})
