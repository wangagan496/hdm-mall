import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Database } from './database.ts'
import { requireBuyer, restrictOwnStore, type User } from './accounts.ts'
import type { PromiseSnapshot } from './promises/generated.ts'
import { ensure } from './errors.ts'
import { checkPublicContent } from './content-filter.ts'
import { partyDispute } from './review-disputes.ts'

const score = z.number().int().min(1).max(5)
const sizeFit = z.enum(['larger','true','smaller'])
const sizeShift = z.enum(['half','full']).optional()
const sizeChoice = z.strictObject({skuId:z.string().min(1),sizeFit,sizeShift})
const itemSchema = z.strictObject({ skuId: z.string().min(1), fieldId: z.string().min(1),
  result: z.enum(['matches','mismatch','unnoticed']), note: z.string().trim().max(160).default('') })
export const evaluationSchema = z.strictObject({ score: score.optional(), productScore: score.optional(),
  sizeFit:sizeFit.optional(), sizeShift, sizes:z.array(sizeChoice).optional(),
  logisticsScore: score.nullish(), serviceScore: score.nullish(), content: z.string().trim().min(5).max(500),
  revision: z.number().int().positive().optional(), items: z.array(itemSchema).default([]) })
  .refine(v => (v.productScore ?? v.score) !== undefined && (v.productScore === undefined || v.score === undefined || v.productScore === v.score))
export type EvaluationInput = z.infer<typeof evaluationSchema>
export const followupSchema = z.strictObject({
  content: z.string().trim().refine(s => Array.from(s).length >= 5 && Array.from(s).length <= 300, '请填写5至300字的处理后感受')
})
const endedAfterSaleStates = "'refunded','completed','closed','rejected','refund-rejected'"
const activeAfterSaleStates = "'pending','awaiting-return','returned','refunding'"
// 阶段 6 案件接入前，处理记录关联位一律返回待接入与空列表，不读取或透出预留表中的任何残留行。
export function evaluationServiceRecord(_db: Database, _orderId: string) {
  return {
    status: 'pending' as const,
    connected: false,
    label: '处理记录待接入',
    records: [] as { id: string; source: string; summary: string; createdAt: number }[]
  }
}
export function followupEligibility(db: Database, orderId: string): { allowed: boolean; reason: string } {
  if (!db.one('SELECT 1 FROM evaluations WHERE order_id=?', orderId)) {
    return { allowed: false, reason: '请先评价订单后再追加处理后感受' }
  }
  if (db.one('SELECT 1 FROM evaluation_followups WHERE order_id=?', orderId)) {
    return { allowed: false, reason: '每条评价只能追加一次处理后感受' }
  }
  if (db.one(`SELECT 1 FROM after_sales WHERE order_id=? AND state IN (${activeAfterSaleStates})`, orderId)) {
    return { allowed: false, reason: '当前售后尚未结束，结束后再追加处理后感受' }
  }
  if (!db.one(`SELECT 1 FROM after_sales WHERE order_id=? AND state IN (${endedAfterSaleStates})`, orderId)) {
    return { allowed: false, reason: '仅售后已退款、已关闭或已拒绝的订单可追加处理后感受' }
  }
  if (db.one(`SELECT 1 FROM refunds r JOIN payments p ON p.id=r.payment_id LEFT JOIN after_sales a ON a.id=r.after_sale_id
    WHERE (p.order_id=? OR a.order_id=?) AND r.state<>'succeeded'`, orderId, orderId)) {
    return { allowed: false, reason: '售后或运费退款尚未全部到账，请待退款结清后再追加' }
  }
  return { allowed: true, reason: '' }
}
export function requiredEvaluationSizes(db:Database,id:string) {
  return db.all<{sku_id:string}>('SELECT sku_id FROM required_evaluation_sizes WHERE order_id=?',id).map(row=>row.sku_id)
}
interface EvaluationRow {
  public_id: string; score: number; content: string; created: number; updated: number; revision: number;
  logistics_score: number | null; service_score: number | null; service_occurred: number
}
export function evaluationItems(db: Database, id: string, sku?: string) {
  return db.all<{skuId:string;fieldId:string;templateVersion:string;label:string;quote:string;value:string|null;result:string;note:string}>(
    `SELECT sku_id skuId,field_id fieldId,template_version templateVersion,label,quote,value,result,note
     FROM evaluation_items WHERE order_id=? ${sku ? 'AND sku_id=?' : ''} ORDER BY sku_id,field_id`, id, ...(sku ? [sku] : []))
}
export function buyerEvaluation(db: Database, id: string, includeDispute=false) {
  const row = db.one<EvaluationRow>('SELECT * FROM evaluations WHERE order_id=?', id)
  if (!row) return null
  const moderation=db.one<{reason:string;source:'platform'|'content'}>(`SELECT m.reason,
    CASE WHEN EXISTS(SELECT 1 FROM review_dispute_actions a JOIN review_dispute_conclusions c ON c.action_id=a.id
      WHERE a.review_id=? AND c.kind='hide' AND a.actor_id=m.hidden_by AND a.created=m.hidden_at)
    THEN 'platform' ELSE 'content' END source FROM review_moderation m WHERE m.order_id=?`,row.public_id,id)
  const followupRow = db.one<{ content: string; created: number }>('SELECT content, created FROM evaluation_followups WHERE order_id=?', id)
  return { orderId:id, score:row.score, productScore:row.score, logisticsScore:row.logistics_score, serviceScore:row.service_score,
    ...(includeDispute ? {dispute:partyDispute(db,row.public_id,'buyer')} : {}),
    serviceOccurred:!!row.service_occurred, content:row.content, createdAt:row.created, updated:row.updated, revision:row.revision,
    sizes:db.all<{skuId:string;sizeFit:string;sizeShift:string|null}>('SELECT sku_id skuId,size_fit sizeFit,size_shift sizeShift FROM evaluation_sizes WHERE order_id=? ORDER BY sku_id',id),
    items:evaluationItems(db,id), history:db.all<{snapshot:string}>('SELECT snapshot FROM evaluation_revisions WHERE order_id=? ORDER BY revision',id)
      .map(r=>JSON.parse(r.snapshot)), hiddenReason:moderation?.reason ?? null, hiddenSource:moderation?.source ?? null,
    followup: followupRow ? { content: followupRow.content, createdAt: followupRow.created } : null,
    canFollowup: followupEligibility(db, id).allowed,
    serviceRecord: evaluationServiceRecord(db, id) }
}
export function saveEvaluation(db: Database, id: string, input: EvaluationInput, now: number) {
  checkPublicContent(input.content)
  ensure(!db.one('SELECT 1 FROM evaluation_followups WHERE order_id=?', id), 409, '已追加处理后感受，原评价不可修改')
  const previous = buyerEvaluation(db,id)
  if (previous) {
    ensure(previous.hiddenSource!=='platform',403,'已被平台复核隐藏，可请求更正')
    ensure(previous.revision === input.revision || (previous.hiddenReason && !input.revision), 409, '订单已评价，请刷新后主动改评')
    ensure(!previous.hiddenReason || previous.content !== input.content,409,'请修改评价内容后再发布')
  } else ensure(input.revision === undefined,409,'原评价不存在，请刷新')
  const sale = !!db.one('SELECT 1 FROM after_sales WHERE order_id=?',id)
  const required = requiredEvaluationSizes(db,id)
  let sizes = input.sizes ?? []
  if(input.sizeFit !== undefined || input.sizeShift !== undefined) {
    ensure(!input.sizes && required.length===1 && input.sizeFit,400,'请按订单规格填写尺码反馈')
    sizes=[{skuId:required[0]!,sizeFit:input.sizeFit,sizeShift:input.sizeShift}]
  }
  ensure(sizes.length===required.length && required.every(sku=>sizes.some(choice=>choice.skuId===sku)),400,'请为有尺码承诺的订单项选择尺码合不合适')
  ensure(sizes.every(choice=>choice.sizeFit!=='true' || !choice.sizeShift),400,'尺码合适时无需填写偏差幅度')
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
  db.run('DELETE FROM evaluation_sizes WHERE order_id=?',id)
  for(const entry of sizes) db.run('INSERT INTO evaluation_sizes VALUES(?,?,?,?)',id,entry.skuId,entry.sizeFit,entry.sizeShift??null)
  const single = sizes.length===1 ? sizes[0] : undefined
  db.run('UPDATE evaluations SET size_fit=?,size_shift=? WHERE order_id=?',single?.sizeFit??null,single?.sizeShift??null,id)
  db.run('UPDATE orders SET state=5 WHERE id=? AND state=4',id)
  return { id }
}

