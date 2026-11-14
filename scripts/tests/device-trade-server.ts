// 独立内存数据；Full 模式只准备账号、地址和购物袋，分页探针另行准备订单。
import { buildTestApp } from '../../server/test/helpers/fixtures.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { randomUUID, randomBytes } from 'node:crypto'
import { MockPaymentChannel } from '../../server/src/payment-channel.ts'
import { beijingDate } from '../../server/src/channel-bill.ts'
const paymentCallbackSecret = randomUUID()
const channel = new MockPaymentChannel(paymentCallbackSecret)
const refund = channel.refund.bind(channel)
let heldPaymentId: string | undefined
let refundBarrier: Promise<void> | undefined
let releaseRefund: (() => void) | undefined
const activeRefunds = new Map<string, Promise<'success' | 'fail'>>()
const fixturePassword = randomBytes(24).toString('hex')
let clockOffset = 0
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
const uploadsPath = mkdtempSync(join(tmpdir(), 'hdm-device-trade-uploads-' + process.pid + '-'))
const f = await buildTestApp({ databasePath: ':memory:', mockPayments: true,
  paymentChannel: channel, paymentCallbackSecret, corsOrigins: ['null'], clock: {now:()=>Date.now()+clockOffset},
  publicUrl: 'http://127.0.0.1:3000', uploadsPath })
const product = f.testData.product({ name: '设备独立测试商品',
  skus: [{ spec: '标准款', priceCents: 2371, stock: 23 }] })
const sku = product.skus[0]!
const s1 = process.argv.includes('--s1')
const s2 = process.argv.includes('--s2')
const loginProbe = process.argv.includes('--login-probe')
const extra = s2 || loginProbe ? f.testData.product({ name: '购物车保留商品', skus: [{ spec: '保留款', priceCents: 1109, stock: 19 }] }) : undefined
for (const account of ['device_buyer', 'device_friend', 'device_merchant']) {
  f.testData.account({ account, password: fixturePassword, role: account === 'device_merchant' ? 'merchant' : 'buyer' })
}
const buyer = f.accounts.login('device_buyer', fixturePassword)
const user = f.accounts.authenticate(`Bearer ${buyer.token}`)
const address = s1 ? undefined : f.testData.address({ userId: user.id, receiver: '设备验收', contact: '13800138000', fullLocation: '测试省 测试市 测试区',
  provinceCode: 'test', cityCode: 'test', countyCode: 'test', address: '独立模拟器验收地址', isDefault: 0 })
