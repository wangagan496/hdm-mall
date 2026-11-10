import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { Database } from './database.ts'
import type { Clock } from './clock.ts'
import { AppError, ensure } from './errors.ts'
import type { Accounts, User } from './accounts.ts'
import { recordStockMovement } from './inventory.ts'
import { appendAudit } from './audit.ts'
import { MockPaymentChannel, type ChannelPayment, type ChannelResult, type PaymentCallback, type PaymentChannel } from './payment-channel.ts'

const PAYMENT_WINDOW_MS = 15 * 60_000
const PAYMENT_GRACE_MS = 10 * 60_000
const PAYMENT_REVIEW_MS = 24 * 3600_000
const REFUND_RETRY_DELAYS = [60_000, 5 * 60_000, 30 * 60_000, 3600_000]
const REFUND_CHANNEL_TIMEOUT_MS = 15_000

interface PaymentRow {
  id: string
  order_id: string
  payer_id: string
  amount: number
  state: 'pending' | 'succeeded' | 'failed' | 'closed'
  created: number
  grace_deadline: number
  channel_paid_at: number | null
  closed_at: number | null
  callback_state: 'success' | 'fail' | 'unknown' | 'closed' | null
  mismatch_count: number
  query_count: number
  next_query_at: number | null
  last_query_at: number | null
  review_at: number | null
}
interface RefundRow {
  id: string
  payment_id: string
  amount: number
  reason: 'late' | 'duplicate' | 'cancelled' | 'after-sale'
  state: 'pending' | 'succeeded' | 'failed'
  attempts: number
  next_attempt_at: number | null
  created: number
  review_at: number | null
}
interface OrderRow {
  id: string
  owner_id: string
  state: number
  amount: number
  created: number
  expires: number
  invited_payer: string | null
  paid_by: string | null
  paid_at: number | null
}
interface OrderItemRow { sku_id: string; count: number }
interface PaymentPresentationOrder {
  id: string
  owner_id: string
  state: number
  amount: number
  expires: number
  invited_payer: string | null
  paid_by: string | null
  paid_at: number | null
}

export class Payments {
  readonly db: Database
  readonly accounts: Accounts
  readonly channel?: PaymentChannel
  readonly clock: Clock
  private readonly callbackSecret: string
  private readonly refundAttempts = new Map<string, Promise<void>>()

  constructor(db: Database, accounts: Accounts, channel: PaymentChannel | undefined, callbackSecret: string, clock: Clock) {
    this.db = db
    this.accounts = accounts
    this.channel = channel
    this.callbackSecret = callbackSecret
    this.clock = clock
  }

  private order(id: string) {
    const order = this.db.one<OrderRow>('SELECT id,owner_id,state,amount,created,expires,invited_payer,paid_by,paid_at FROM orders WHERE id=?', id)
    ensure(order, 404, '订单不存在')
    return order
  }

  private payment(id: string) {
    return this.db.one<PaymentRow>('SELECT * FROM payments WHERE id=?', id)
  }

  private payerAllowed(user: User, order: OrderRow) {
    if (order.invited_payer) {
      ensure(order.invited_payer === user.id && this.accounts.bound(order.owner_id, user.id), 403, '仅指定且仍绑定的亲友可代付')
    } else ensure(order.owner_id === user.id, 403, '只有下单人可以操作')
  }

  private channelRequired(): PaymentChannel {
    ensure(this.channel, 503, '当前环境未接入支付渠道')
    return this.channel
  }

  async start(user: User, orderId: string, expectedAmount: number, forceSuccess = false) {
    const channel = this.channelRequired()
    const beforeStart = this.order(orderId)
    if (beforeStart.state === 1 && this.clock.now() >= beforeStart.expires) this.expireOrders(this.clock.now())
    let payment: PaymentRow
    this.db.transaction(() => {
      const order = this.order(orderId)
      ensure(expectedAmount === order.amount, 409, '订单金额变化，请刷新后重试')
      const existing = this.db.one<PaymentRow>("SELECT * FROM payments WHERE order_id=? AND state='pending' ORDER BY created,id LIMIT 1", orderId)
      ensure(!existing, 409, '付款结果正在确认中，请勿重复付款')
      ensure(order.state === 1 && this.clock.now() < order.expires, 409, '订单已超时，请重新购买')
      this.payerAllowed(user, order)
      const now = this.clock.now()
      const id = randomUUID()
      this.db.run(`INSERT INTO payments(id,order_id,payer_id,amount,state,created,grace_deadline,next_query_at)
        VALUES(?,?,?,?,'pending',?,?,?)`, id, orderId, user.id, order.amount, now, now + PAYMENT_GRACE_MS, now + 5000)
      payment = this.payment(id)!
    })
    if (forceSuccess && channel instanceof MockPaymentChannel) channel.setPreset(payment!.id, { outcome: 'success', paidAt: payment!.created })
    const result = await channel.create(this.asChannelPayment(payment!))
    if (!result.accepted) {
      this.db.transaction(() => this.db.run("UPDATE payments SET state='failed',next_query_at=NULL WHERE id=? AND state='pending'", payment!.id))
      throw new AppError(502, '支付渠道未受理本次支付')
    }
    if (result.callback) await this.processCallback(result.callback)
    return { id: orderId, orderId, paymentId: payment!.id, state: this.payment(payment!.id)!.state }
  }

