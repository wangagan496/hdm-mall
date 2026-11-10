import { randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Database } from './database.ts'
import type { Accounts, User } from './accounts.ts'
import type { Clock } from './clock.ts'
import { ensure } from './errors.ts'
import { localAvatarPath } from './avatar.ts'
import { recordStockMovement } from './inventory.ts'

const DAY=86_400_000
const consentSchema=z.object({version:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),agreedAt:z.number().int().nonnegative().safe(),source:z.enum(['startup','login']),requestKey:z.string().uuid()}).strict()
const keySchema=z.object({requestKey:z.string().uuid()}).strict()
const deletionSchema=keySchema.extend({password:z.string().min(8).max(128),acknowledged:z.literal(true)}).strict()
type LifecycleUser=User&{status:string;deletion_requested_at:number|null;deletion_due_at:number|null}
interface Matter {id:string;kind:string;message:string;productName:string;createdAt:number}

export class AccountLifecycle {
 readonly db:Database;readonly accounts:Accounts;readonly clock:Clock;readonly uploadsPath:string
 constructor(db:Database,accounts:Accounts,clock:Clock,uploadsPath:string){this.db=db;this.accounts=accounts;this.clock=clock;this.uploadsPath=uploadsPath}
 private user(id:string){const user=this.db.one<LifecycleUser>('SELECT * FROM users WHERE id=?',id);ensure(user,404,'账号不存在');return user}
 consent(user:User,input:unknown){
  const data=consentSchema.parse(input),body=JSON.stringify(data)
  ensure(data.agreedAt<=this.clock.now()+60_000,400,'同意时间无效')
  return this.db.transaction(()=>{
   const replay=this.db.one<{id:string;user_id:string;request_body:string}>('SELECT consent_id id,user_id,request_body FROM consent_requests WHERE request_key=?',data.requestKey)
   if(replay){ensure(replay.user_id===user.id&&replay.request_body===body,409,'同意记录内容已变化');return {id:replay.id}}
   const existing=this.db.one<{id:string}>("SELECT id FROM consents WHERE user_id=? AND version=? AND action='agreed'",user.id,data.version)
   const id=existing?.id??randomUUID()
   if(!existing)this.db.run("INSERT INTO consents VALUES(?,?,?,?,?,'agreed',?,?,?)",id,user.id,data.version,data.agreedAt,data.source,data.requestKey,body,this.clock.now())
   this.db.run('INSERT INTO consent_requests VALUES(?,?,?,?)',data.requestKey,user.id,id,body)
   return {id}
  })
 }
 withdrawConsent(user:User,input:unknown){
  const data=keySchema.extend({version:consentSchema.shape.version}).parse(input),body=JSON.stringify(data)
  return this.db.transaction(()=>{
   const replay=this.db.one<{id:string;user_id:string;request_body:string}>('SELECT consent_id id,user_id,request_body FROM consent_requests WHERE request_key=?',data.requestKey)
   if(replay){ensure(replay.user_id===user.id&&replay.request_body===body,409,'同意记录内容已变化');return {id:replay.id}}
   const id=randomUUID(),now=this.clock.now()
   this.db.run("INSERT INTO consents VALUES(?,?,?,?,'login','withdrawn',?,?,?)",id,user.id,data.version,now,data.requestKey,body,now)
   this.db.run('INSERT INTO consent_requests VALUES(?,?,?,?)',data.requestKey,user.id,id,body)
   this.db.run('DELETE FROM sessions WHERE user_id=?',user.id)
   return {id}
  })
 }
 matters(userId:string):Matter[]{
  // Owners retain transaction and after-sales access. A payer only waits for their own money to settle.
  const orders=this.db.all<{id:string;owner_id:string;state:number;created:number;received_at:number|null;productName:string;confirming:number;refunding:number;following:number;remaining:number}>(`SELECT o.*,
   (SELECT group_concat(i.name,'、') FROM order_items i WHERE i.order_id=o.id) productName,
   EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id AND (o.owner_id=? OR p.payer_id=?) AND (p.state='pending' OR p.state='closed' AND p.next_query_at IS NOT NULL)) confirming,
   EXISTS(SELECT 1 FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.order_id=o.id AND (o.owner_id=? OR p.payer_id=?) AND r.state<>'succeeded') refunding,
   (EXISTS(SELECT 1 FROM order_cancel_requests c WHERE c.order_id=o.id AND c.state='pending') OR
    EXISTS(SELECT 1 FROM after_sales a WHERE a.order_id=o.id AND a.state IN ('pending','awaiting-return','returned','refunding'))) following,
   EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.count>COALESCE((SELECT SUM(a.count) FROM after_sale_items a JOIN after_sales s ON s.id=a.after_sale_id
    WHERE s.order_id=o.id AND a.sku_id=i.sku_id AND s.state NOT IN ('rejected','withdrawn','closed')),0)) remaining
   FROM orders o WHERE o.owner_id=? OR EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.payer_id=?) ORDER BY o.created,o.id`,userId,userId,userId,userId,userId,userId)
  return orders.filter(o=>o.confirming||o.refunding||o.owner_id===userId&&(
   [1,2,3].includes(o.state)||o.following||[4,5].includes(o.state)&&o.remaining&&o.received_at!==null&&this.clock.now()<o.received_at+15*DAY
  )).map(o=>({id:o.id,kind:'order',productName:o.productName,createdAt:o.created,message:
   o.confirming?'付款结果仍在确认，确认后继续处理':o.refunding?'退款处理中，退款退回原付款人':
   o.following?'售后或取消申请处理中，退款退回原付款人':o.state===1?'未付款订单会在提交后自动取消':
   o.state===2?'等待商家发货':o.state===3?'请确认收货；发货满 15 天会自动确认，之后仍可申请售后':'已收货，售后期内仍可申请售后'}))
 }
 status(user:User){
  const latest=this.user(user.id),matters=this.matters(user.id)
  const date=new Date((latest.deletion_due_at??this.clock.now())+8*3600000),day=`${date.getUTCMonth()+1} 月 ${date.getUTCDate()} 日`
  return {status:latest.status,requestedAt:latest.deletion_requested_at,dueAt:latest.deletion_due_at,matters,
   canCancel:latest.status==='deleting'&&this.clock.now()<latest.deletion_due_at!,
   message:latest.status!=='deleting'?'提交后有15天冷静期':matters.length?`最早 ${day}删除资料；还有 ${matters.length} 件事需先完成`:`将于 ${day}删除资料`}
 }
 private replay(user:User,key:string,body:string){
  const row=this.db.one<{user_id:string;request_body:string;result:string}>('SELECT * FROM account_deletions WHERE request_key=?',key)
  if(!row)return
  ensure(row.user_id===user.id&&row.request_body===body,409,'注销操作内容已变化')
  return JSON.parse(row.result)
 }
 private receipt(user:User,key:string,body:string,action:string){
  const result={id:randomUUID(),...this.status(user)}
  this.db.run('INSERT INTO account_deletions VALUES(?,?,?,?,?,?,?)',result.id,user.id,action,key,body,JSON.stringify(result),this.clock.now())
  return result
 }
 request(user:User,input:unknown){
  const data=deletionSchema.parse(input)
  ensure(user.role==='buyer',403,'商家账号请联系管理员处理')
  ensure(this.accounts.verifyPassword(user.id,data.password),400,'当前密码不正确')
  // Passwords are verified but never persisted in idempotency receipts.
  const body=JSON.stringify({action:'request',acknowledged:true})
  return this.db.transaction(()=>{
   const replay=this.replay(user,data.requestKey,body);if(replay)return replay
   ensure(this.user(user.id).status==='active',409,'账号已在注销处理中')
   const now=this.clock.now()
   this.db.run("UPDATE users SET status='deleting',deletion_requested_at=?,deletion_due_at=? WHERE id=?",now,now+15*DAY,user.id)
   for(const order of this.db.all<{id:string}>(`SELECT o.id FROM orders o WHERE o.owner_id=? AND o.state=1
    AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id AND (p.state='pending' OR p.state='succeeded' OR p.state='closed' AND p.next_query_at IS NOT NULL))`,user.id)){
    for(const item of this.db.all<{sku_id:string;count:number}>('SELECT sku_id,count FROM order_items WHERE order_id=?',order.id)){
     this.db.run('UPDATE skus SET stock=stock+? WHERE id=?',item.count,item.sku_id)
     recordStockMovement(this.db,{kind:'cancel',skuId:item.sku_id,delta:item.count,orderId:order.id,actorId:user.id},this.clock)
    }
    this.db.run('UPDATE orders SET state=6 WHERE id=?',order.id)
   }
   const friends=this.db.all<{id:string}>("SELECT DISTINCT CASE WHEN owner_id=? THEN friend_id ELSE owner_id END id FROM relations WHERE (owner_id=? OR friend_id=?) AND status<>'revoked'",user.id,user.id,user.id)
   for(const friend of friends)this.db.run('INSERT INTO account_notices VALUES(?,?,?,?)',randomUUID(),friend.id,'对方已申请注销，亲友关系已解除',now)
   this.db.run('DELETE FROM relations WHERE owner_id=? OR friend_id=?',user.id,user.id)
   this.db.run('UPDATE orders SET invited_payer=NULL WHERE invited_payer=? AND state=1',user.id)
   this.db.run('DELETE FROM sessions WHERE user_id=?',user.id)
   return this.receipt(user,data.requestKey,body,'request')
  })
 }
 cancel(user:User,input:unknown){
  const data=keySchema.parse(input),body=JSON.stringify({action:'cancel'})
  return this.db.transaction(()=>{
   const replay=this.replay(user,data.requestKey,body);if(replay)return replay
   const current=this.user(user.id)
   ensure(current.status==='deleting'&&this.clock.now()<current.deletion_due_at!,409,'已超过注销冷静期')
   this.db.run("UPDATE users SET status='active',deletion_requested_at=NULL,deletion_due_at=NULL WHERE id=?",user.id)
   return this.receipt(user,data.requestKey,body,'cancel')
  })
 }
 private queueFile(path:unknown){const safe=typeof path==='string'?localAvatarPath(path):undefined;if(safe)this.db.run('INSERT OR IGNORE INTO account_file_deletions VALUES(?,?)',safe,this.clock.now())}
 private erase(user:LifecycleUser){
  this.db.transaction(()=>{
   if(this.user(user.id).status!=='deleting'||this.matters(user.id).length)return
   const now=this.clock.now()
   this.queueFile(JSON.parse(user.profile).avatar)
   this.db.run("UPDATE users SET status='deleted',account=?,nickname='已注销用户',password='',profile='{}',deleted_at=? WHERE id=?",'deleted:'+user.id,now,user.id)
   for(const table of ['addresses','address_save_sessions','address_tombstones','carts','cart_requests','sessions','account_notices'])this.db.run(`DELETE FROM ${table} WHERE user_id=?`,user.id)
   this.db.run('DELETE FROM relations WHERE owner_id=? OR friend_id=?',user.id,user.id)
   const completed=this.db.one<{at:number|null}>(`SELECT MAX(at) at FROM (
    SELECT received_at at FROM orders WHERE owner_id=? UNION ALL
    SELECT a.resolved_at at FROM after_sales a JOIN orders o ON o.id=a.order_id WHERE o.owner_id=? UNION ALL
    SELECT COALESCE(r.completed_at,?) at FROM refunds r JOIN payments p ON p.id=r.payment_id JOIN orders o ON o.id=p.order_id WHERE o.owner_id=?
   )`,user.id,user.id,now,user.id)?.at
   const retention=new Date(completed??user.deletion_requested_at??now);retention.setUTCFullYear(retention.getUTCFullYear()+3)
   // Legacy refunds without a completion timestamp retain from this scan rather than guessing an earlier date.
   this.db.run('UPDATE orders SET retain_until=MAX(COALESCE(retain_until,0),?) WHERE owner_id=?',retention.getTime(),user.id)
  })
 }
 async scan(){
  const now=this.clock.now()
  this.db.run(`UPDATE orders SET state=4,received_by=owner_id,received_at=? WHERE state=3 AND shipped_at<=?
   AND owner_id IN (SELECT id FROM users WHERE status='deleting')`,now,now-15*DAY)
  for(const user of this.db.all<LifecycleUser>("SELECT * FROM users WHERE status='deleting' AND deletion_due_at<=?",now))if(!this.matters(user.id).length)this.erase(user)
  for(const order of this.db.all<{id:string;address:string}>('SELECT id,address FROM orders WHERE retain_until<=? AND personal_data_cleared_at IS NULL',now)){
   this.db.transaction(()=>{
    const address=JSON.parse(order.address)
    for(const key of ['receiver','contact','address','fullLocation','provinceCode','cityCode','countyCode'])address[key]=''
    for(const photo of this.db.all<{path:string}>('SELECT path FROM after_sale_images WHERE order_id=?',order.id))this.queueFile(photo.path)
    this.db.run('DELETE FROM after_sale_images WHERE order_id=?',order.id)
    this.db.run('UPDATE orders SET address=?,personal_data_cleared_at=? WHERE id=?',JSON.stringify(address),now,order.id)
   })
  }
  for(const file of this.db.all<{path:string}>('SELECT path FROM account_file_deletions')){
   const path=localAvatarPath(file.path);if(!path)throw new Error('Invalid account cleanup path')
   try{unlinkSync(join(this.uploadsPath,path.slice('/uploads/'.length)))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')continue}
   this.db.run('DELETE FROM account_file_deletions WHERE path=?',file.path)
  }
 }
}
