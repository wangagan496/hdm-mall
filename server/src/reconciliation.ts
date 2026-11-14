import type { Database } from './database.ts'
import type { Clock } from './clock.ts'
import type { User } from './accounts.ts'
import type { PaymentChannel } from './payment-channel.ts'
import { beijingDate, billDateSchema, billDay, billRowSchema, type BillRow } from './channel-bill.ts'
import { ensure } from './errors.ts'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { appendAudit } from './audit.ts'

type Category = 'channel-only' | 'local-only' | 'amount' | 'state'
interface LocalRow { kind: 'payment'|'refund'; businessId: string; channelId: string|null; amountCents: number; state: string; orderAmount: number; orderConsistent: number }
interface Difference { kind: string; businessId: string; category: Category; description: string; snapshot: string }
const reasonSchema = z.object({ reason: z.string().trim().min(5).max(200) }).strict()
const stateName = (row: {kind: string; state: string}) => row.state === 'succeeded' ? row.kind === 'payment' ? '已支付' : '已退款' :
  row.state === 'pending' ? row.kind === 'payment' ? '支付确认中' : '退款中' : row.kind === 'payment' ? '支付未成功' : '退款失败重试中'
const money = (amount: number) => '¥' + (amount / 100).toFixed(2)

export class Reconciliation {
  private db: Database
  private clock: Clock
  private channel?: PaymentChannel
  private running = new Map<string,Promise<ReturnType<Reconciliation['readReport']>>>()
  private scanning?: Promise<{failed:string[]}>
  private stopped = false
  constructor(db: Database, clock: Clock, channel?: PaymentChannel) { this.db = db; this.clock = clock; this.channel = channel }

  async bill(user: User, date: string) { ensure(user.role === 'merchant', 403, '需要商家权限'); return this.readBill(date) }
  private async readBill(date: string) {
    billDateSchema.parse(date)
    ensure(this.channel?.exportBill, 503, '支付渠道暂不支持对账账单')
    const rows = (await this.channel.exportBill(date)).map(row => billRowSchema.parse(row))
    const { start, end } = billDay(date)
    ensure(rows.every(row => row.occurredAt >= start && row.occurredAt < end), 502, '渠道账单日期不符')
    ensure(new Set(rows.map(row => row.kind + ':' + row.businessId)).size === rows.length, 502, '渠道账单包含重复业务编号')
    return rows
  }
  async run(user: User, date: string) {
    ensure(user.role === 'merchant', 403, '需要商家权限')
    return this.runDate(date)
  }
  private runDate(date:string) {
    billDateSchema.parse(date)
    ensure(!this.stopped,503,'对账服务正在关闭')
    const existing = this.running.get(date)
    if (existing) return existing
    const task = Promise.resolve().then(() => this.perform(date)).catch(error => {
      this.db.run(`INSERT INTO reconciliation_runs(date,state,checked_at,next_retry_at,summary) VALUES(?,'failed',?,?,'{}')
        ON CONFLICT(date) DO UPDATE SET state='failed',next_retry_at=excluded.next_retry_at`,date,this.clock.now(),this.clock.now()+30_000)
      throw error
    }).finally(() => this.running.delete(date))
    this.running.set(date,task)
    return task
  }
  private async perform(date:string) {
    const rows = await this.readBill(date)
    const payments = rows.filter(row => row.kind === 'payment' && row.state === 'succeeded')
    const refunds = rows.filter(row => row.kind === 'refund' && row.state === 'succeeded')
    const local = this.localRows(date), differences = this.compare(local, rows)
    const summary = { date, paymentCount: payments.length, paymentAmountCents: payments.reduce((sum,row) => sum + row.amountCents, 0),
      refundCount: refunds.length, refundAmountCents: refunds.reduce((sum,row) => sum + row.amountCents, 0),
      localCount: local.length, channelCount: rows.length, checkedAt: this.clock.now() }
    this.db.transaction(() => {
      this.db.run(`INSERT INTO reconciliation_runs(date,state,checked_at,next_retry_at,summary) VALUES(?,'completed',?,NULL,?)
        ON CONFLICT(date) DO UPDATE SET state='completed',checked_at=excluded.checked_at,next_retry_at=NULL,summary=excluded.summary`, date, this.clock.now(), JSON.stringify(summary))
      this.db.run('UPDATE reconciliation_differences SET active=0 WHERE date=?', date)
      for (const diff of differences) {
        const old = this.db.one<{id:string;snapshot:string}>('SELECT id,snapshot FROM reconciliation_differences WHERE date=? AND kind=? AND business_id=? AND category=?', date,diff.kind,diff.businessId,diff.category)
        if (!old) this.db.run(`INSERT INTO reconciliation_differences(id,date,kind,business_id,category,description,snapshot,active,state)
          VALUES(?,?,?,?,?,?,?,1,'pending')`, randomUUID(),date,diff.kind,diff.businessId,diff.category,diff.description,diff.snapshot)
        else if (old.snapshot === diff.snapshot) this.db.run('UPDATE reconciliation_differences SET active=1 WHERE id=?',old.id)
        else this.db.run("UPDATE reconciliation_differences SET active=1,description=?,snapshot=?,state='pending',reason=NULL,handled_by=NULL,handled_at=NULL WHERE id=?",diff.description,diff.snapshot,old.id)
      }
    })
    return this.readReport(date)
  }