  mockPay(user: User, orderId: string, expectedAmount: number) {
    ensure(this.channel instanceof MockPaymentChannel, 403, '此环境未启用模拟支付')
    const order = this.order(orderId)
    if (order.paid_by === user.id && order.state !== 1) {
      const payment = this.db.one<PaymentRow>(`SELECT * FROM payments WHERE order_id=? AND payer_id=? AND state='succeeded'
        AND channel_paid_at=? AND NOT EXISTS(SELECT 1 FROM refunds r WHERE r.payment_id=payments.id AND r.reason IN ('late','duplicate','cancelled')) ORDER BY created,id LIMIT 1`,
      orderId, user.id, order.paid_at)
      if (payment) {
        ensure(expectedAmount === order.amount, 409, '订单金额变化，请刷新后重试')
        return Promise.resolve({ id: orderId, orderId, paymentId: payment.id, state: payment.state })
      }
    }
    return this.start(user, orderId, expectedAmount, true)
  }

  signedCallback(paymentId: string, overrides: Partial<Omit<PaymentCallback, 'paymentId' | 'orderId' | 'amount' | 'signature'>> &
    Partial<Pick<PaymentCallback, 'orderId' | 'amount' | 'signature'>> = {}) {
    ensure(this.channel instanceof MockPaymentChannel, 409, '当前支付渠道不支持模拟回调')
    return this.channel.signedCallback(paymentId, overrides)
  }

  private asChannelPayment(payment: PaymentRow): ChannelPayment {
    return { id: payment.id, orderId: payment.order_id, payerId: payment.payer_id, amount: payment.amount,
      created: payment.created, graceDeadline: payment.grace_deadline }
  }

  async callbackPayload(payload: Omit<PaymentCallback, 'signature'>, signature: string) {
    const expected = Buffer.from(this.sign(payload), 'hex')
    const actual = Buffer.from(signature, 'hex')
    ensure(expected.length === actual.length && expected.length > 0 && timingSafeEqual(expected, actual), 401, '支付回调签名无效')
    const payment = this.payment(payload.paymentId)
    ensure(payment, 400, '支付单不存在')
    ensure(payment.order_id === payload.orderId && payment.amount === payload.amount, 400, '支付回调订单或金额不符')
    return this.processCallback({ ...payload, signature })
  }

  private sign(payload: Omit<PaymentCallback, 'signature'>) {
    return createHmac('sha256', this.callbackSecret)
      .update(JSON.stringify([payload.paymentId, payload.orderId, payload.amount, payload.state, payload.paidAt ?? null]))
      .digest('hex')
  }

  private async processCallback(callback: PaymentCallback) {
    return this.reconcile(this.clock.now(), { callback })
  }

