import type { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { auditActions, auditText } from './audit.ts'

const text=z.string().refine(s=>auditText(s)===s)
const value=z.union([text,z.number().int().safe(),z.boolean()])
const summarySchema=z.object({before:value.optional(),after:value.optional(),spec:text.optional(),name:text.optional(),
  descriptionChanged:z.boolean().optional(),pictureChanged:z.boolean().optional(),reason:text.optional(),amountCents:z.number().int().positive().safe().optional(),payerId:z.string().optional(),
  outcome:z.enum(['success','fail','review','paid','unpaid']).optional(),items:z.array(z.object({skuId:z.string(),spec:text,restockCount:z.number().int().nonnegative()}).strict()).optional(),
  interface:z.string().regex(/^(GET|POST|PUT|DELETE) \/merchant\/[A-Za-z0-9/:_-]+$/).optional(),backfilled:z.literal(true).optional(),note:text.optional()}).strict()
export function inspectAudit(db:DatabaseSync){
  const version=Number(db.prepare('PRAGMA user_version').get()!.user_version)
  const migration=readFileSync(new URL('./migrations/014-audit-log.sql',import.meta.url),'utf8')
  const normalize=(s:string)=>s.replace(/\s+/g,' ').trim().replace(/;$/,'')
  for(const name of ['audit_log_no_update','audit_log_no_delete']){
    const expected=migration.match(new RegExp('CREATE TRIGGER '+name+'[^]*?END;'))?.[0]
    const actual=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=? AND tbl_name='audit_log'").get(name)?.sql
    if(!expected||!actual||normalize(String(actual))!==normalize(expected))throw new Error('审计只追加保护无效')
  }
  for(const r of db.prepare('SELECT a.*,u.role FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id').iterate()){
    const action=String(r.action)
    if(!auditActions.includes(action as typeof auditActions[number])||(version<15&&action==='product.return_policy'))throw new Error('审计操作类型无效')
    if((r.actor_kind==='system')!==(r.actor_id===null)||(r.actor_id!==null&&r.actor_kind!==r.role))throw new Error('审计操作人无效')
    if((action==='access.denied')!==(r.result==='denied'))throw new Error('审计结果无效')
    const summary=summarySchema.parse(JSON.parse(String(r.summary)))
    if(summary.payerId&&!db.prepare('SELECT id FROM users WHERE id=?').get(summary.payerId))throw new Error('审计退款对象无效')
    const type=action.startsWith('product.')?'product':action.startsWith('sku.')||action==='stock.adjust'?'sku':action.startsWith('order.')||action.startsWith('cancel.')?'order':action.startsWith('aftersale.')?'after_sale':action.startsWith('refund.')?'refund':action==='payment.review'?'payment':'settings'
    if(r.target_type!==type)throw new Error('审计对象类型无效')
    const table={product:'products',sku:'skus',order:'orders',after_sale:'after_sales',refund:'refunds',payment:'payments',settings:null}[type]
    if(table&&!db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(r.target_id!))throw new Error('审计对象不存在')
  }
}