function containsContactOrPrivateInfo(content: string, orderId: string, ownerId: string, account: string, addressJson: string) {
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(content)) return true
  if (/(?<!\d)(?:\+?86[- ]?)?1[3-9](?:[- ]?\d){9}(?!\d)/.test(content)) return true
  const address = JSON.parse(addressJson) as Record<string, unknown>
  const privateTokens = [orderId, ownerId, account, address.contact, address.receiver, address.address, address.fullLocation]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  return privateTokens.some(token => content.includes(token))
}

export function saveFollowup(db: Database, user: User, id: string, input: unknown, now: number) {
  requireBuyer(user)
  const parsed = followupSchema.safeParse(input)
  ensure(parsed.success, 400, '请填写5至300字的处理后感受')
  const { content } = parsed.data
  checkPublicContent(content)
  return db.transaction(() => {
    const order = db.one<{ id: string; owner_id: string; address: string }>('SELECT id, owner_id, address FROM orders WHERE id=?', id)
    ensure(order, 404, '订单不存在')
    ensure(order.owner_id === user.id, 403, '只有下单人可以追加处理后感受')
    restrictOwnStore(db, user.id)
    ensure(!containsContactOrPrivateInfo(content, order.id, order.owner_id, user.account, order.address), 400, '追加内容中请勿包含电话、邮箱或个人联系方式')
    const eligibility = followupEligibility(db, id)
    ensure(eligibility.allowed, 409, eligibility.reason)
    db.run('INSERT INTO evaluation_followups(order_id, actor_id, content, created) VALUES(?,?,?,?)', id, user.id, content, now)
    return { orderId: id, followup: { content, createdAt: now } }
  })
}