  private async processQuery(paymentId: string, query: ChannelResult, now: number, declaredState?: PaymentCallback['state'], callback?: PaymentCallback) {
    const refundIds: string[] = []
    let result: { state: string } = { state: 'pending' }
    this.db.transaction(() => {
      const payment = this.payment(paymentId)
      ensure(payment, 400, '支付单不存在')
      if (payment.state === 'succeeded') return
      const callbackConflictsWithClosed = callback?.state === 'success' && query.state === 'closed'
      if (payment.state === 'closed' && query.state !== 'success' && !callbackConflictsWithClosed) return
      if (callback) this.db.run('UPDATE payments SET callback_state=? WHERE id=?', declaredState ?? payment.callback_state, paymentId)
      const declared = declaredState ?? payment.callback_state
      const mismatch = query.state === 'unknown' || (query.state === 'closed' && declared === 'success') ||
        (declared && ((declared === 'success' && query.state !== 'success') || (declared === 'fail' && query.state !== 'fail' && query.state !== 'closed'))) ||
        (query.state === 'success' && query.paidAt === undefined) ||
        (query.amount !== undefined && query.amount !== payment.amount)
      if (mismatch) {
        const mismatchCount = payment.mismatch_count + (query.state === 'unknown' ? 0 : 1)
        const shouldReview = mismatchCount >= 2 || now >= payment.created + PAYMENT_REVIEW_MS
        this.db.run(`UPDATE payments SET state=CASE WHEN state='closed' THEN 'pending' ELSE state END,mismatch_count=?,query_count=query_count+1,next_query_at=?,last_query_at=?,review_at=? WHERE id=?`,
          mismatchCount, now + (mismatchCount >= 2 ? PAYMENT_RETRY_DELAY : 60_000), now, shouldReview ? (payment.review_at ?? now) : payment.review_at, paymentId)
        if (shouldReview && !payment.review_at) this.createReviewNotices(payment, now)
        result = { state: shouldReview ? 'review' : 'pending' }
        return
      }
      if (query.state === 'success') {
        result = { state: this.settleSuccess(payment, query.paidAt!, now, refundIds) }
      } else if (query.state === 'fail' || query.state === 'closed') {
        result = { state: this.settleFailure(payment, now) }
      }
      this.db.run('UPDATE payments SET query_count=query_count+1,next_query_at=NULL,last_query_at=? WHERE id=?', now, paymentId)
    })
    if (refundIds.length) await this.reconcile(this.clock.now(), { refundIds })
    return result
  }

  private settleSuccess(payment: PaymentRow, paidAt: number, now: number, refundIds: string[]) {
    if (payment.state === 'succeeded') return 'succeeded'
    const order = this.order(payment.order_id)
    this.db.run(`UPDATE payments SET state='succeeded',channel_paid_at=?,closed_at=NULL,next_query_at=NULL,review_at=NULL WHERE id=?`, paidAt, payment.id)
    const onTime = paidAt <= payment.grace_deadline
    if (order.state !== 6 && onTime && !order.paid_by) {
      this.db.run('UPDATE orders SET state=2,paid_by=?,paid_at=? WHERE id=? AND state=1 AND paid_by IS NULL', payment.payer_id, paidAt, order.id)
      return 'succeeded'
    }
    if (order.state === 1) this.releaseStock(order, now)
    const reason = order.state === 6 ? 'cancelled' : order.paid_by ? 'duplicate' : 'late'
    refundIds.push(this.createRefund(payment, reason, now))
    return 'succeeded'
  }

  private settleFailure(payment: PaymentRow, now: number) {
    if (payment.state === 'succeeded') return 'succeeded'
    this.db.run(`UPDATE payments SET state='failed',next_query_at=NULL,review_at=NULL WHERE id=?`, payment.id)
    const order = this.order(payment.order_id)
    if (order.state === 1 && now >= order.expires) this.releaseStock(order, now)
    return 'failed'
  }

  private releaseStock(order: OrderRow, now: number, actor?: User) {
    if (order.state === 6) return
    for (const item of this.db.all<OrderItemRow>('SELECT sku_id,count FROM order_items WHERE order_id=?', order.id)) {
      const updated = this.db.run('UPDATE skus SET stock=stock+? WHERE id=?', item.count, item.sku_id)
      ensure(updated.changes === 1, 409, '库存释放失败')
      try { recordStockMovement(this.db, actor ?
        { kind: 'cancel', skuId: item.sku_id, delta: item.count, orderId: order.id, actorId: actor.id } :
        { kind: 'expire', skuId: item.sku_id, delta: item.count, orderId: order.id }, this.clock) }
      catch (error) {
        if (!(error instanceof Error && error.message.includes('UNIQUE constraint failed'))) throw error
      }
    }
    this.db.run('UPDATE orders SET state=6 WHERE id=? AND state=1', order.id)
  }

  private expireOrders(now: number) {
    const expired = this.db.all<OrderRow>(`SELECT o.* FROM orders o WHERE o.state=1 AND o.expires<=?
      AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.state='pending')`, now)
    if (expired.length) this.db.transaction(() => { for (const order of expired) this.releaseStock(order, now) })
  }

  effectivePaymentId(orderId: string): string | undefined {
    return this.db.one<{ id: string }>(`SELECT p.id FROM payments p JOIN orders o ON o.id=p.order_id
      WHERE o.id=? AND p.state='succeeded' AND p.payer_id=o.paid_by AND p.channel_paid_at=o.paid_at
      AND p.amount=o.amount AND NOT EXISTS(SELECT 1 FROM refunds r WHERE r.payment_id=p.id AND r.reason IN ('late','duplicate','cancelled'))
      ORDER BY p.created,p.id LIMIT 1`, orderId)?.id
  }

