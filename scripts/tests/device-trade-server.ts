// 独立内存数据；Full 模式只准备账号、地址和购物袋，分页探针另行准备订单。
import { buildTestApp } from '../../server/test/helpers/fixtures.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MockPaymentChannel } from '../../server/src/payment-channel.ts'
const paymentCallbackSecret = randomUUID()
const channel = new MockPaymentChannel(paymentCallbackSecret)
const refund = channel.refund.bind(channel)
let heldPaymentId: string | undefined
let refundBarrier: Promise<void> | undefined
let releaseRefund: (() => void) | undefined
const activeRefunds = new Map<string, Promise<'success' | 'fail'>>()
Object.defineProperty(channel, 'refund', { value: (refundId: string, paymentId: string, amount: number) => {
  const existing = activeRefunds.get(refundId)
  if (existing) return existing
  const completion = (async () => {
    if (paymentId === heldPaymentId) await refundBarrier
    return refund(refundId, paymentId, amount)
  })()
  activeRefunds.set(refundId, completion)
  void completion.finally(() => activeRefunds.delete(refundId))
  return completion
} })
const f = await buildTestApp({ databasePath: ':memory:', mockPayments: true,
  paymentChannel: channel, paymentCallbackSecret,
  publicUrl: 'http://127.0.0.1:3000', uploadsPath: join(tmpdir(), 'hdm-device-trade-uploads') })
const product = f.testData.product({ name: '设备独立测试商品',
  skus: [{ spec: '标准款', priceCents: 2371, stock: 23 }] })
const sku = product.skus[0]!
for (const account of ['device_buyer', 'device_friend', 'device_merchant']) {
  f.testData.account({ account, password: 'Device-trade-123', role: account === 'device_merchant' ? 'merchant' : 'buyer' })
}
const buyer = f.accounts.login('device_buyer', 'Device-trade-123')
const user = f.accounts.authenticate(`Bearer ${buyer.token}`)
const address = f.testData.address({ userId: user.id, receiver: '设备验收', contact: '13800138000', fullLocation: '测试省 测试市 测试区',
  provinceCode: 'test', cityCode: 'test', countyCode: 'test', address: '独立模拟器验收地址', isDefault: 0 })
f.app.get('/device-fixture', async () => ({ fixture: 'device-trade', pid: process.pid,
  skuId: sku.id, amountCents: sku.priceCents, initialStock: sku.stock }))