  scan() {
    if (this.scanning) return this.scanning
    this.scanning = this.scanDays().finally(() => { this.scanning = undefined })
    return this.scanning
  }
  private async scanDays() {
    const failed:string[] = []
    if (this.stopped || !this.channel?.exportBill) return {failed}
    const yesterday = beijingDate(this.clock.now()-86400_000)
    const retry = this.db.all<{date:string}>("SELECT date FROM reconciliation_runs WHERE state='failed' AND next_retry_at<=?",this.clock.now()).map(row=>row.date)
    const previous = this.db.one<{state:string;next_retry_at:number|null}>('SELECT state,next_retry_at FROM reconciliation_runs WHERE date=?',yesterday)
    const dates = new Set([...retry,...(!previous || previous.state==='failed' && (previous.next_retry_at??0)<=this.clock.now() ? [yesterday] : [])])
    for (const date of dates) { try { await this.runDate(date) } catch { failed.push(date) } }
    return {failed}
  }
  async stop() {
    this.stopped = true
    await this.scanning
    await Promise.allSettled([...this.running.values()])
  }

  private localRows(date: string) {
    const { start,end } = billDay(date)
    return this.db.all<LocalRow>(`SELECT 'payment' kind,p.id businessId,p.channel_transaction_id channelId,p.amount amountCents,
      CASE WHEN p.state='closed' THEN CASE WHEN p.next_query_at IS NULL THEN 'failed' ELSE 'pending' END ELSE p.state END state,
      o.amount orderAmount,CASE WHEN p.state<>'succeeded' OR EXISTS(SELECT 1 FROM refunds r WHERE r.payment_id=p.id AND r.reason IN ('late','duplicate','cancelled')) OR
        (o.paid_by=p.payer_id AND o.paid_at=p.channel_paid_at AND o.state>=2) THEN 1 ELSE 0 END orderConsistent
      FROM payments p JOIN orders o ON o.id=p.order_id WHERE COALESCE(p.channel_paid_at,p.created)>=? AND COALESCE(p.channel_paid_at,p.created)<?
      UNION ALL
      SELECT 'refund',r.id,r.channel_refund_id,r.amount,r.state,r.amount,CASE WHEN p.state='succeeded' THEN 1 ELSE 0 END
      FROM refunds r JOIN payments p ON p.id=r.payment_id JOIN orders o ON o.id=p.order_id
      WHERE COALESCE(r.completed_at,r.created)>=? AND COALESCE(r.completed_at,r.created)<?`,start,end,start,end)
  }

