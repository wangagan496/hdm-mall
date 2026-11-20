import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Database } from './database.ts'
import type { PromiseSnapshot } from './promises/generated.ts'
import { ensure } from './errors.ts'
import { checkPublicContent } from './content-filter.ts'

const score = z.number().int().min(1).max(5)
const itemSchema = z.strictObject({ skuId: z.string().min(1), fieldId: z.string().min(1),
  result: z.enum(['matches','mismatch','unnoticed']), note: z.string().trim().max(160).default('') })
export const evaluationSchema = z.strictObject({ score: score.optional(), productScore: score.optional(),
  logisticsScore: score.nullish(), serviceScore: score.nullish(), content: z.string().trim().min(5).max(500),
  revision: z.number().int().positive().optional(), items: z.array(itemSchema).default([]) })
  .refine(v => (v.productScore ?? v.score) !== undefined && (v.productScore === undefined || v.score === undefined || v.productScore === v.score))
export type EvaluationInput = z.infer<typeof evaluationSchema>
interface EvaluationRow {
  public_id: string; score: number; content: string; created: number; updated: number; revision: number;
  logistics_score: number | null; service_score: number | null; service_occurred: number
}
export function evaluationItems(db: Database, id: string, sku?: string) {
  return db.all<{skuId:string;fieldId:string;templateVersion:string;label:string;quote:string;value:string|null;result:string;note:string}>(
    `SELECT sku_id skuId,field_id fieldId,template_version templateVersion,label,quote,value,result,note
     FROM evaluation_items WHERE order_id=? ${sku ? 'AND sku_id=?' : ''} ORDER BY sku_id,field_id`, id, ...(sku ? [sku] : []))
}
export function buyerEvaluation(db: Database, id: string) {
  const row = db.one<EvaluationRow>('SELECT * FROM evaluations WHERE order_id=?', id)
  if (!row) return null
  return { orderId:id, score:row.score, productScore:row.score, logisticsScore:row.logistics_score, serviceScore:row.service_score,
    serviceOccurred:!!row.service_occurred, content:row.content, createdAt:row.created, updated:row.updated, revision:row.revision,
    items:evaluationItems(db,id), history:db.all<{snapshot:string}>('SELECT snapshot FROM evaluation_revisions WHERE order_id=? ORDER BY revision',id)
      .map(r=>JSON.parse(r.snapshot)), hiddenReason:db.one<{reason:string}>('SELECT reason FROM review_moderation WHERE order_id=?',id)?.reason ?? null }
}
export function saveEvaluation(db: Database, id: string, input: EvaluationInput, now: number) {
  checkPublicContent(input.content)
  const previous = buyerEvaluation(db,id)
  if (previous) {
    ensure(previous.revision === input.revision || (previous.hiddenReason && !input.revision), 409, '订单已评价，请刷新后主动改评')
    ensure(!previous.hiddenReason || previous.content !== input.content,409,'请修改评价内容后再发布')
  } else ensure(input.revision === undefined,409,'原评价不存在，请刷新')
  const sale = !!db.one('SELECT 1 FROM after_sales WHERE order_id=?',id)
  ensure(input.serviceScore == null || sale,400,'未发生售后，无需给售后打分')
  const choices = new Map(input.items.map(item=>[JSON.stringify([item.skuId,item.fieldId]),item]))
  ensure(choices.size === input.items.length,400,'承诺条目不能重复')
  const fields = []
  for (const row of db.all<{sku_id:string;snapshot:string}>('SELECT sku_id,snapshot FROM order_item_promise_snapshots WHERE order_id=?',id)) {
    const snapshot: PromiseSnapshot = JSON.parse(row.snapshot)
    for (const field of snapshot.entries.filter(field=>field.status==='known')) {
      const key = JSON.stringify([row.sku_id,field.fieldId])
      const choice = choices.get(key)
      ensure(choice,400,'请逐条选择符合、不符或没注意')
      checkPublicContent(choice.note)
      fields.push({choice, field, snapshot})
      choices.delete(key)
    }
  }
  ensure(choices.size===0,400,'条目不属于此订单规格的冻结承诺')
  if (previous) {
    const {history, ...original} = previous
    db.run('INSERT INTO evaluation_revisions VALUES(?,?,?)',id,previous.revision,JSON.stringify(original))
    db.run('DELETE FROM evaluation_items WHERE order_id=?',id)
    db.run('DELETE FROM review_moderation WHERE order_id=?',id)
  }
  const product = (input.productScore ?? input.score)!
  db.run(`INSERT INTO evaluations(order_id,score,content,created,product_score,logistics_score,service_score,updated,revision,public_id,service_occurred)
    VALUES(?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(order_id) DO UPDATE SET score=excluded.score,product_score=excluded.product_score,
    content=excluded.content,logistics_score=excluded.logistics_score,service_score=excluded.service_score,
    service_occurred=excluded.service_occurred,updated=excluded.updated,revision=evaluations.revision+1`,
    id,product,input.content,now,product,input.logisticsScore??null,input.serviceScore??null,now,randomUUID(),Number(sale))
  for (const {choice,field,snapshot} of fields) {
    db.run('INSERT INTO evaluation_items VALUES(?,?,?,?,?,?,?,?,?,?)',id,choice.skuId,choice.fieldId,snapshot.templateVersion,
      snapshot.receiptId,field.label,field.value,field.quote??'',choice.result,choice.note)
  }
  db.run('UPDATE orders SET state=5 WHERE id=? AND state=4',id)
  return { id }
}
