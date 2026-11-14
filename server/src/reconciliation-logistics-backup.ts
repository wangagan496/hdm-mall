import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { billDateSchema,billRowSchema } from './channel-bill.ts'
import { shipmentSchema,logisticsEventSchema } from './logistics.ts'
import { auditText } from './audit.ts'

const ranks:Record<string,number>={waiting:0,collected:1,transit:2,delivering:3,signed:4}
const summarySchema=z.object({date:billDateSchema,paymentCount:z.number().int().nonnegative(),paymentAmountCents:z.number().int().nonnegative().safe(),
 refundCount:z.number().int().nonnegative(),refundAmountCents:z.number().int().nonnegative().safe(),localCount:z.number().int().nonnegative(),
 channelCount:z.number().int().nonnegative(),checkedAt:z.number().int().nonnegative().safe()}).strict()
export function inspectReconciliationLogistics(db:DatabaseSync){
 for(const table of ['payments','refunds']){
  const column=table==='payments'?'channel_transaction_id':'channel_refund_id'
  for(const row of db.prepare(`SELECT ${column} id FROM ${table} WHERE ${column} IS NOT NULL`).iterate())z.string().min(1).max(120).parse(row.id)
  if(db.prepare(`SELECT ${column} FROM ${table} WHERE ${column} IS NOT NULL GROUP BY ${column} HAVING COUNT(*)>1`).get())throw new Error('渠道编号重复')
 }
 for(const row of db.prepare('SELECT kind,business_id businessId,channel_id channelId,amount amountCents,state,occurred_at occurredAt FROM mock_channel_bill').iterate())billRowSchema.parse(row)
 for(const run of db.prepare('SELECT * FROM reconciliation_runs').iterate()){
  billDateSchema.parse(run.date)
  const summary=JSON.parse(String(run.summary))
  if(run.state==='completed'||Object.keys(summary).length){summarySchema.parse(summary);if(summary.date!==run.date)throw new Error('对账日期不一致')}
  if((run.state==='failed')!==(run.next_retry_at!==null))throw new Error('对账重试状态无效')
 }
 for(const diff of db.prepare('SELECT d.*,u.role FROM reconciliation_differences d LEFT JOIN users u ON u.id=d.handled_by').iterate()){
  const snapshot=JSON.parse(String(diff.snapshot))
  const local=snapshot.local,channel=snapshot.channel
  if(channel)billRowSchema.parse(channel)
  if(local)z.object({kind:z.enum(['payment','refund']),businessId:z.string().min(1),channelId:z.string().nullable(),amountCents:z.number().int().positive(),
    state:z.enum(['pending','succeeded','failed']),orderAmount:z.number().int().positive(),orderConsistent:z.union([z.literal(0),z.literal(1)])}).strict().parse(local)
  for(const row of [local,channel])if(row&&(row.kind!==diff.kind||row.businessId!==diff.business_id))throw new Error('对账快照业务编号不一致')
  const valid=diff.category==='channel-only'?!local&&!!channel:diff.category==='local-only'?!!local&&!channel:diff.category==='amount'?
    !!local&&!!channel&&(local.amountCents!==channel.amountCents||local.amountCents!==local.orderAmount):
    !!local&&!!channel&&(local.state!==channel.state||!local.orderConsistent||local.channelId!==null&&local.channelId!==channel.channelId)
  if(!valid)throw new Error('对账差异快照无效')
  if(diff.state==='resolved'){
    z.string().trim().min(5).max(200).parse(diff.reason)
    if(diff.role!=='merchant')throw new Error('对账处理人无效')
    const audit=db.prepare("SELECT summary FROM audit_log WHERE action='reconciliation.resolve' AND target_id=? AND actor_id=? AND created=? ORDER BY id DESC LIMIT 1").get(diff.id!,diff.handled_by!,diff.handled_at!)
    if(!audit||JSON.parse(String(audit.summary)).reason!==auditText(String(diff.reason)))throw new Error('对账处理审计不一致')
  }
 }
 for(const order of db.prepare('SELECT id,signed_at FROM orders WHERE signed_at IS NOT NULL').iterate()){
  if(!db.prepare('SELECT order_id FROM shipments WHERE order_id=?').get(order.id!))throw new Error('签收时间缺少物流记录')
 }
 for(const shipment of db.prepare('SELECT s.*,o.shipped_at,o.signed_at,o.state order_state FROM shipments s JOIN orders o ON o.id=s.order_id').iterate()){
  shipmentSchema.parse({carrier:shipment.carrier,trackingNo:shipment.tracking_no})
  if(shipment.created!==shipment.shipped_at||![3,4,5].includes(Number(shipment.order_state)))throw new Error('发货时间或订单状态不一致')
  let state='waiting',signed:number|null=null
  for(const row of db.prepare('SELECT id,state,occurred_at occurredAt,description FROM logistics_events WHERE order_id=? ORDER BY occurred_at,id').iterate(shipment.order_id!)){
   const event=logisticsEventSchema.parse(row)
   if(event.occurredAt<Number(shipment.created))throw new Error('物流事件早于发货时间')
   if(ranks[event.state]!>ranks[state]!)state=event.state
   if(event.state==='signed')signed=signed===null?event.occurredAt:Math.min(signed,event.occurredAt)
  }
  if(signed!==shipment.signed_at)throw new Error('签收时间与物流事件不一致')
  if(state!==shipment.state)throw new Error('物流状态与轨迹不一致')
 }
}