  private compare(local: LocalRow[], bill: BillRow[]) {
    const result: Difference[] = [], key = (row:{kind:string;businessId:string}) => row.kind + ':' + row.businessId
    const locals = new Map(local.map(row => [key(row),row])), bills = new Map(bill.map(row => [key(row),row]))
    for (const id of new Set([...locals.keys(),...bills.keys()])) {
      const l = locals.get(id), c = bills.get(id), row = (l ?? c)!
      const add = (category:Category,description:string) => result.push({kind:row.kind,businessId:row.businessId,category,description,
        snapshot:JSON.stringify({local:l??null,channel:c??null})})
      if (!l) { add('channel-only',`渠道有一笔${stateName(c!)} ${money(c!.amountCents)}，系统未找到对应记录`); continue }
      if (!c) { add('local-only',`系统有一笔${stateName(l)} ${money(l.amountCents)}，渠道当日账单没有这笔记录`); continue }
      if (l.amountCents !== c.amountCents || l.amountCents !== l.orderAmount) add('amount',`渠道金额 ${money(c.amountCents)}，系统金额 ${money(l.amountCents)}${l.amountCents !== l.orderAmount ? '，订单金额 ' + money(l.orderAmount) : ''}`)
      if (l.state !== c.state || !l.orderConsistent || (l.channelId !== null && l.channelId !== c.channelId)) add('state',
        `渠道显示${stateName(c)} ${money(c.amountCents)}，系统里是${stateName(l)}${!l.orderConsistent ? '，订单与支付记录不一致' : ''}${l.channelId !== null && l.channelId !== c.channelId ? '，渠道编号不一致' : ''}`)
    }
    return result
  }

  report(user: User, date: string) {
    ensure(user.role === 'merchant',403,'需要商家权限'); billDateSchema.parse(date)
    return this.readReport(date)
  }
  private readReport(date:string) {
    const run = this.db.one<{state:string;summary:string}>('SELECT state,summary FROM reconciliation_runs WHERE date=?',date)
    const differences = this.db.all<{id:string;state:string}>(`SELECT d.id,d.kind,d.business_id businessId,d.category,d.description,d.state,d.reason,
      d.handled_at handledAt,CASE WHEN u.status='deleted' THEN '已注销用户' ELSE u.account END handlerAccount
      FROM reconciliation_differences d LEFT JOIN users u ON u.id=d.handled_by WHERE d.date=? AND d.active=1 ORDER BY d.category,d.kind,d.business_id`,date)
    return {date,paymentCount:0,paymentAmountCents:0,refundCount:0,refundAmountCents:0,localCount:0,channelCount:0,checkedAt:null,
      ...(run ? JSON.parse(run.summary) : {}),state:run?.state??'not-started',differenceCount:differences.length,
      pendingCount:differences.filter(row=>row.state==='pending').length,differences}
  }

  resolve(user: User, id: string, input: unknown) {
    ensure(user.role==='merchant',403,'需要商家权限')
    const {reason} = reasonSchema.parse(input)
    return this.db.transaction(() => {
      const row = this.db.one<{state:string;reason:string;date:string}>('SELECT state,reason,date FROM reconciliation_differences WHERE id=? AND active=1',id)
      ensure(row,404,'对账差异不存在')
      if (row.state === 'resolved') { ensure(row.reason===reason,409,'这条差异已经处理，不能覆盖原原因'); return {id,state:'resolved'} }
      const now=this.clock.now()
      this.db.run("UPDATE reconciliation_differences SET state='resolved',reason=?,handled_by=?,handled_at=? WHERE id=?",reason,user.id,now,id)
      appendAudit(this.db,{created:now,actor:user,action:'reconciliation.resolve',targetType:'settings',targetId:id,summary:{reason,note:row.date}})
      return {id,state:'resolved'}
    })
  }
}