  createOrderCancellationRefund(orderId: string, paymentId: string, now: number, actor?: User) {
    if (this.effectivePaymentId(orderId) !== paymentId) throw new AppError(409, '付款记录异常，请联系客服', 'CANCEL_PAYMENT_INVALID')
    return this.createRefund(this.payment(paymentId)!, 'cancelled', now,undefined,undefined,actor)
  }

  createAfterSaleRefund(orderId: string, paymentId: string, afterSaleId: string, amount: number, now: number, actor?: User) {
    ensure(this.effectivePaymentId(orderId) === paymentId, 409, '付款记录异常，请联系客服')
    return this.createRefund(this.payment(paymentId)!, 'after-sale', now, amount, afterSaleId,actor)
  }

  private createRefund(payment: PaymentRow, reason: RefundRow['reason'], now: number, amount = payment.amount, afterSaleId?: string, actor?: User) {
    const existing = afterSaleId ? this.db.one<{ id: string }>('SELECT id FROM refunds WHERE after_sale_id=?', afterSaleId) :
      this.db.one<{ id: string }>("SELECT id FROM refunds WHERE payment_id=? AND reason IN ('late','duplicate','cancelled')", payment.id)
    if (existing) return existing.id
    const id = randomUUID()
    const reserved = this.db.one<{ amount: number }>('SELECT COALESCE(SUM(amount),0) amount FROM refunds WHERE payment_id=?', payment.id)!.amount
    ensure(Number.isSafeInteger(amount) && amount > 0 && amount + reserved <= payment.amount, 409, '退款合计不能超过实付金额')
    this.db.run(`INSERT INTO refunds(id,payment_id,amount,reason,after_sale_id,state,attempts,next_attempt_at,created) VALUES(?,?,?,?,?,'pending',0,?,?)`,
      id, payment.id, amount, reason, afterSaleId ?? null, now, now)
    this.createRefundNotices(payment, id, now)
    appendAudit(this.db,{created:now,actor,action:'refund.create',targetType:'refund',targetId:id,orderId:payment.order_id,
      summary:{reason,amountCents:amount,payerId:payment.payer_id}})
    return id
  }

  private createRefundNotices(payment: PaymentRow, refundId: string, now: number) {
    const recipients = new Set([payment.payer_id, this.order(payment.order_id).owner_id])
    for (const recipientId of recipients) this.db.run(`INSERT INTO payment_notices(id,order_id,recipient_id,payment_id,refund_id,kind,created)
      VALUES(?,?,?,?,?,'refund',?)`, randomUUID(), payment.order_id, recipientId, payment.id, refundId, now)
  }

  private createReviewNotices(payment: PaymentRow, now: number) {
    const recipients = new Set([payment.payer_id, this.order(payment.order_id).owner_id])
    for (const recipientId of recipients) this.db.run(`INSERT INTO payment_notices(id,order_id,recipient_id,payment_id,kind,created)
      VALUES(?,?,?,?, 'review',?)`, randomUUID(), payment.order_id, recipientId, payment.id, now)
  }

  private executeRefund(refundId: string): Promise<void> {
    const running = this.refundAttempts.get(refundId)
    if (running) return running
    const attempt = this.attemptRefund(refundId).finally(() => this.refundAttempts.delete(refundId))
    this.refundAttempts.set(refundId, attempt)
    return attempt
  }

