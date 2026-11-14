import { z } from 'zod'
import type { Database } from './database.ts'
import type { User } from './accounts.ts'
import { ensure } from './errors.ts'

export const auditActions = ['product.create','product.edit','product.status','product.return_policy','sku.price','sku.enable','sku.stock','stock.adjust',
  'order.ship','order.reject_and_ship','cancel.approve','cancel.auto_approve','aftersale.approve','aftersale.reject','aftersale.inspect',
  'aftersale.refund_reject','aftersale.auto_approve','aftersale.auto_close','aftersale.auto_refund','refund.create','refund.result',
  'refund.retry','payment.review','settings.return_address','access.denied','promotion.edit','aftersale.shipping_comp','invoice.request','invoice.issued',
  'review.hide','review.republish','avatar.reset','reconciliation.resolve'] as const
export type AuditAction = typeof auditActions[number]
type Target = 'product'|'sku'|'order'|'after_sale'|'refund'|'payment'|'settings'
export interface AuditSummary {
  before?: string|number|boolean; after?: string|number|boolean; spec?: string; name?: string;
  descriptionChanged?: boolean; pictureChanged?: boolean; reason?: string; amountCents?: number; payerId?: string;
  outcome?: string; items?: {skuId:string;spec:string;restockCount:number}[]; interface?: string;
  backfilled?: boolean; note?: string
}
// Free text is never copied wholesale from requests. Known private fields have no audit representation.
export function auditText(value: string) {
  if (/(?:password|passwd|token|authorization|bearer|密码|口令|凭据|地址|住址|收货人|收件人)\s*[:：=]?/i.test(value)) return '内容含个人信息，已隐藏'
  return value.replace(/(?:https?:\/\/|\/uploads\/)[^\s，。]+/gi,'[图片或链接已隐藏]')
    .replace(/\+?\d[\d\s()-]{5,}\d/g,'[号码已隐藏]').slice(0,200)
}
export function appendAudit(db: Database, input: {created:number;actor?: Pick<User,'id'|'role'>|null;action:AuditAction;targetType:Target;targetId:string;
  orderId?:string|null;summary?:AuditSummary;requestKey?:string|null;result?:'success'|'denied'}) {
  const s=input.summary??{}
  // Explicit projection is shared by live writes and migration; never serialize a request object.
  const summary:AuditSummary={}
  for(const key of ['before','after','spec','name','descriptionChanged','pictureChanged','reason','amountCents','payerId','outcome','items','interface','backfilled','note'] as const){
    const value=s[key]
    if(value!==undefined)Object.assign(summary,{[key]:typeof value==='string'&&['before','after','spec','name','reason','note'].includes(key)?auditText(value):value})
  }
  if(s.items)summary.items=s.items.map(i=>({skuId:i.skuId,spec:auditText(i.spec),restockCount:i.restockCount}))
  db.run('INSERT INTO audit_log(created,actor_id,actor_kind,action,target_type,target_id,order_id,summary,result,request_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
    input.created,input.actor?.id??null,input.actor?.role??'system',input.action,input.targetType,input.targetId,input.orderId??null,JSON.stringify(summary),input.result??'success',input.requestKey??null)
}
export function deniedAudit(db:Database,user:User,route:string,now:number){
  db.transaction(()=>{
    if(db.one("SELECT id FROM audit_log WHERE actor_id=? AND action='access.denied' AND target_id=? AND created>? LIMIT 1",user.id,route,now-60000))return
    appendAudit(db,{created:now,actor:user,action:'access.denied',targetType:'settings',targetId:route,result:'denied',summary:{interface:route}})
  })
}
const id=z.string().min(1).max(100)
export const auditQuerySchema=z.object({page:z.coerce.number().int().min(1).max(1000000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20),
  group:z.enum(['all','products','inventory','shipping','aftersales','denied']).default('all'),action:z.enum(auditActions).optional(),orderId:id.optional(),productId:id.optional(),actorId:id.optional(),
  from:z.coerce.number().int().nonnegative().safe().optional(),to:z.coerce.number().int().nonnegative().safe().optional()
}).refine(q=>q.from===undefined||q.to===undefined||q.from<=q.to)
export function auditPage(db:Database,user:User,input:unknown){
  ensure(user.role==='merchant',403,'需要商家权限')
  const q=auditQuerySchema.parse(input),conditions:string[]=[],values:(string|number)[]=[]
  const groups:Record<string,readonly string[]>={products:['product.create','product.edit','product.status','product.return_policy','sku.price','sku.enable'],inventory:['sku.stock','stock.adjust'],shipping:['order.ship','order.reject_and_ship'],
    aftersales:auditActions.filter(a=>a.startsWith('aftersale.')||a.startsWith('refund.')||a.startsWith('cancel.')||a==='payment.review'),denied:['access.denied']}
  if(q.group!=='all'){const actions=groups[q.group]!;conditions.push(`a.action IN (${actions.map(()=>'?').join(',')})`);values.push(...actions)}
  for(const [column,value] of [['a.action',q.action],['a.order_id',q.orderId],['a.actor_id',q.actorId]] as const)if(value){conditions.push(column+'=?');values.push(value)}
  if(q.productId){conditions.push("((a.target_type='product' AND a.target_id=?) OR (a.target_type='sku' AND EXISTS(SELECT 1 FROM skus s WHERE s.id=a.target_id AND s.product_id=?)) OR EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=a.order_id AND i.product_id=?))");values.push(q.productId,q.productId,q.productId)}
  if(q.from!==undefined){conditions.push('a.created>=?');values.push(q.from)}
  if(q.to!==undefined){conditions.push('a.created<=?');values.push(q.to)}
  const where=conditions.length?'WHERE '+conditions.join(' AND '):''
  const counts=db.one<{n:number}>(`SELECT COUNT(*) n FROM audit_log a ${where}`,...values)!.n
  const rows=db.all<{id:number;created:number;actorAccount:string;action:string;targetType:string;targetId:string;orderId:string|null;productId:string|null;objectName:string;orderCreated:number|null;summary:string;result:string}>(`SELECT a.id,a.created,a.action,a.target_type targetType,a.target_id targetId,a.order_id orderId,a.summary,a.result,
    CASE WHEN a.actor_id IS NULL THEN '系统自动' WHEN u.status='deleted' THEN '已注销用户' ELSE u.account END actorAccount,
    CASE WHEN a.target_type='product' THEN a.target_id WHEN a.target_type='sku' THEN (SELECT product_id FROM skus WHERE id=a.target_id) END productId,
    COALESCE((SELECT name FROM order_items WHERE order_id=a.order_id ORDER BY rowid LIMIT 1),(SELECT name FROM products WHERE id=a.target_id AND a.target_type='product'),
      (SELECT p.name FROM skus s JOIN products p ON p.id=s.product_id WHERE s.id=a.target_id AND a.target_type='sku'),'商家设置') objectName,
    (SELECT created FROM orders WHERE id=a.order_id) orderCreated
    FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ${where} ORDER BY a.created DESC,a.id DESC LIMIT ? OFFSET ?`,...values,q.pageSize,(q.page-1)*q.pageSize)
  const items=rows.map(row=>{
    const {payerId,...summary}=JSON.parse(row.summary) as AuditSummary
    const payerAccount=payerId?db.one<{account:string}>("SELECT CASE WHEN status='deleted' THEN '已注销用户' ELSE account END account FROM users WHERE id=?",payerId)?.account:undefined
    return {...row,objectName:auditText(row.objectName),summary:{...summary,...(payerAccount?{payerAccount}:{})}}
  })
  return {items,counts,pages:Math.ceil(counts/q.pageSize),page:q.page,pageSize:q.pageSize}
}