f.app.post<{ Body: { paymentId: string; hold: boolean } }>('/device-fixture/refund-barrier', {
  schema: { body: { type: 'object', required: ['paymentId', 'hold'], additionalProperties: false,
    properties: { paymentId: { type: 'string', minLength: 1 }, hold: { type: 'boolean' } } } }
}, async (req, reply) => {
  const { paymentId, hold } = req.body
  if (!f.db.one("SELECT id FROM payments WHERE id=? AND state='succeeded'", paymentId)) {
    return reply.code(404).send({ error: 'Succeeded fixture payment not found' })
  }
  if (hold) {
    if (heldPaymentId) return reply.code(409).send({ error: 'Refund barrier already armed' })
    heldPaymentId = paymentId
    refundBarrier = new Promise<void>(resolve => { releaseRefund = resolve })
  } else {
    if (heldPaymentId !== paymentId) return reply.code(409).send({ error: 'Refund barrier payment mismatch' })
    heldPaymentId = undefined
    releaseRefund?.()
    await Promise.all(activeRefunds.values())
    await f.payments.reconcile()
    refundBarrier = undefined
    releaseRefund = undefined
  }
  return { paymentId, held: hold }
})
f.app.post<{ Body: { orderId?: string; preset: unknown } }>('/device-fixture/payment-preset', {
  schema: { body: { type: 'object', required: ['preset'], additionalProperties: false,
    properties: { orderId: { type: 'string', minLength: 1 }, preset: { type: 'object' } } } }
}, async (req, reply) => {
  const { orderId, preset } = req.body
  const payment = orderId ? f.db.one<{ id: string; state: string }>(
    `SELECT id,state FROM payments WHERE order_id=? AND (state='pending' OR
      (state='closed' AND EXISTS (SELECT 1 FROM orders WHERE id=? AND state=6)))
      ORDER BY CASE WHEN state='pending' THEN 0 ELSE 1 END,created DESC,id DESC LIMIT 1`, orderId, orderId) : undefined
  if (orderId && !payment) return reply.code(404).send({ error: 'No pending or cancelled closed payment for this order' })
  const configured = f.testData.payments({ paymentId: payment?.id ?? 'next', preset })
  return { ...configured, paymentId: payment?.id ?? 'next', state: payment?.state ?? null }
})
f.app.get<{ Params: { orderId: string } }>('/device-fixture/orders/:orderId/payments', async (req, reply) => {
  const orderId = req.params.orderId
  const order = f.db.one('SELECT id,state,amount FROM orders WHERE id=?', orderId)
  if (!order) return reply.code(404).send({ error: 'Fixture order not found' })
  return { order,
    payments: f.db.all(`SELECT payments.id,order_id,amount,state,created,channel_paid_at,next_query_at,payer_id,
      (SELECT account FROM users WHERE users.id=payments.payer_id) AS payerAccount
      FROM payments WHERE order_id=? ORDER BY created,id`, orderId),
    refunds: f.db.all(`SELECT refunds.id,payment_id,refunds.amount,refunds.state,reason,attempts FROM refunds
      JOIN payments ON payments.id=refunds.payment_id WHERE payments.order_id=? ORDER BY refunds.id`, orderId),
    cancelRequests: f.db.all('SELECT * FROM order_cancel_requests WHERE order_id=? ORDER BY sequence', orderId),
    cancelActions: f.db.all(`SELECT order_cancel_actions.*,
      (SELECT account FROM users WHERE users.id=order_cancel_actions.actor_id) AS actorAccount
      FROM order_cancel_actions WHERE order_id=? ORDER BY created,id`, orderId) }
})
f.app.addHook('onResponse', async (req, reply) => {
  if (req.method !== 'GET') console.log(JSON.stringify({ method: req.method, route: req.routeOptions.url,
    status: reply.statusCode, contentType: req.headers['content-type'], contentLength: req.headers['content-length'] }))
})
f.app.addHook('onError', async (_req, _reply, error) => { console.log(JSON.stringify({ errorCode: error.code })) })
await f.app.inject({ method: 'POST', url: '/member/cart', headers: { authorization: `Bearer ${buyer.token}` }, payload: { skuId: sku.id, count: 1, requestKey: randomUUID() } })
if (process.argv.includes('--relations')) {
  for (let index = 0; index <= 10; index++) {
    const account = `probe_${String(index).padStart(2, '0')}`
    const friend = f.testData.account({ account, password: 'Device-trade-123' })
    const id = f.testData.relation({ ownerId: user.id, friendId: friend.id }).id
    f.db.run('UPDATE relations SET created=? WHERE id=?', 1000 + index, id)
  }
}
if (process.argv.includes('--cancel-family')) {
  const friend = f.accounts.login('device_friend', 'Device-trade-123')
  f.testData.relation({ ownerId: user.id, friendId: friend.id })
}
// 分页探针单独准备 11 笔代付订单；Full 模式仍由设备完成全部交易操作。
if (process.argv.includes('--pagination')) {
  const friend = f.accounts.login('device_friend', 'Device-trade-123')
  const friendUser = f.accounts.authenticate(`Bearer ${friend.token}`)
  f.testData.relation({ ownerId: user.id, friendId: friend.id })
  const orders = f.orders
  for (let index = 1; index <= 11; index++) {
    const order = orders.create(user, { requestKey: randomUUID(), expectedAmountCents: sku.priceCents, addressId: address.id, goods: [{ skuId: sku.id, count: 1 }] })
    orders.invitePayer(user, order.id, friend.id)
    orders.pay(friendUser, order.id, sku.priceCents)
    f.db.run('UPDATE orders SET created=? WHERE id=?', f.clock.now() - 60000 + index, order.id)
    f.db.run('UPDATE order_items SET name=? WHERE order_id=?', `分页商品 ${String(index).padStart(2, '0')}`, order.id)
  }
}
await f.app.listen({ port: 3103, host: '127.0.0.1' })
console.log('RESULT isolated trade fixture ready')
