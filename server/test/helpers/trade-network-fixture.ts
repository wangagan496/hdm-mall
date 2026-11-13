import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTestApp } from './fixtures.ts'

const responseRoutes = {
  order: { method: 'POST', route: '/member/order' },
  payment: { method: 'POST', route: '/member/order/:id/payments' },
  'cancel-request': { method: 'POST', route: '/member/order/:id/cancel-requests' },
  'cancel-withdraw': { method: 'POST', route: '/member/order/:id/cancel-requests/:cancelRequestId/withdraw' },
  'cancel-resolve': { method: 'POST', route: '/merchant/orders/:id/cancel-requests/:cancelRequestId/resolve' }
}
type ResponseKind = keyof typeof responseRoutes
type TradeRequest = { id: string; method: string; route: string; requestKey?: string; orderId?: string;
  body?: unknown; status?: number; stateBefore?: number; stateAfter?: number }

export async function buildTradeNetworkFixture() {
  const uploadsPath = await mkdtemp(join(tmpdir(), 'hdm-device-trade-uploads-' + process.pid + '-'))
  const password = randomBytes(24).toString('hex')
  const context = await buildTestApp({ databasePath: ':memory:', mockPayments: true,
    paymentCallbackSecret: randomUUID(), corsOrigins: ['null'], publicUrl: 'http://127.0.0.1:3000', uploadsPath })
  const product = context.testData.product({ name: '设备独立测试商品', skus: [{ spec: '标准款', priceCents: 2371, stock: 23 }] })
  const sku = product.skus[0]!
  for (const account of ['device_buyer', 'device_friend', 'device_merchant']) {
    context.testData.account({ account, password, role: account === 'device_merchant' ? 'merchant' : 'buyer' })
  }
  const buyer = context.accounts.login('device_buyer', password)
  const user = context.accounts.authenticate('Bearer ' + buyer.token)
  const address = context.testData.address({ userId: user.id, receiver: '设备验收', contact: '13800138000',
    fullLocation: '测试省 测试市 测试区', provinceCode: 'test', cityCode: 'test', countyCode: 'test',
    address: '独立模拟器验收地址', isDefault: 0 })
  const app = context.app
  app.get('/device-fixture', async () => ({ fixture: 'device-trade-network', pid: process.pid, uploadsPath,
    skuId: sku.id, productId: product.id, amountCents: sku.priceCents, initialStock: sku.stock }))
  app.get<{ Params: { account: string } }>('/device-fixture/form/:account', async (req, reply) => {
    if (!/^device_(buyer|friend|merchant)$/.test(req.params.account)) return reply.code(404).send({ code: '0' })
    return { code: '1', result: { fixture: 'device-trade-form', password } }
  })
  const tradeRequests: TradeRequest[] = []
  app.get('/device-fixture/trade-requests', async () => tradeRequests)
  let barrier: { kind: ResponseKind; received: boolean; request?: unknown; response?: unknown; orderId?: string } | undefined
  let gate: Promise<void> | undefined
  let release: (() => void) | undefined
  app.post<{ Body: { kind: ResponseKind; hold: boolean } }>('/device-fixture/response-barrier', {
    schema: { body: { type: 'object', required: ['kind', 'hold'], additionalProperties: false,
      properties: { kind: { type: 'string', enum: Object.keys(responseRoutes) }, hold: { type: 'boolean' } } } }
  }, async (req, reply) => {
    if (req.body.hold) {
      if (barrier) return reply.code(409).send({ error: 'Response barrier already armed' })
      barrier = { kind: req.body.kind, received: false }
      gate = new Promise<void>(resolve => { release = resolve })
    } else {
      if (barrier?.kind !== req.body.kind) return reply.code(409).send({ error: 'Response barrier mismatch' })
      release?.()
      barrier = undefined
      gate = undefined
      release = undefined
    }
    return { armed: req.body.hold }
  })
  app.get('/device-fixture/response-barrier', async () => barrier ?? { received: false })
  app.addHook('preHandler', async req => {
    const route = req.routeOptions.url ?? ''
    if (!Object.values(responseRoutes).some(value => value.method === req.method && value.route === route)) return
    const params = req.params as { id?: string }
    const body = req.body as { requestKey?: string } | undefined
    tradeRequests.push({ id: req.id, method: req.method, route, requestKey: body?.requestKey, orderId: params.id, body,
      stateBefore: params.id ? context.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', params.id)?.state : undefined })
  })
  app.addHook('onSend', async (req, reply, payload) => {
    const recorded = tradeRequests.find(value => value.id === req.id)
    if (recorded) {
      recorded.status = reply.statusCode
      if (recorded.orderId) recorded.stateAfter = context.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', recorded.orderId)?.state
    }
    const current = barrier
    const expected = current ? responseRoutes[current.kind] : undefined
    if (current && expected && !current.received && req.method === expected.method && req.routeOptions.url === expected.route && reply.statusCode === 200) {
      current.received = true
      current.orderId = (req.params as { id?: string }).id
      current.request = req.body
      current.response = typeof payload === 'string' ? JSON.parse(payload) : undefined
      await gate
    }
    return payload
  })
  app.post<{ Body: { orderId?: string; preset: unknown } }>('/device-fixture/payment-preset', async (req, reply) => {
    const payment = req.body.orderId ? context.db.one<{ id: string }>("SELECT id FROM payments WHERE order_id=? AND state='pending' ORDER BY created DESC LIMIT 1", req.body.orderId) : undefined
    if (req.body.orderId && !payment) return reply.code(404).send({ error: 'No pending payment' })
    return context.testData.payments({ paymentId: payment?.id ?? 'next', preset: req.body.preset })
  })
  app.get<{ Params: { orderId: string } }>('/device-fixture/orders/:orderId/payments', async (req, reply) => {
    const orderId = req.params.orderId
    const order = context.db.one('SELECT id,state,amount,request_key,request_body,received_by,received_at FROM orders WHERE id=?', orderId)
    if (!order) return reply.code(404).send({ error: 'Fixture order not found' })
    return { order,
      payments: context.db.all('SELECT id,order_id,amount,state,payer_id FROM payments WHERE order_id=?', orderId),
      refunds: context.db.all('SELECT refunds.id,refunds.amount,refunds.state,refunds.reason,refunds.attempts FROM refunds JOIN payments ON payments.id=refunds.payment_id WHERE payments.order_id=?', orderId),
      cancelRequests: context.db.all('SELECT * FROM order_cancel_requests WHERE order_id=? ORDER BY sequence', orderId),
      cancelActions: context.db.all('SELECT * FROM order_cancel_actions WHERE order_id=? ORDER BY created,id', orderId) }
  })
  await app.inject({ method: 'POST', url: '/member/cart', headers: { authorization: 'Bearer ' + buyer.token }, payload: { skuId: sku.id, count: 1, requestKey: randomUUID() } })
  tradeRequests.length = 0
  return { context, password, skuId: sku.id, addressId: address.id, close: async () => {
    release?.()
    await app.close()
    await rm(uploadsPath, { recursive: true, force: true })
  } }
}