  private async attemptRefund(refundId: string) {
    const refund = this.db.one<RefundRow>('SELECT * FROM refunds WHERE id=?', refundId)
    if (!refund || refund.state === 'succeeded') return
    let timer: NodeJS.Timeout | undefined
    let result: 'success' | 'fail'
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('退款渠道响应超时')), REFUND_CHANNEL_TIMEOUT_MS)
        timer.unref()
      })
      result = await Promise.race([
        Promise.resolve().then(() => this.channelRequired().refund(refund.id, refund.payment_id, refund.amount)),
        timeout,
      ])
    } catch {
      this.deferUnknownRefund(refund)
      return
    } finally {
      if (timer) clearTimeout(timer)
    }
    // Database errors must remain visible rather than masquerading as a channel timeout.
    this.finishRefund(refund, result)
  }

  private deferUnknownRefund(refund: RefundRow) {
    const now = this.clock.now()
    this.db.transaction(() => {
      const current = this.db.one<RefundRow>('SELECT * FROM refunds WHERE id=?', refund.id)
      if (!current || current.state === 'succeeded') return
      const attempts = current.attempts + 1
      const next = current.review_at !== null ? null : now + REFUND_RETRY_DELAYS[Math.min(attempts - 1, REFUND_RETRY_DELAYS.length - 1)]!
      this.db.run("UPDATE refunds SET state='pending',attempts=?,next_attempt_at=? WHERE id=?", attempts, next, refund.id)
    })
  }

  private finishRefund(refund: RefundRow, result: 'success' | 'fail') {
    const now = this.clock.now()
    this.db.transaction(() => {
      const current = this.db.one<RefundRow>('SELECT * FROM refunds WHERE id=?', refund.id)
      if (!current || current.state === 'succeeded') return
      const attempts = current.attempts + 1
      const next = result === 'success' || current.review_at !== null ? null : now + REFUND_RETRY_DELAYS[Math.min(attempts - 1, REFUND_RETRY_DELAYS.length - 1)]!
      this.db.run('UPDATE refunds SET state=?,attempts=?,next_attempt_at=?,review_at=CASE WHEN ? THEN NULL ELSE review_at END WHERE id=?',
        result === 'success' ? 'succeeded' : 'failed', attempts, next, result === 'success' ? 1 : 0, refund.id)
      if (result === 'success') this.db.run('UPDATE refunds SET completed_at=? WHERE id=?',now,refund.id)
      if (result === 'success') this.db.run("UPDATE after_sales SET state='refunded' WHERE refund_id=? AND state='refunding'", refund.id)
      appendAudit(this.db,{created:now,action:'refund.result',targetType:'refund',targetId:refund.id,orderId:this.payment(refund.payment_id)!.order_id,summary:{outcome:result,amountCents:refund.amount}})
    })
  }

  async cancelPending(user: User, orderId: string) {
    let paymentId: string | undefined
    this.db.transaction(() => {
      const order = this.order(orderId)
      ensure(order.owner_id === user.id, 403, '只有下单人可以操作')
      ensure(order.state === 1, 409, '只有待付款或确认中的订单可以取消')
      const payment = this.db.one<PaymentRow>("SELECT * FROM payments WHERE order_id=? AND state='pending' ORDER BY created,id LIMIT 1", orderId)
      ensure(payment, 404, '确认中的支付不存在')
      paymentId = payment.id
      this.releaseStock(order, this.clock.now(), user)
      this.db.run("UPDATE payments SET state='closed',closed_at=?,next_query_at=? WHERE id=? AND state='pending'", this.clock.now(), this.clock.now(), payment.id)
    })
    await this.reconcile(this.clock.now(), { paymentId: paymentId!, close: true })
    return { id: orderId }
  }

  private scheduleUnknown(payment: PaymentRow, now: number) {
    const queryCount = payment.query_count + 1
    const delays = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000]
    const delay = delays[Math.min(queryCount - 1, delays.length - 1)]!
    const review = now >= payment.created + PAYMENT_REVIEW_MS ? (payment.review_at ?? now) : payment.review_at
    this.db.run(`UPDATE payments SET state=?,query_count=?,next_query_at=?,review_at=? WHERE id=?`,
      review ? 'pending' : payment.state, queryCount, now + delay, review, payment.id)
    if (review && !payment.review_at) this.createReviewNotices(payment, now)
  }

  async reconcile(now = this.clock.now(), request?: {
    paymentId?: string
    callback?: PaymentCallback
    close?: boolean
    refundIds?: string[]
  }) {
    if (request?.callback) {
      const query = await this.channelRequired().query(request.callback.paymentId)
      return this.processQuery(request.callback.paymentId, query, now, request.callback.state, request.callback)
    }
    if (request?.paymentId) {
      const payment = this.payment(request.paymentId)
      ensure(payment, 404, '支付单不存在')
      if (request.close) {
        const closed = await this.channelRequired().close(payment.id)
        await this.reconcileClosed(payment.id, closed, now)
      } else {
        const query = await this.channelRequired().query(payment.id)
        await this.reconcileQuery(payment, query, now)
      }
      return
    }
    if (request?.refundIds) {
      for (const refundId of request.refundIds) await this.executeRefund(refundId)
      return
    }
    this.reviewExpiredRefunds(now)
    const pending = this.db.all<PaymentRow>(`SELECT * FROM payments WHERE
      ((state='pending' AND (next_query_at IS NULL OR next_query_at<=? OR grace_deadline<=?)) OR
       (state='closed' AND next_query_at IS NOT NULL AND next_query_at<=?)) ORDER BY created,id`, now, now, now)
    for (const payment of pending) {
      if (payment.state === 'closed') {
        const query = await this.channelRequired().query(payment.id)
        await this.reconcileQuery(payment, query, now)
        continue
      }
      if (now >= payment.grace_deadline && payment.closed_at === null) {
        this.db.transaction(() => this.db.run("UPDATE payments SET closed_at=? WHERE id=? AND state='pending' AND closed_at IS NULL", now, payment.id))
        const closed = await this.channelRequired().close(payment.id)
        await this.reconcileClosed(payment.id, closed, now)
      } else {
        const query = await this.channelRequired().query(payment.id)
        await this.reconcileQuery(payment, query, now)
      }
    }
    for (const refund of this.db.all<RefundRow>("SELECT * FROM refunds WHERE state IN ('pending','failed') AND review_at IS NULL AND next_attempt_at<=?", now)) await this.executeRefund(refund.id)
  }

  private reviewExpiredRefunds(now: number) {
    const refunds = this.db.all<RefundRow>("SELECT * FROM refunds WHERE state IN ('pending','failed') AND review_at IS NULL AND created<=?", now - PAYMENT_REVIEW_MS)
    for (const refund of refunds) this.db.transaction(() => {
      const changed = this.db.run("UPDATE refunds SET review_at=?,next_attempt_at=NULL WHERE id=? AND review_at IS NULL AND state IN ('pending','failed')", now, refund.id)
      if (!changed.changes) return
      const payment = this.payment(refund.payment_id)!
      appendAudit(this.db,{created:now,action:'refund.result',targetType:'refund',targetId:refund.id,orderId:payment.order_id,summary:{outcome:'review',amountCents:refund.amount}})
      const ownerId = this.order(payment.order_id).owner_id
      for (const recipientId of new Set([payment.payer_id, ownerId])) this.db.run(`INSERT INTO payment_notices(id,order_id,recipient_id,payment_id,refund_id,kind,created)
        VALUES(?,?,?,?,?,'review',?)`, randomUUID(), payment.order_id, recipientId, payment.id, refund.id, now)
    })
  }

  private async reconcileClosed(paymentId: string, closed: ChannelResult, now: number) {
    if (closed.state === 'success' && closed.paidAt !== undefined) return this.processQuery(paymentId, closed, now)
    const query = await this.channelRequired().query(paymentId)
    await this.reconcileQuery(this.payment(paymentId)!, query, now)
  }

  private async reconcileQuery(payment: PaymentRow, query: ChannelResult, now: number) {
    if (payment.state === 'closed') {
      if (query.state === 'success' && query.paidAt !== undefined) {
        await this.processQuery(payment.id, query, now)
      } else if (query.state === 'fail' || query.state === 'closed') {
        this.db.transaction(() => this.db.run("UPDATE payments SET next_query_at=NULL,last_query_at=? WHERE id=? AND state='closed'", now, payment.id))
      } else {
        this.db.transaction(() => this.scheduleUnknown(payment, now))
      }
      return
    }
    if (query.state === 'unknown' || (query.state === 'success' && query.paidAt === undefined)) {
      this.db.transaction(() => this.scheduleUnknown(payment, now))
      return
    }
    await this.processQuery(payment.id, query, now)
  }

  async refresh(user: User, orderId: string) {
    const order = this.order(orderId)
    ensure(order.owner_id === user.id || !!this.db.one('SELECT id FROM payments WHERE order_id=? AND payer_id=?', orderId, user.id), 403, '无权查看此订单')
    const payment = this.db.one<PaymentRow>("SELECT * FROM payments WHERE order_id=? AND state IN ('pending','closed') ORDER BY created,id LIMIT 1", orderId)
    if (!payment) return this.orderFields(order, user)
    const now = this.clock.now()
    if (payment.last_query_at !== null && now - payment.last_query_at < 5000) return this.orderFields(order, user)
    await this.reconcile(now, { paymentId: payment.id })
    return this.orderFields(this.order(orderId), user)
  }

  reviewPage(user: User, page: number, pageSize: number) {
    ensure(user.role === 'merchant', 403, '需要商家权限')
    const payments = this.db.all<{ kind: 'payment'; id: string; orderId: string; amount: number; payerAccount: string; created: number; queryCount: number; reviewAt: number }>(`SELECT 'payment' AS kind,p.id,p.order_id AS orderId,p.amount,u.account AS payerAccount,
      p.created,p.query_count AS queryCount,p.review_at AS reviewAt FROM payments p JOIN users u ON u.id=p.payer_id
      WHERE p.state='pending' AND p.review_at IS NOT NULL`)
    const refunds = this.db.all<{ kind: 'refund'; id: string; orderId: string; amount: number; payerAccount: string; created: number; queryCount: number; reviewAt: number; paymentId: string }>(`SELECT 'refund' AS kind,r.id,p.order_id AS orderId,r.amount,u.account AS payerAccount,
      r.created,r.attempts AS queryCount,r.review_at AS reviewAt,r.payment_id AS paymentId FROM refunds r
      JOIN payments p ON p.id=r.payment_id JOIN users u ON u.id=p.payer_id WHERE r.state IN ('pending','failed') AND r.review_at IS NOT NULL`)
    const allItems = [...payments, ...refunds].sort((left, right) => left.reviewAt - right.reviewAt || left.id.localeCompare(right.id))
    const counts = allItems.length
    const items = allItems.slice((page - 1) * pageSize, page * pageSize)
    return { items, counts, pages: Math.ceil(counts / pageSize), page, pageSize }
  }

  async retryRefund(user: User, refundId: string, requestKey: string) {
    ensure(user.role === 'merchant', 403, '需要商家权限')
    const refund = this.db.one<RefundRow>('SELECT * FROM refunds WHERE id=?', refundId)
    ensure(refund, 404, '退款单不存在')
    const existing = this.db.one<{ refund_id: string }>('SELECT refund_id FROM refund_retry_actions WHERE request_key=?', requestKey)
    if (existing) {
      ensure(existing.refund_id === refundId, 409, '同一请求号不能用于其他退款单')
      return { id: refundId }
    }
    ensure(refund.review_at !== null && refund.state !== 'succeeded', 409, '退款单不在待核实列表')
    this.db.transaction(() => {
      this.db.run('INSERT INTO refund_retry_actions(refund_id,merchant_id,request_key,created) VALUES(?,?,?,?)',refundId,user.id,requestKey,this.clock.now())
      appendAudit(this.db,{created:this.clock.now(),actor:user,action:'refund.retry',targetType:'refund',targetId:refundId,orderId:this.payment(refund.payment_id)!.order_id,requestKey})
    })
    await this.reconcile(this.clock.now(), { refundIds: [refundId] })
    return { id: refundId }
  }

  async requery(user: User, paymentId: string) {
    ensure(user.role === 'merchant', 403, '需要商家权限')
    const payment = this.payment(paymentId)
    ensure(payment, 404, '支付单不存在')
    ensure(payment.review_at !== null && payment.state === 'pending', 409, '支付单不在待核实列表')
    await this.reconcile(this.clock.now(), { paymentId })
    return { id: paymentId }
  }

  async resolve(user: User, paymentId: string, data: { outcome: 'paid' | 'unpaid'; paidAt?: number; reason: string; requestKey: string }) {
    ensure(user.role === 'merchant', 403, '需要商家权限')
    const refundIds: string[] = []
    this.db.transaction(() => {
      const payment = this.payment(paymentId)
      ensure(payment, 404, '支付单不存在')
      const existingKey = this.db.one<{ id: number; payment_id: string; outcome: string; paid_at: number | null; reason: string }>('SELECT id,payment_id,outcome,paid_at,reason FROM payment_review_resolutions WHERE request_key=?', data.requestKey)
      if (existingKey) {
        ensure(existingKey.payment_id === paymentId && existingKey.outcome === data.outcome && existingKey.paid_at === (data.paidAt ?? null) && existingKey.reason === data.reason,
          409, '同一请求号不能更改核实结果')
        return
      }
      ensure(payment.review_at !== null && payment.state === 'pending', 409, '支付单不在待核实列表')
      ensure(!this.db.one('SELECT id FROM payment_review_resolutions WHERE payment_id=?', paymentId), 409, '这笔支付已登记核实结果')
      ensure(data.outcome === 'unpaid' || data.paidAt !== undefined, 400, '已扣款结果必须填写扣款时间')
      this.db.run(`INSERT INTO payment_review_resolutions(payment_id,merchant_id,request_key,outcome,paid_at,reason,created)
        VALUES(?,?,?,?,?,?,?)`, paymentId, user.id, data.requestKey, data.outcome, data.paidAt ?? null, data.reason, this.clock.now())
      if (data.outcome === 'paid') this.settleSuccess(payment, data.paidAt!, this.clock.now(), refundIds)
      else this.settleFailure(payment, this.clock.now())
      appendAudit(this.db,{created:this.clock.now(),actor:user,action:'payment.review',targetType:'payment',targetId:paymentId,orderId:payment.order_id,requestKey:data.requestKey,
        summary:{outcome:data.outcome,reason:data.reason}})
    })
    if (refundIds.length) await this.reconcile(this.clock.now(), { refundIds })
    return { id: paymentId }
  }

  markViewed(orderId: string, userId: string) {
    this.db.run('UPDATE payment_notices SET viewed_at=? WHERE order_id=? AND recipient_id=? AND viewed_at IS NULL', this.clock.now(), orderId, userId)
  }

  hasPending(orderId: string) {
    return !!this.db.one("SELECT id FROM payments WHERE order_id=? AND state='pending'", orderId)
  }

  orderFields(order: PaymentPresentationOrder, user: User) {
    return this.fieldsForOrder(order, user)
  }

  attentionCount(user: User) {
    const count = this.db.one<{ count: number }>(`SELECT COUNT(DISTINCT order_id) AS count FROM payment_notices
      WHERE recipient_id=? AND viewed_at IS NULL`, user.id)!.count
    return { count }
  }

  private fieldsForOrder(order: PaymentPresentationOrder, user: User) {
    const payments = this.db.all<PaymentRow>('SELECT * FROM payments WHERE order_id=? ORDER BY created,id', order.id)
    const visiblePayments = payments.filter(payment => user.id === order.owner_id || user.id === payment.payer_id)
    const pending = payments.find(payment => payment.state === 'pending' || payment.state === 'closed' && payment.next_query_at !== null)
    const effective = order.paid_by ? payments.find(payment => payment.state === 'succeeded' && payment.payer_id === order.paid_by &&
      payment.channel_paid_at === order.paid_at && !this.db.one("SELECT id FROM refunds WHERE payment_id=? AND reason IN ('late','duplicate','cancelled')", payment.id)) : undefined
    const visibleRefunds = this.db.all<RefundRow & { payer_id: string; channel_paid_at: number | null }>(`SELECT r.*,p.payer_id,p.channel_paid_at
      FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.order_id=? ORDER BY COALESCE(p.channel_paid_at,p.created),p.id`, order.id)
      .filter(refund => user.id === order.owner_id || visiblePayments.some(payment => payment.id === refund.payment_id))
    const refunds = visibleRefunds.map(refund => ({ id: refund.id, amount: refund.amount / 100, payerAccount: this.account(refund.payer_id), paidAt: refund.channel_paid_at,
        state: refund.state === 'pending' ? '退款中' : refund.state === 'succeeded' ? '已退款' : '退款失败重试中', reason: refund.reason }))
    const review = pending?.review_at !== null && pending?.review_at !== undefined
    const paymentState = effective ? 'paid' : review ? 'review' : pending ? 'confirming' : 'none'
    const refundNotices = visibleRefunds.map(refund => {
      const amount = `¥${(refund.amount / 100).toFixed(2)}`
      const time = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(refund.channel_paid_at ?? refund.created)
      const payer = this.account(refund.payer_id)
      const detail = `${amount}（${time} 由 ${payer} 付款）`
      if (refund.state === 'succeeded') return `${detail}已原路退回付款账户。`
      if (refund.review_at !== null) return `${detail}退款遇到问题，我们正在人工处理。可以进入帮助与客服咨询。`
      return `${detail}正在退回付款账户。退款处理中，系统会自动重试，无需操作。`
    })
    const notice = refundNotices.length ? refundNotices.join('\n') : review ? '我们正在核实这笔付款。如已扣款，核实后会原路退回或完成订单。' :
        pending && order.state === 6 ? '订单已取消；如已扣款，将原路退回付款账户。' :
          pending ? '正在确认付款结果，请勿重复付款' : payments.some(payment => payment.state === 'failed') ?
          (this.clock.now() < order.expires ? '付款未成功，未扣款。可以重新付款。' : '付款未成功，订单已超时取消，未扣款。') : ''
    const needsAttention = !!this.db.one('SELECT id FROM payment_notices WHERE order_id=? AND recipient_id=? AND viewed_at IS NULL LIMIT 1', order.id, user.id)
    return { paymentState, refunds, paymentNotice: notice, needsAttention,
      canPay: order.state === 1 && this.clock.now() < order.expires && !pending &&
        (order.invited_payer ? order.invited_payer === user.id && this.accounts.bound(order.owner_id, user.id) : order.owner_id === user.id),
      canCancel: order.state === 1 && order.owner_id === user.id,
      countdown: pending ? 0 : Math.max(0, Math.floor((order.expires - this.clock.now()) / 1000)) }
  }

  private account(id: string) { return this.db.one<{ account: string }>("SELECT CASE WHEN status='deleted' THEN '已注销用户' ELSE account END account FROM users WHERE id=?", id)?.account ?? '' }
}

const PAYMENT_RETRY_DELAY = 60_000