export interface ProductAuditSnapshot {name:string;description:string;picture:string;status:string;returnPolicy?:string;returnPolicyReason?:string;returnPolicyNote?:string;skus:{id:string;spec:string;priceCents:number;stock:number;enabled:boolean}[]}
export function productAudit(db:Database,user:Pick<User,'id'|'role'>,productId:string,key:string,created:number,current:ProductAuditSnapshot|undefined,next:ProductAuditSnapshot,backfilled=false){
  const write=(action:AuditAction,targetType:Target,targetId:string,summary:AuditSummary)=>appendAudit(db,{created,actor:user,action,targetType,targetId,requestKey:key,summary:{...summary,...(backfilled?{backfilled:true}:{})}})
  if(!current){write('product.create','product',productId,{name:next.name});return}
  if(current.name!==next.name||current.description!==next.description||current.picture!==next.picture)write('product.edit','product',productId,{...(current.name!==next.name?{before:current.name,after:next.name}:{}),descriptionChanged:current.description!==next.description,pictureChanged:current.picture!==next.picture})
  if(current.status!==next.status)write('product.status','product',productId,{before:current.status,after:next.status})
  const policy=(p:ProductAuditSnapshot)=>JSON.stringify({policy:p.returnPolicy??'standard',reason:p.returnPolicyReason??'',note:p.returnPolicyNote??''})
  if(policy(current)!==policy(next))write('product.return_policy','product',productId,{before:policy(current),after:policy(next)})
  for(const sku of next.skus){
    const old=current.skus.find(s=>s.id===sku.id);if(!old)continue
    for(const [field,action] of [['priceCents','sku.price'],['enabled','sku.enable'],['stock','sku.stock']] as const){
      // Historical stock changes come from the exact movement, never from stale product snapshots.
      if(backfilled&&field==='stock')continue
      if(old[field]!==sku[field])write(action,'sku',sku.id,{spec:sku.spec,before:old[field],after:sku[field]})
    }
  }
}
