import type { Database } from '../database.ts'
import type { User } from '../accounts.ts'
import { appendAudit, productAudit, type AuditAction, type AuditSummary, type ProductAuditSnapshot } from '../audit.ts'

export function backfillAudit(db:Database){
  const actor=(id:string|null)=>id?db.one<Pick<User,'id'|'role'>>('SELECT id,role FROM users WHERE id=?',id):undefined
  const previous=new Map<string,ProductAuditSnapshot>()
  for(const row of db.all<{actor_id:string;request_key:string;action:string;product_id:string;result:string;created:number}>('SELECT * FROM product_changes ORDER BY created,rowid')){
    const next=JSON.parse(row.result) as ProductAuditSnapshot,old=previous.get(row.product_id),user=actor(row.actor_id)!
    if(row.action==='create'||old)productAudit(db,user,row.product_id,row.request_key,row.created,old,next,true)
    else appendAudit(db,{created:row.created,actor:user,action:'product.edit',targetType:'product',targetId:row.product_id,requestKey:row.request_key,summary:{backfilled:true,note:'历史保存，未记录修改前内容'}})
    previous.set(row.product_id,next)
  }
  for(const r of db.all<{sku_id:string;actor_id:string|null;balance:number;delta:number;reason:string;created:number;business_key:string;spec:string}>("SELECT m.*,s.spec FROM inventory_movements m JOIN skus s ON s.id=m.sku_id WHERE m.kind='adjust' ORDER BY m.id")){
    appendAudit(db,{created:r.created,actor:actor(r.actor_id),action:r.business_key.startsWith('product-edit:')?'sku.stock':'stock.adjust',targetType:'sku',targetId:r.sku_id,requestKey:r.business_key,
      summary:{backfilled:true,before:r.balance-r.delta,after:r.balance,spec:r.spec,reason:r.reason}})
  }
  const cancelMap:Record<string,AuditAction>={'approve':'cancel.approve','auto-approve':'cancel.auto_approve','reject-and-ship':'order.reject_and_ship'}
  for(const r of db.all<{actor_id:string|null;action:string;request_key:string;request_body:string;order_id:string;created:number}>('SELECT * FROM order_cancel_actions ORDER BY created,id')){
    const action=cancelMap[r.action];if(!action)continue
    const body=JSON.parse(r.request_body) as {reason?:string}
    appendAudit(db,{created:r.created,actor:actor(r.actor_id),action,targetType:'order',targetId:r.order_id,orderId:r.order_id,requestKey:r.request_key,summary:{backfilled:true,...(body.reason?{reason:body.reason}:{})}})
  }
  for(const r of db.all<{id:string;shipped_at:number}>("SELECT id,shipped_at FROM orders o WHERE shipped_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM order_cancel_actions a WHERE a.order_id=o.id AND a.action='reject-and-ship')")){
    appendAudit(db,{created:r.shipped_at,action:'order.ship',targetType:'order',targetId:r.id,orderId:r.id,summary:{backfilled:true,note:'历史数据，未记录操作人'}})
  }
  const saleMap:Record<string,AuditAction>={approve:'aftersale.approve',reject:'aftersale.reject',inspect:'aftersale.inspect','refund-reject':'aftersale.refund_reject','auto-approve':'aftersale.auto_approve',close:'aftersale.auto_close','auto-refund':'aftersale.auto_refund'}
  for(const r of db.all<{actor_id:string|null;action:string;request_key:string;request_body:string;after_sale_id:string;order_id:string;created:number}>('SELECT a.*,s.order_id FROM after_sale_actions a JOIN after_sales s ON s.id=a.after_sale_id ORDER BY a.created,a.id')){
    const action=saleMap[r.action];if(!action)continue
    const body=JSON.parse(r.request_body) as {reason?:string;items?:{skuId:string;restockCount:number}[]}
    const summary:AuditSummary={backfilled:true,...(body.reason?{reason:body.reason}:{})}
    if(body.items)summary.items=body.items.map(i=>({...i,spec:db.one<{spec:string}>('SELECT spec FROM order_items WHERE order_id=? AND sku_id=?',r.order_id,i.skuId)!.spec}))
    appendAudit(db,{created:r.created,actor:actor(r.actor_id),action,targetType:'after_sale',targetId:r.after_sale_id,orderId:r.order_id,requestKey:r.request_key,summary})
  }
  for(const r of db.all<{merchant_id:string;request_key:string;created:number;refund_id:string;order_id:string}>('SELECT a.*,p.order_id FROM refund_retry_actions a JOIN refunds r ON r.id=a.refund_id JOIN payments p ON p.id=r.payment_id'))
    appendAudit(db,{created:r.created,actor:actor(r.merchant_id),action:'refund.retry',targetType:'refund',targetId:r.refund_id,orderId:r.order_id,requestKey:r.request_key,summary:{backfilled:true}})
  for(const r of db.all<{merchant_id:string;request_key:string;created:number;payment_id:string;order_id:string;outcome:string;reason:string}>('SELECT a.*,p.order_id FROM payment_review_resolutions a JOIN payments p ON p.id=a.payment_id'))
    appendAudit(db,{created:r.created,actor:actor(r.merchant_id),action:'payment.review',targetType:'payment',targetId:r.payment_id,orderId:r.order_id,requestKey:r.request_key,summary:{backfilled:true,outcome:r.outcome,reason:r.reason}})
}
