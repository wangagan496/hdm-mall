import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockPaymentChannel } from '../src/payment-channel.ts'
import { buildTestApp } from './helpers/fixtures.ts'

const amountCents = 2475
const password = 'test-password-123'

for (const scenario of [
  { name: '重启后续查成功，支付只结算一次且库存只扣一次', late: false },
  { name: '重启后超过宽限期的迟到成功取消订单，只释放一次库存并退款一次', late: true }
]) {
  test(scenario.name, async () => {
    const root = await mkdtemp(join(tmpdir(), 'hdm-payment-restart-'))
    let now = Date.UTC(2026, 10, 5, 8)
    const clock = { now: () => now }
    const channel = new MockPaymentChannel('development-payment-callback-secret-32-bytes')
    const options = { databasePath: join(root, 'payments.sqlite'), uploadsPath: join(root, 'uploads'),
      publicUrl: 'http://127.0.0.1:3000', mockPayments: true, clock, paymentChannel: channel }
    let ctx: Awaited<ReturnType<typeof buildTestApp>> | undefined
    try {
      ctx = await buildTestApp(options)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
      const buyer = ctx.testData.account({ account: `buyer_${suffix}`, password })
      const address = ctx.testData.address({ userId: buyer.id, receiver: '买家', contact: '13800000000', address: '测试地址' })
      const product = ctx.testData.product({ name: `重启支付测试商品${suffix}`, category: '支付测试', skus: [
        { spec: '标准', priceCents: amountCents, stock: 7 }
      ] })
      const sku = product.skus[0]!
      assert.equal(ctx.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', sku.id)!.stock, 7)
      const created = await ctx.app.inject({ method: 'POST', url: '/member/order',
        headers: { authorization: `Bearer ${buyer.token}` },
        payload: { addressId: address.id, requestKey: randomUUID(), expectedAmountCents: amountCents,
          goods: [{ skuId: sku.id, count: 1 }] } })
      assert.equal(created.statusCode, 200)
      const orderId = created.json().result.id as string
      channel.setPreset('next', { outcome: 'unknown' })
      const started = await ctx.app.inject({ method: 'POST', url: `/member/order/${orderId}/payments`,
        headers: { authorization: `Bearer ${buyer.token}` }, payload: { amountCents } })
      assert.equal(started.statusCode, 200)
      assert.equal(started.json().result.state, 'pending')
      const paymentId = started.json().result.paymentId as string
      const pending = ctx.db.one<{ state: string; grace_deadline: number; next_query_at: number }>(
        'SELECT state,grace_deadline,next_query_at FROM payments WHERE id=?', paymentId)!
      assert.equal(pending.state, 'pending')
      assert.equal(ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 1)
      assert.equal(ctx.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', sku.id)!.stock, 6)
      assert.ok(pending.next_query_at > now)
      assert.ok(pending.next_query_at < pending.grace_deadline)
      await ctx.app.close()
      ctx = undefined

      const paidAt = scenario.late ? pending.grace_deadline + 1 : pending.next_query_at
      channel.setPreset(paymentId, { outcome: 'success', paidAt })
      ctx = await buildTestApp(options)
      assert.equal(ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 1)
      assert.deepEqual({ ...ctx.db.one<typeof pending>('SELECT state,grace_deadline,next_query_at FROM payments WHERE id=?', paymentId) }, { ...pending })
      assert.equal(ctx.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', sku.id)!.stock, 6)
      now = scenario.late ? pending.grace_deadline + 1000 : pending.next_query_at
      const assertSettled = () => {
        assert.deepEqual({ ...ctx!.db.one<{ state: number; paid_by: string | null }>('SELECT state,paid_by FROM orders WHERE id=?', orderId) },
          { state: scenario.late ? 6 : 2, paid_by: scenario.late ? null : buyer.id })
        assert.deepEqual(ctx!.db.all<{ id: string; state: string; channel_paid_at: number }>(
          'SELECT id,state,channel_paid_at FROM payments WHERE order_id=?', orderId).map(row => ({ ...row })),
          [{ id: paymentId, state: 'succeeded', channel_paid_at: paidAt }])
        assert.equal(ctx!.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', sku.id)!.stock, scenario.late ? 7 : 6)
        assert.deepEqual(ctx!.db.all<{ kind: string; delta: number; balance: number }>(
          'SELECT kind,delta,balance FROM inventory_movements WHERE order_id=? AND sku_id=? ORDER BY id',
          orderId, sku.id).map(row => ({ ...row })), scenario.late ? [
            { kind: 'reserve', delta: -1, balance: 6 }, { kind: 'expire', delta: 1, balance: 7 }
          ] : [{ kind: 'reserve', delta: -1, balance: 6 }])
        assert.deepEqual(ctx!.db.all<{ payment_id: string; amount: number; reason: string; state: string; attempts: number }>(
          `SELECT r.payment_id,r.amount,r.reason,r.state,r.attempts FROM refunds r
          JOIN payments p ON p.id=r.payment_id WHERE p.order_id=?`, orderId).map(row => ({ ...row })), scenario.late ? [
            { payment_id: paymentId, amount: amountCents, reason: 'late', state: 'succeeded', attempts: 1 }
          ] : [])
      }
      await ctx.payments.reconcile(now)
      assertSettled()
      now += 30_000
      await ctx.payments.reconcile(now)
      assertSettled()
    } finally {
      try { await ctx?.app.close() }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  })
}