// Inventory mode prepares returned goods only; inspection is performed through the native UI.
if (process.argv.includes('--inventory-probe')) {
  const merchantLogin = f.accounts.login('device_merchant', fixturePassword)
  const merchant = f.accounts.authenticate('Bearer ' + merchantLogin.token)
  const returned: { orderId: string; afterSaleId: string; count: number }[] = []
  const prepareReturn = async (item: typeof sku, count: number, bought: number) => {
    const order = f.orders.create(user, { requestKey: randomUUID(), expectedAmountCents: item.priceCents * bought, addressId: address!.id, goods: [{ skuId: item.id, count: bought }] })
    await f.orders.pay(user, order.id, item.priceCents * bought)
    await f.orders.ship(merchant, order.id, { carrier: '顺丰', trackingNo: 'SF12345678' })
    const request = await f.afterSales.request(user, order.id, { requestKey: randomUUID(), kind: 'return-quality', description: '库存验收测试商品退回', items: [{ skuId: item.id, count }] })
    await f.afterSales.act(merchant, request.afterSaleId, 'approve', { requestKey: randomUUID(), returnAddress: { receiver: '验收仓库', contact: '13800138000', address: '库存验收测试仓库' } })
    const key = randomUUID()
    const image = f.afterSales.uploadImage(user, order.id, key, randomUUID(), Buffer.from([255, 216, 255, 224, 255, 217]), uploadsPath)
    await f.afterSales.act(user, request.afterSaleId, 'ship-back', { requestKey: key, carrier: 'SF', trackingNo: 'SF123456789', shippingAmountCents: 100, shippingImageId: image.imageId })
    return { orderId: order.id, afterSaleId: request.afterSaleId, count }
  }
  for (const count of [2, 1]) returned.push(await prepareReturn(sku, count, 3))
  const historySku = f.testData.product({ name: '库存历史验证商品', skus: [{ spec: '标准款', priceCents: 1000, stock: 40 }] }).skus[0]!
  for (let index = 0; index < 5; index++) {
    const history = await prepareReturn(historySku, 1, 1)
    await f.afterSales.act(merchant, history.afterSaleId, 'inspect', { requestKey: randomUUID(), items: [{ skuId: historySku.id, restockCount: 0 }] })
  }
  const emptySku = f.testData.product({ name: '库存对照商品', skus: [{ spec: '标准款', priceCents: 900, stock: 7 }] }).skus[0]!
  f.app.get('/device-fixture/inventory', async () => ({ returned, historySkuId: historySku.id, emptySkuId: emptySku.id }))
}
f.app.get<{Params:{account:string}}>('/device-fixture/form/:account',async(req,reply)=>{
 if(!/^device_(buyer|friend|merchant)$/.test(req.params.account))return reply.code(404).send({code:'0'})
 return {code:'1',result:{fixture:'device-trade-form',password:fixturePassword}}
})
if (process.argv.includes('--logistics-probe')) {
  f.app.post<{ Body: { orderId: string; events: unknown } }>('/device-fixture/logistics', async req =>
    f.logistics.pushMock(req.body.orderId, req.body.events))
}
if (process.argv.includes('--reconcile-probe')) {
  let prepared = false
  f.app.post('/device-fixture/reconciliation', async (_req, reply) => {
    if (prepared) return reply.code(409).send({ error: 'Reconciliation fixture already prepared' })
    prepared = true
    for (let i = 0; i < 3; i++) {
      const order = f.orders.create(user, { requestKey: randomUUID(), expectedAmountCents: sku.priceCents,
        addressId: address!.id, goods: [{ skuId: sku.id, count: 1 }] })
      await f.orders.pay(user, order.id, sku.priceCents)
    }
    const date = beijingDate(f.clock.now()), rows = channel.exportBill(date)
    channel.setBill(date, [{ ...rows[0]!, businessId: 'external-only', channelId: 'external-channel-only' },
      { ...rows[1]!, amountCents: sku.priceCents + 100 }, { ...rows[2]!, state: 'pending' }])
    return { date, expectedCategories: ['amount', 'channel-only', 'local-only', 'state'] }
  })
}
f.app.post<{Body:{milliseconds:number}}>('/device-fixture/advance',async(req,reply)=>{
 if(!Number.isSafeInteger(req.body.milliseconds)||req.body.milliseconds<0||req.body.milliseconds>4*366*86400000)return reply.code(400).send({error:'invalid clock advance'})
 clockOffset+=req.body.milliseconds
 f.db.run('UPDATE sessions SET expires=?',f.clock.now()+86400000)
 await f.payments.reconcile();await f.orders.processDueCancelRequests(f.clock.now());await f.afterSales.processDue();await f.lifecycle.scan()
 return {now:f.clock.now()}
})
f.app.get('/device-fixture/lifecycle',async()=>({
 users:f.db.all('SELECT id,account,status,deletion_due_at FROM users'),
 orders:f.db.all('SELECT id,state,owner_id,paid_by FROM orders'),
 consents:f.db.all('SELECT version,source,action FROM consents'),
 sessions:f.db.one<{n:number}>('SELECT COUNT(*) n FROM sessions')!.n
}))
f.app.get('/device-fixture', async () => ({ fixture: 'device-trade', pid: process.pid, uploadsPath,
  skuId: sku.id, productId: product.id, amountCents: sku.priceCents, initialStock: sku.stock,
  extraSkuId: extra?.skus[0]?.id, mode: s1 ? 'S1' : s2 ? 'S2' : loginProbe ? 'LoginProbe' : 'default' }))
type ResponseKind = 'order' | 'payment' | 'cancel' | 'receipt' | 'evaluation'
const responseRoutes: Record<ResponseKind, { method: string; route: string }> = {
  order: { method: 'POST', route: '/member/order' },
  payment: { method: 'POST', route: '/member/order/:id/payments' },
  cancel: { method: 'PUT', route: '/member/order/:id/cancel' },
  receipt: { method: 'PUT', route: '/member/order/:id/receipt' },
  evaluation: { method: 'PUT', route: '/member/order/:id/evaluation' }
}
let responseBarrier: { kind: ResponseKind; received: boolean; response?: unknown; request?: unknown; orderId?: string } | undefined
let responseGate: Promise<void> | undefined
let releaseResponse: (() => void) | undefined
type TradeRequest = { id: string; method: string; route: string; requestKey?: string; orderId?: string;
  body?: unknown; status?: number; stateBefore?: number; stateAfter?: number }
