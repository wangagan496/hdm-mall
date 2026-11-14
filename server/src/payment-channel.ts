import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Database } from './database.ts'
import { systemClock, type Clock } from './clock.ts'
import { billDay, billRowSchema, type BillRow } from './channel-bill.ts'

export type ChannelState = 'success' | 'fail' | 'unknown' | 'closed'
export type PaymentOutcome = 'success' | 'fail' | 'unknown' | 'close-paid'
export type QueryBehavior = 'match' | 'opposite' | 'missing-time'
export type RefundResult = 'success' | 'fail'

export interface ChannelPayment {
  id: string
  orderId: string
  payerId: string
  amount: number
  created: number
  graceDeadline: number
}

export interface ChannelResult {
  state: ChannelState
  paidAt?: number
  amount?: number
  channelTransactionId?: string
}

export interface PaymentCallback {
  paymentId: string
  orderId: string
  amount: number
  state: 'success' | 'fail'
  paidAt?: number
  signature: string
}

export interface PaymentPreset {
  outcome: PaymentOutcome
  paidAt?: number
  query?: QueryBehavior
  refundFailures?: number
}

export interface PaymentChannel {
  create(payment: ChannelPayment): Promise<{ accepted: boolean; callback?: PaymentCallback }> | { accepted: boolean; callback?: PaymentCallback }
  query(paymentId: string): Promise<ChannelResult> | ChannelResult
  close(paymentId: string): Promise<ChannelResult> | ChannelResult
  refund(refundId: string, paymentId: string, amount: number): Promise<RefundResult> | RefundResult
  shippingRefund?(refundId: string, paymentId: string, amount: number): Promise<RefundResult> | RefundResult
  refundReference?(refundId: string): string | undefined
  exportBill?(date: string): Promise<BillRow[]> | BillRow[]
}

interface SimulationRecord {
  payment: ChannelPayment
  preset: PaymentPreset
  queries: number
  refundAttempts: Map<string, number>
  refunds: Map<string, number>
  closed: boolean
}

export class MockPaymentChannel implements PaymentChannel {
  private shippingRefundIds = new Set<string>()
  private secret: string
  private records = new Map<string, SimulationRecord>()
  private presets = new Map<string, PaymentPreset>()
  private nextPreset?: PaymentPreset
  private bills = new Map<string, BillRow>()
  private db?: Database
  private clock: Clock

  constructor(secret: string, db?: Database, clock: Clock = systemClock) { this.secret = secret; this.db = db; this.clock = clock }
  attachStore(db:Database,clock:Clock) { this.db=db;this.clock=clock }

  private writeBill(row: BillRow) {
    if (this.db) this.db.run(`INSERT INTO mock_channel_bill(kind,business_id,channel_id,amount,state,occurred_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(kind,business_id) DO UPDATE SET channel_id=excluded.channel_id,amount=excluded.amount,state=excluded.state,occurred_at=excluded.occurred_at`,
      row.kind, row.businessId, row.channelId, row.amountCents, row.state, row.occurredAt)
    else this.bills.set(row.kind + ':' + row.businessId, structuredClone(row))
  }

  exportBill(date: string): BillRow[] {
    const { start, end } = billDay(date)
    return this.db ? this.db.all<BillRow>(`SELECT kind,business_id businessId,channel_id channelId,amount amountCents,state,occurred_at occurredAt
      FROM mock_channel_bill WHERE occurred_at>=? AND occurred_at<? ORDER BY occurred_at,kind,business_id`, start, end) :
      [...this.bills.values()].filter(row => row.occurredAt >= start && row.occurredAt < end).map(row => structuredClone(row))
  }

  setBill(date:string,rows:BillRow[]) {
    const {start,end}=billDay(date),values=rows.map(row=>billRowSchema.parse(row))
    if(values.some(row=>row.occurredAt<start||row.occurredAt>=end))throw new Error('模拟账单日期不符')
    const replace=()=>{
      if(this.db)this.db.run('DELETE FROM mock_channel_bill WHERE occurred_at>=? AND occurred_at<?',start,end)
      else for(const [key,row] of this.bills)if(row.occurredAt>=start&&row.occurredAt<end)this.bills.delete(key)
      for(const row of values)this.writeBill(row)
    }
    if(this.db)this.db.transaction(replace);else replace()
  }

  setPreset(paymentId: string | 'next', preset: PaymentPreset) {
    if (paymentId === 'next') this.nextPreset = structuredClone(preset)
    else {
      const existing = this.records.get(paymentId)
      if (existing) existing.preset = structuredClone(preset)
      else this.presets.set(paymentId, structuredClone(preset))
    }
  }

  create(payment: ChannelPayment) {
    const preset = this.presets.get(payment.id) ?? this.nextPreset ?? { outcome: 'success', paidAt: payment.created }
    this.presets.delete(payment.id)
    this.nextPreset = undefined
    const record: SimulationRecord = { payment, preset, queries: 0, refundAttempts: new Map(), refunds: new Map(), closed: false }
    this.records.set(payment.id, record)
    this.writeBill({ kind: 'payment', businessId: payment.id, channelId: 'mock-pay-' + payment.id,
      amountCents: payment.amount, state: 'pending', occurredAt: payment.created })
    if (preset.outcome === 'unknown' || preset.outcome === 'close-paid') return { accepted: true }
    const state = preset.outcome === 'success' ? 'success' : 'fail'
    return { accepted: true, callback: this.signedCallback(payment.id, { state, paidAt: state === 'success' ? preset.paidAt ?? payment.created : undefined }) }
  }

  query(paymentId: string): ChannelResult {
    const result = this.queryResult(paymentId)
    this.recordPayment(paymentId, result)
    return result
  }

