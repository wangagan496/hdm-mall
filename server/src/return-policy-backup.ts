import type { DatabaseSync } from 'node:sqlite'
import { presentPolicy, returnPolicySchema, requiresCondition, canReturnNoReason, type PolicyRow } from './return-policy.ts'
export function inspectReturnPolicy(db:DatabaseSync){
 for(const table of ['products','order_items']){
  for(const row of db.prepare(`SELECT * FROM ${table}`).iterate()){
   returnPolicySchema.parse(presentPolicy(row as unknown as PolicyRow))
   if(table==='order_items'&&(![0,1].includes(Number(row.return_policy_confirmed))||(row.return_policy_confirmed===1&&row.return_policy!=='confirm-required')))throw new Error('退货确认快照无效')
  }
 }
 for(const row of db.prepare('SELECT i.*,s.kind,a.condition_declared FROM after_sale_items a JOIN after_sales s ON s.id=a.after_sale_id JOIN order_items i ON i.order_id=s.order_id AND i.sku_id=a.sku_id').iterate()){
  const item=row as unknown as PolicyRow
  if(row.condition_declared!==null&&!['sealed','unsealed'].includes(String(row.condition_declared)))throw new Error('售后商品状态声明无效')
  if(row.kind==='return-no-reason'&&(!canReturnNoReason(item)||requiresCondition(item)&&row.condition_declared!=='sealed'))throw new Error('售后申请与退货快照不符')
 }
}