const tradeRequests: TradeRequest[] = []
f.app.get('/device-fixture/trade-requests', async () => tradeRequests)
f.app.post('/device-fixture/expire-buyer-session', async () => {
  const before = f.db.all('SELECT digest FROM sessions WHERE user_id=?', user.id).length
  f.db.run('DELETE FROM sessions WHERE user_id=?', user.id)
  return { account: 'device_buyer', removed: before,
    remaining: f.db.all('SELECT digest FROM sessions WHERE user_id=?', user.id).length }
})
f.app.addHook('preHandler', async req => {
  const route = req.routeOptions.url ?? ''
  if ((req.method === 'POST' && ['/member/order', '/member/cart', '/member/order/:id/payments'].includes(route)) ||
    (req.method === 'GET' && route === '/member/order/by-request/:requestKey') ||
    (req.method === 'PUT' && Object.values(responseRoutes).some(value => value.method === 'PUT' && value.route === route))) {
    const params = req.params as { id?: string; requestKey?: string }
    const body = req.body as { requestKey?: string } | undefined
    tradeRequests.push({ id: req.id, method: req.method, route, requestKey: body?.requestKey ?? params.requestKey,
      orderId: params.id, body, stateBefore: params.id ? f.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', params.id)?.state : undefined })
  }
})
f.app.post<{ Body: { kind: ResponseKind; hold: boolean } }>('/device-fixture/response-barrier', {
  schema: { body: { type: 'object', required: ['kind', 'hold'], additionalProperties: false,
    properties: { kind: { type: 'string', enum: Object.keys(responseRoutes) }, hold: { type: 'boolean' } } } }
}, async (req, reply) => {
  if (req.body.hold) {
    if (responseBarrier) return reply.code(409).send({ error: 'Response barrier already armed' })
    responseBarrier = { kind: req.body.kind, received: false }
    responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
  } else {
    if (responseBarrier?.kind !== req.body.kind) return reply.code(409).send({ error: 'Response barrier mismatch' })
    releaseResponse?.()
    responseBarrier = undefined
    responseGate = undefined
    releaseResponse = undefined
  }
  return { armed: req.body.hold }
})
f.app.get('/device-fixture/response-barrier', async () => responseBarrier ?? { received: false })
f.app.addHook('onSend', async (req, reply, payload) => {
  const recorded = tradeRequests.find(value => value.id === req.id)
  if (recorded) {
    recorded.status = reply.statusCode
    if (recorded.orderId) recorded.stateAfter = f.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', recorded.orderId)?.state
  }
  const barrier = responseBarrier
  const expected = barrier ? responseRoutes[barrier.kind] : undefined
  if (barrier && expected && !barrier.received && req.method === expected.method && reply.statusCode === 200 && req.routeOptions.url === expected.route) {
    barrier.received = true
    barrier.orderId = (req.params as { id?: string }).id
    barrier.request = req.body
    barrier.response = typeof payload === 'string' ? JSON.parse(payload) : undefined
    await responseGate
  }
  return payload
})
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
    const due=f.db.one<{at:number|null}>("SELECT MIN(next_attempt_at) at FROM refunds WHERE payment_id=? AND state<>'succeeded'",paymentId)?.at
    if(due&&due>f.clock.now())clockOffset+=due-f.clock.now()+1
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
  const order = f.db.one('SELECT id,state,amount,request_key,request_body,received_by,received_at FROM orders WHERE id=?', orderId)
  if (!order) return reply.code(404).send({ error: 'Fixture order not found' })
  return { order,
    evaluations: f.db.all('SELECT * FROM evaluations WHERE order_id=?', orderId),
    payments: f.db.all(`SELECT payments.id,order_id,amount,state,created,channel_paid_at,next_query_at,payer_id,
      (SELECT account FROM users WHERE users.id=payments.payer_id) AS payerAccount
      FROM payments WHERE order_id=? ORDER BY created,id`, orderId),
    refunds: f.db.all(`SELECT refunds.id,payment_id,refunds.amount,refunds.state,reason,attempts,refunds.next_attempt_at FROM refunds
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
if (!s1 && !loginProbe) await f.app.inject({ method: 'POST', url: '/member/cart', headers: { authorization: `Bearer ${buyer.token}` }, payload: { skuId: sku.id, count: s2 ? 2 : 1, requestKey: randomUUID() } })
if (extra) await f.app.inject({ method: 'POST', url: '/member/cart', headers: { authorization: `Bearer ${buyer.token}` }, payload: { skuId: extra.skus[0]!.id, count: 1, requestKey: randomUUID() } })
if (process.argv.includes('--relations')) {
  for (let index = 0; index <= 10; index++) {
    const account = `probe_${String(index).padStart(2, '0')}`
    const friend = f.testData.account({ account, password: fixturePassword })
    const id = f.testData.relation({ ownerId: user.id, friendId: friend.id }).id
    f.db.run('UPDATE relations SET created=? WHERE id=?', 1000 + index, id)
  }
}
if (process.argv.includes('--cancel-family') || s2) {
  const friend = f.accounts.login('device_friend', fixturePassword)
  f.testData.relation({ ownerId: user.id, friendId: friend.id })
}
// 分页探针单独准备 11 笔代付订单；Full 模式仍由设备完成全部交易操作。
if (process.argv.includes('--pagination')) {
  const friend = f.accounts.login('device_friend', fixturePassword)
  const friendUser = f.accounts.authenticate(`Bearer ${friend.token}`)
  f.testData.relation({ ownerId: user.id, friendId: friend.id })
  const orders = f.orders
  for (let index = 1; index <= 11; index++) {
    const order = orders.create(user, { requestKey: randomUUID(), expectedAmountCents: sku.priceCents, addressId: address!.id, goods: [{ skuId: sku.id, count: 1 }] })
    orders.invitePayer(user, order.id, friend.id)
    orders.pay(friendUser, order.id, sku.priceCents)
    f.db.run('UPDATE orders SET created=? WHERE id=?', f.clock.now() - 60000 + index, order.id)
    f.db.run('UPDATE order_items SET name=? WHERE order_id=?', `分页商品 ${String(index).padStart(2, '0')}`, order.id)
  }
}
tradeRequests.length = 0
await f.app.listen({ port: 3103, host: '127.0.0.1' })
console.log('RESULT isolated trade fixture ready')