  private recordPayment(paymentId: string, result: ChannelResult) {
    const record = this.records.get(paymentId)
    if (record && result.state !== 'unknown') this.writeBill({ kind: 'payment', businessId: paymentId,
      channelId: 'mock-pay-' + paymentId, amountCents: record.payment.amount,
      state: result.state === 'success' ? 'succeeded' : 'failed', occurredAt: result.paidAt ?? record.payment.created })
  }

  private queryResult(paymentId: string): ChannelResult {
    const record = this.records.get(paymentId)
    if (!record) return { state: 'unknown' }
    record.queries++
    const { outcome, query } = record.preset
    if (outcome === 'unknown' || outcome === 'close-paid') return { state: 'unknown' }
    if (query === 'opposite') return { state: outcome === 'success' ? 'fail' : 'success', ...(outcome === 'fail' ? { paidAt: record.preset.paidAt ?? record.payment.created } : {}) }
    if (query === 'missing-time' && outcome === 'success') return { state: 'success', amount: record.payment.amount }
    if (outcome === 'success') return { state: 'success', paidAt: record.preset.paidAt ?? record.payment.created, amount: record.payment.amount, channelTransactionId: 'mock-pay-' + paymentId }
    return { state: 'fail', amount: record.payment.amount }
  }

  close(paymentId: string): ChannelResult {
    const result = this.closeResult(paymentId)
    this.recordPayment(paymentId, result)
    return result
  }

  private closeResult(paymentId: string): ChannelResult {
    const record = this.records.get(paymentId)
    if (!record) return { state: 'unknown' }
    record.closed = true
    if (record.preset.outcome === 'close-paid') {
      return { state: 'success', paidAt: record.preset.paidAt ?? record.payment.created, amount: record.payment.amount, channelTransactionId: 'mock-pay-' + paymentId }
    }
    return { state: 'closed', amount: record.payment.amount }
  }

  refund(refundId: string, paymentId: string, amount: number): 'success' | 'fail' {
    return this.issueRefund(refundId, paymentId, amount, false)
  }

  refundReference(refundId: string): string | undefined {
    if (this.db) return this.db.one<{ id: string }>("SELECT channel_id id FROM mock_channel_bill WHERE kind='refund' AND business_id=? AND state='succeeded'", refundId)?.id
    for (const record of this.records.values()) if (record.refunds.has(refundId)) return 'mock-refund-' + refundId
    return undefined
  }

  shippingRefund(refundId: string, paymentId: string, amount: number): 'success' | 'fail' {
    return this.issueRefund(refundId, paymentId, amount, true)
  }

  private issueRefund(refundId: string, paymentId: string, amount: number, shipping: boolean): 'success' | 'fail' {
    const record = this.records.get(paymentId)
    if (!record || !Number.isSafeInteger(amount) || amount <= 0) return 'fail'
    const existing = record.refunds.get(refundId)
    if (existing !== undefined) return existing === amount ? 'success' : 'fail'
    if (!shipping && amount + [...record.refunds.entries()].filter(([id]) => !this.shippingRefundIds.has(id)).reduce((sum,[,value]) => sum + value,0) > record.payment.amount) return 'fail'
    const attempts = (record.refundAttempts.get(refundId) ?? 0) + 1
    record.refundAttempts.set(refundId, attempts)
    if (attempts <= (record.preset.refundFailures ?? 0)) {
      this.writeBill({ kind: 'refund', businessId: refundId, channelId: 'mock-refund-' + refundId,
        amountCents: amount, state: 'failed', occurredAt: this.clock.now() })
      return 'fail'
    }
    record.refunds.set(refundId, amount)
    if (shipping) this.shippingRefundIds.add(refundId)
    this.writeBill({ kind: 'refund', businessId: refundId, channelId: 'mock-refund-' + refundId,
      amountCents: amount, state: 'succeeded', occurredAt: this.clock.now() })
    return 'success'
  }

  signedCallback(paymentId: string, overrides: Partial<Omit<PaymentCallback, 'paymentId' | 'orderId' | 'amount' | 'signature'>> &
    Partial<Pick<PaymentCallback, 'orderId' | 'amount' | 'signature'>> = {}): PaymentCallback {
    const record = this.records.get(paymentId)
    if (!record) throw new Error('模拟支付单不存在')
    const callback = {
      paymentId,
      orderId: overrides.orderId ?? record.payment.orderId,
      amount: overrides.amount ?? record.payment.amount,
      state: overrides.state ?? (record.preset.outcome === 'fail' ? 'fail' : 'success'),
      ...(overrides.paidAt !== undefined ? { paidAt: overrides.paidAt } :
        (overrides.state ?? (record.preset.outcome === 'fail' ? 'fail' : 'success')) === 'success' ?
          { paidAt: record.preset.paidAt ?? record.payment.created } : {}),
    } as Omit<PaymentCallback, 'signature'>
    const signature = this.sign(callback)
    return { ...callback, signature: overrides.signature ?? signature }
  }

  verify(callback: Omit<PaymentCallback, 'signature'>, signature: string) {
    const expected = Buffer.from(this.sign(callback), 'hex')
    const actual = Buffer.from(signature, 'hex')
    return expected.length === actual.length && expected.length > 0 && timingSafeEqual(expected, actual)
  }

  private sign(callback: Omit<PaymentCallback, 'signature'>) {
    const canonical = JSON.stringify([callback.paymentId, callback.orderId, callback.amount, callback.state, callback.paidAt ?? null])
    return createHmac('sha256', this.secret).update(canonical).digest('hex')
  }
}
