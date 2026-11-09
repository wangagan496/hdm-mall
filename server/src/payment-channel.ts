import { createHmac, timingSafeEqual } from 'node:crypto'

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
  private secret: string
  private records = new Map<string, SimulationRecord>()
  private presets = new Map<string, PaymentPreset>()
  private nextPreset?: PaymentPreset

  constructor(secret: string) { this.secret = secret }

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
    if (preset.outcome === 'unknown' || preset.outcome === 'close-paid') return { accepted: true }
    const state = preset.outcome === 'success' ? 'success' : 'fail'
    return { accepted: true, callback: this.signedCallback(payment.id, { state, paidAt: state === 'success' ? preset.paidAt ?? payment.created : undefined }) }
  }

  query(paymentId: string): ChannelResult {
    const record = this.records.get(paymentId)
    if (!record) return { state: 'unknown' }
    record.queries++
    const { outcome, query } = record.preset
    if (outcome === 'unknown' || outcome === 'close-paid') return { state: 'unknown' }
    if (query === 'opposite') return { state: outcome === 'success' ? 'fail' : 'success', ...(outcome === 'fail' ? { paidAt: record.preset.paidAt ?? record.payment.created } : {}) }
    if (query === 'missing-time' && outcome === 'success') return { state: 'success', amount: record.payment.amount }
    if (outcome === 'success') return { state: 'success', paidAt: record.preset.paidAt ?? record.payment.created, amount: record.payment.amount }
    return { state: 'fail', amount: record.payment.amount }
  }

  close(paymentId: string): ChannelResult {
    const record = this.records.get(paymentId)
    if (!record) return { state: 'unknown' }
    record.closed = true
    if (record.preset.outcome === 'close-paid') {
      return { state: 'success', paidAt: record.preset.paidAt ?? record.payment.created, amount: record.payment.amount }
    }
    return { state: 'closed', amount: record.payment.amount }
  }

  refund(refundId: string, paymentId: string, amount: number): 'success' | 'fail' {
    const record = this.records.get(paymentId)
    if (!record || !Number.isSafeInteger(amount) || amount <= 0) return 'fail'
    const existing = record.refunds.get(refundId)
    if (existing !== undefined) return existing === amount ? 'success' : 'fail'
    if (amount + [...record.refunds.values()].reduce((sum,value) => sum + value,0) > record.payment.amount) return 'fail'
    const attempts = (record.refundAttempts.get(refundId) ?? 0) + 1
    record.refundAttempts.set(refundId, attempts)
    if (attempts <= (record.preset.refundFailures ?? 0)) return 'fail'
    record.refunds.set(refundId, amount)
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
