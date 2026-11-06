import Fastify, { LogController } from 'fastify'
import type { FastifyRequest, HTTPMethods } from 'fastify'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Database } from './database.ts'
import { Accounts, type User } from './accounts.ts'
import { Catalog } from './catalog.ts'
import { Orders } from './orders.ts'
import { Payments } from './payments.ts'
import { MockPaymentChannel } from './payment-channel.ts'
import { AppError, ensure } from './errors.ts'
import { TestFixtures, registerFixtureRoutes } from './test-fixtures.ts'
import { systemClock, type Clock } from './clock.ts'
import { validateRuntimeOptions, type RuntimeOptions } from './config.ts'
import { inventoryPage, stockMovements, adjustStock, adjustmentReceipt } from './inventory.ts'

export interface AppOptions extends RuntimeOptions { databasePath: string; uploadsPath: string; logger?: boolean; clock?: Clock }
const idSchema = z.string().min(1).max(100)
const credentials = z.object({ account: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/), password: z.string().min(8).max(128) })
const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(10), orderState: z.coerce.number().int().min(0).max(6).default(0) })
const addressFields = z.object({ receiver: z.string().trim().min(1).max(50), contact: z.string().regex(/^\d{6,20}$/), address: z.string().trim().min(1).max(300), fullLocation: z.string().max(100).optional(), provinceCode: z.union([z.string(),z.number()]).optional(), cityCode: z.union([z.string(),z.number()]).optional(), countyCode: z.union([z.string(),z.number()]).optional(), isDefault: z.union([z.literal(0), z.literal(1)]) })
const addressSaveFields = { requestKey: z.string().uuid().optional(), revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() }
const createAddressFields = addressFields.extend({ isDefault: addressFields.shape.isDefault.default(1), ...addressSaveFields })
const updateAddressFields = addressFields.partial().extend(addressSaveFields)
const key = (req: FastifyRequest) => z.object({ id: idSchema }).parse(req.params).id
function maskNickname(nickname: string): string { const chars = Array.from(nickname); return `${chars[0] ?? ''}***${chars.length > 2 ? chars[chars.length - 1] : ''}` }

export async function buildApp(options: AppOptions) {
  validateRuntimeOptions(options)
  const db = new Database(options.databasePath)
  const clock = options.clock ?? systemClock
  const accounts = new Accounts(db, options.publicUrl, clock), catalog = new Catalog(db, options.publicUrl, clock)
  const paymentCallbackSecret = options.paymentCallbackSecret ?? 'development-payment-callback-secret-32-bytes'
  const paymentChannel = options.paymentChannel !== undefined ? options.paymentChannel ?? undefined :
    (options.mockPayments || options.testMode ? new MockPaymentChannel(paymentCallbackSecret) : undefined)
  const payments = new Payments(db, accounts, paymentChannel, paymentCallbackSecret, clock)
  const orders = new Orders(db, accounts, catalog, options.mockPayments, clock)
  orders.attachPayments(payments)
  if (!options.testFixtures) catalog.seed()
  const fixtures = options.testFixtures ? new TestFixtures(accounts, options.testFixtures.credential, payments) : undefined
  const app = Fastify({ logger: options.logger ?? false, logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024, trustProxy: options.trustedProxies?.length ? options.trustedProxies : false })
  if (options.production && options.corsOrigins?.includes('null')) app.log.warn('CORS_ORIGINS 显式允许 Origin null：已开放打包 ArkWeb 等不透明来源，请仅在需要内嵌 H5 时启用并保留 Bearer token 鉴权')
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' })
  await app.register(multipart, { limits: { fileSize: 512 * 1024, files: 1, fields: 0 } })
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store')
    const origin = req.headers.origin
    if (origin && options.corsOrigins?.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin')
      reply.header('Access-Control-Allow-Headers', 'Authorization,Content-Type').header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
    } else if (origin) throw new AppError(403, '页面来源不受信任')
  })
  app.addHook('onResponse', async (req, reply) => {
    app.log.info({ requestId: req.id, route: req.routeOptions.url, method: req.method, status: reply.statusCode }, 'request completed')
  })
  app.setErrorHandler((error, req, reply) => {
    const status = error instanceof z.ZodError ? 400 : error instanceof AppError ? error.statusCode : (error as { statusCode?: number }).statusCode ?? 500
    const msg = error instanceof z.ZodError ? '参数不正确，请检查输入' : error instanceof AppError ? error.message : status === 429 ? '操作太频繁，请稍后重试' : status === 413 ? '文件或请求过大' : '服务暂时不可用'
    if (status >= 500) app.log.error({ requestId: req.id, error: error instanceof Error ? error.message : 'unknown' }, 'request failed')
    reply.code(status).send({ code: '0', msg, requestId: req.id,
      ...(error instanceof AppError && error.reason ? { reason: error.reason, result: error.data } : {}) })
  })
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ code: '0', msg: '接口不存在' }))
  const ok = (result: unknown) => ({ code: '1', result })
  const protectedRoute = (method: HTTPMethods, url: string, handler: (req: FastifyRequest, user: User) => unknown) => {
    app.route({ method, url, handler: async req => ok(await handler(req, accounts.authenticate(req.headers.authorization))) })
  }
  if (fixtures) registerFixtureRoutes(app, fixtures)
  app.options('/*', async (_req, reply) => reply.code(204).send())
  app.get('/health', async () => ok({ status: 'ok', mockPayments: options.mockPayments }))
  app.get('/ready', async () => ok(db.one('SELECT 1 AS ready')))
  app.post('/register', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const data = credentials.parse(req.body); return ok(accounts.register(data.account, data.password))
  })
  app.post('/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async req => {
    const data = credentials.parse(req.body); return ok(accounts.login(data.account, data.password))
  })
  protectedRoute('POST', '/logout', req => { accounts.logout(req.headers.authorization!); return null })
  protectedRoute('GET', '/member/profile', (req, user) => ({ ...accounts.profile(user), token: req.headers.authorization!.slice(7) }))
  protectedRoute('PUT', '/member/profile', (req, user) => {
    const data = z.object({ nickname: z.string().trim().min(1).max(50), gender: z.enum(['男','女','未知']), birthday: z.string().max(20), profession: z.string().max(100), provinceCode: z.string().max(20), cityCode: z.string().max(20), countyCode: z.string().max(20), fullLocation: z.string().max(100).optional() }).parse(req.body)
    return { ...accounts.updateProfile(user, data), token: req.headers.authorization!.slice(7) }
  })
  protectedRoute('POST', '/member/profile/avatar', async (req, user) => {
    const file = await req.file(); ensure(file, 400, '请选择头像')
    const buffer = await file.toBuffer()
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    ensure(jpeg && file.mimetype === 'image/jpeg', 400, '仅支持 JPEG 头像')
    const name = `${randomUUID()}.jpg`
    await mkdir(options.uploadsPath, { recursive: true })
    await writeFile(join(options.uploadsPath, name), buffer)
    const profile = accounts.updateProfile(user, { avatar: `/uploads/${name}` })
    return { avatar: profile.avatar }
  })
  app.get('/uploads/:name', async (req, reply) => {
    const { name } = z.object({ name: z.string().uuid().transform(v => v) }).parse({ name: (req.params as { name: string }).name.replace(/\.jpg$/, '') })
    try { return reply.type('image/jpeg').send(await readFile(join(options.uploadsPath, name + '.jpg'))) }
    catch { throw new AppError(404, '图片不存在') }
  })
  app.get('/assets/product.svg', async (_req, reply) => reply.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" rx="32" fill="#fff0e8"/><path d="M100 145h200v170H100zM150 145v-35h100v35" fill="none" stroke="#ba4e32" stroke-width="12"/><text x="200" y="245" text-anchor="middle" font-size="42" fill="#ba4e32">HDM</text></svg>'))
  app.get('/home/banner', async () => ok([{ id: 'self-1', imgUrl: options.publicUrl + '/assets/product.svg', hrefUrl: '/category/category-0', type: '1' }]))
  for (const route of ['/home/category/head', '/category/top']) app.get(route, async () => { orders.expireIfDue(); return ok(catalog.categories()) })
  for (const route of ['/home/new', '/home/recommend']) app.get(route, async () => { orders.expireIfDue(); return ok(catalog.list()) })
  app.get('/category/summary', async () => { orders.expireIfDue(); return ok(catalog.categorySummary()) })
  for (const route of ['/home/new/page', '/home/recommend/page']) app.get(route, async req => {
    const query = pageSchema.parse(req.query)
    orders.expireIfDue()
    return ok(catalog.listPage(query.page, query.pageSize))
  })
  app.get('/home/goods/guessLike', async req => {
    const query = pageSchema.parse(req.query)
    orders.expireIfDue()
    return ok(catalog.listPage(query.page, query.pageSize))
  })
  app.get('/hot/:type', async req => {
    const query = pageSchema.parse(req.query)
    orders.expireIfDue()
    return ok({ id: 'hot', title: '自营精选', subTypes: [{ id: 'all', title: '全部', goodsItems: catalog.listPage(query.page, query.pageSize) }] })
  })
  app.get('/goods', async req => { orders.expireIfDue(); return catalog.detail(z.object({ id: idSchema }).parse(req.query).id) })
  app.post('/search/all', async req => {
    const data = z.object({ keyword: z.string().max(100).default(''), categoryId: z.string().max(100).optional(), sortField: z.enum(['publishTime','orderNum','price']).default('publishTime'), sortMethod: z.enum(['asc','desc']).default('desc') }).parse(req.body)
    const query = pageSchema.parse(req.body)
    orders.expireIfDue()
    return ok({ pageData: catalog.listPage(query.page, query.pageSize, data.keyword, data.categoryId, data.sortField, data.sortMethod) })
  })
  app.get('/goods/:id/evaluate/page', async req => {
    const productId = key(req), query = pageSchema.parse(req.query)
    // 先校验，再以同一商品条件计数和取页；EXISTS 避免同单多个规格重复展示评价。
    const from = `FROM evaluations e JOIN orders o ON o.id=e.order_id JOIN users u ON u.id=o.owner_id
      WHERE EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=e.order_id AND i.product_id=?)`
    const counts = db.one<{ count: number }>(`SELECT COUNT(*) AS count ${from}`, productId)!.count
    const offset = (query.page - 1) * query.pageSize
    // 超出总数时直接返回空页，也避免极大页码的偏移量溢出 SQLite 整数范围。
    const rows = offset >= counts ? [] : db.all<{ order_id: string; content: string; score: number; created: number; nickname: string }>(
      `SELECT e.*,u.nickname ${from} ORDER BY e.created DESC,e.order_id ASC LIMIT ? OFFSET ?`, productId, query.pageSize, offset)
    const items = rows.map(r => ({ id: r.order_id, content: r.content, score: r.score, createTime: new Date(r.created).toISOString(), pictures: [], member: { nickname: maskNickname(r.nickname) } }))
    return ok({ items, counts, pages: Math.ceil(counts / query.pageSize), page: query.page, pageSize: query.pageSize })
  })
  protectedRoute('GET', '/member/address', (_req, user) => accounts.addresses(user))
  protectedRoute('GET', '/member/address/:id', (req, user) => { const address = accounts.addresses(user).find(a => a.id === key(req)); ensure(address, 404, '地址不存在'); return address })
  protectedRoute('POST', '/member/address', (req, user) => {
    const { requestKey, revision, ...address } = createAddressFields.parse(req.body)
    return accounts.saveAddress(user, address, undefined, requestKey, revision)
  })
  protectedRoute('PUT', '/member/address/:id', (req, user) => {
    const { requestKey, revision, ...address } = updateAddressFields.parse(req.body)
    return accounts.saveAddress(user, address, key(req), requestKey, revision)
  })
  protectedRoute('DELETE', '/member/address/:id', (req, user) => accounts.deleteAddress(user, key(req)))
  protectedRoute('GET', '/member/cart', (_req, user) => { orders.expireIfDue(); return catalog.cart(user) })
  protectedRoute('GET', '/member/cart/count', (_req, user) => ({ count: catalog.cartCount(user) }))
  protectedRoute('POST', '/member/cart', (req, user) => {
    orders.expire(); const data = z.object({ skuId: idSchema, count: z.number().int().min(1).max(999), requestKey: z.string().uuid() }).parse(req.body)
    return catalog.addCart(user, data.skuId, data.count, data.requestKey)
  })
  protectedRoute('PUT', '/member/cart/:id', (req, user) => catalog.updateCart(user, key(req), z.object({ selected: z.boolean().optional(), count: z.number().int().min(1).max(999).optional() }).parse(req.body)))
  protectedRoute('DELETE', '/member/cart', (req, user) => {
    const { ids } = z.object({ ids: z.array(idSchema).max(100) }).parse(req.body)
    db.transaction(() => { for (const id of ids) db.run('DELETE FROM carts WHERE user_id=? AND sku_id=?', user.id, id) }); return null
  })
  protectedRoute('GET', '/member/relations', (_req, user) => accounts.relations(user))
  protectedRoute('GET', '/member/relations/page', (req, user) => {
    const query = pageSchema.parse(req.query)
    const { scope } = z.object({ scope: z.enum(['all', 'payer']).default('all') }).parse(req.query)
    return accounts.relationsPage(user, query.page, query.pageSize, scope)
  })
  protectedRoute('POST', '/member/relations', (req, user) => accounts.invite(user, z.object({ account: credentials.shape.account }).parse(req.body).account))
  protectedRoute('PUT', '/member/relations/:id', (req, user) => accounts.updateRelation(user, key(req), z.object({ action: z.enum(['accept','revoke']) }).parse(req.body).action))
  protectedRoute('GET', '/member/order/pre', (req, user) => {
    const query = z.object({ skuId: idSchema.optional(), count: z.coerce.number().int().min(1).max(999).optional() }).parse(req.query)
    ensure((query.skuId === undefined) === (query.count === undefined), 400, '请同时指定规格和数量')
    return orders.preOrder(user, query.skuId === undefined ? undefined : { skuId: query.skuId, count: query.count! })
  })
  protectedRoute('GET', '/member/order/by-request/:requestKey', (req, user) => orders.byRequest(user,
    z.object({ requestKey: z.string().min(16).max(100) }).parse(req.params).requestKey))
  protectedRoute('POST', '/member/order', (req, user) => orders.create(user, z.object({ source: z.enum(['cart', 'buy-now']).default('cart'), requestKey: z.string().min(16).max(100), expectedAmountCents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), addressId: idSchema, goods: z.array(z.object({ skuId: idSchema, count: z.number().int().min(1).max(999) })).min(1).max(100) }).parse(req.body)))
  protectedRoute('GET', '/member/order', (req, user) => {
    const query = pageSchema.parse(req.query)
    return orders.listPage(user, query.orderState, query.page, query.pageSize)
  })
  protectedRoute('GET', '/member/family-orders', (_req, user) => orders.list(user, 0, true))
  protectedRoute('GET', '/member/family-orders/page', (req, user) => {
    const query = pageSchema.parse(req.query)
    return orders.familyPage(user, query.page, query.pageSize)
  })
  protectedRoute('GET', '/member/order/attention', (_req, user) => payments.attentionCount(user))
  protectedRoute('GET', '/member/order/:id', (req, user) => orders.detail(user, key(req)))
  protectedRoute('PUT', '/member/order/:id/payer', (req, user) => orders.invitePayer(user, key(req), z.object({ friendId: idSchema.nullable() }).parse(req.body).friendId))
  protectedRoute('POST', '/member/order/:id/payments', (req, user) => payments.start(user, key(req), z.object({ amountCents: z.number().int().positive() }).parse(req.body).amountCents))
  protectedRoute('POST', '/member/order/:id/payments/refresh', (req, user) => payments.refresh(user, key(req)))
  protectedRoute('POST', '/member/order/:id/mock-pay', (req, user) => {
    ensure(options.mockPayments, 403, '此环境未启用模拟支付')
    return payments.mockPay(user, key(req), z.object({ amountCents: z.number().int().positive() }).parse(req.body).amountCents)
  })
  app.post('/payments/callback', async req => {
    try {
      const data = z.object({ paymentId: idSchema, orderId: idSchema, amount: z.number().int().positive(),
        state: z.enum(['success', 'fail']), paidAt: z.number().int().optional(), signature: z.string().min(1).max(256) }).parse(req.body)
      const { signature, ...payload } = data
      return ok(await payments.callbackPayload(payload, signature))
    } catch (error) {
      req.log.warn({ requestId: req.id }, 'Payment callback rejected')
      throw error
    }
  })
  protectedRoute('GET', '/order-cancel-actions/by-request/:requestKey', (req, user) => orders.cancelActionReceipt(user,
    z.object({ requestKey: z.string().uuid() }).parse(req.params).requestKey))
  protectedRoute('POST', '/member/order/:id/cancel-requests', (req, user) => orders.requestCancel(user, key(req),
    z.object({ requestKey: z.string().uuid() }).strict().parse(req.body).requestKey))
  protectedRoute('POST', '/member/order/:id/cancel-requests/:cancelRequestId/withdraw', (req, user) => orders.withdrawCancel(user, key(req),
    z.object({ cancelRequestId: z.string().uuid() }).parse(req.params).cancelRequestId,
    z.object({ requestKey: z.string().uuid() }).strict().parse(req.body).requestKey))
  protectedRoute('PUT', '/member/order/:id/cancel', (req, user) => orders.cancel(user, key(req)))
  protectedRoute('POST', '/member/order/:id/reminder', (req, user) => orders.remind(user, key(req)))
  protectedRoute('PUT', '/member/order/:id/receipt', (req, user) => orders.receive(user, key(req)))
  protectedRoute('PUT', '/member/order/:id/evaluation', (req, user) => {
    const data = z.object({ score: z.number().int().min(1).max(5), content: z.string().trim().min(5).max(500) }).parse(req.body)
    return orders.evaluate(user, key(req), data.score, data.content)
  })
  protectedRoute('GET', '/merchant/orders', (_req, user) => orders.merchantList(user))
  protectedRoute('GET', '/merchant/orders/page', (req, user) => {
    const query = pageSchema.parse(req.query)
    return orders.merchantPage(user, query.page, query.pageSize)
  })
  protectedRoute('GET', '/merchant/payments/review', (req, user) => {
    const query = pageSchema.pick({ page: true, pageSize: true }).parse(req.query)
    return payments.reviewPage(user, query.page, query.pageSize)
  })
  protectedRoute('POST', '/merchant/payments/:id/requery', (req, user) => payments.requery(user, key(req)))
  protectedRoute('PUT', '/merchant/payments/:id/resolution', (req, user) => payments.resolve(user, key(req),
    z.object({ outcome: z.enum(['paid', 'unpaid']), paidAt: z.number().int().positive().optional(), reason: z.string().trim().min(5).max(200), requestKey: z.string().uuid() }).parse(req.body)))
  protectedRoute('POST', '/merchant/refunds/:id/retry', (req, user) => payments.retryRefund(user, key(req),
    z.object({ requestKey: z.string().uuid() }).parse(req.body).requestKey))
  protectedRoute('GET', '/merchant/inventory', (req, user) => {
    const query = pageSchema.pick({ page: true, pageSize: true }).extend({ skuId: idSchema.optional() }).parse(req.query)
    return inventoryPage(db, user, query)
  })
  protectedRoute('GET', '/merchant/inventory/:id/movements', (req, user) =>
    stockMovements(db, user, key(req), pageSchema.pick({ page: true, pageSize: true }).parse(req.query)))
  protectedRoute('GET', '/merchant/inventory/adjustments/:id', (req, user) =>
    adjustmentReceipt(db, user, z.string().uuid().parse(key(req))))
  protectedRoute('PUT', '/merchant/inventory/:id/adjustments', (req, user) =>
    adjustStock(db, user, key(req), z.object({ requestKey: z.string().uuid(),
      delta: z.number().int().min(-1000000).max(1000000).refine(value => value !== 0),
      expectedStock: z.number().int().min(0).max(2147483647), reason: z.string().trim().min(5).max(200) }).parse(req.body), clock))
  protectedRoute('POST', '/merchant/orders/:id/cancel-requests/:cancelRequestId/resolve', (req, user) => orders.resolveCancel(user, key(req),
    z.object({ cancelRequestId: z.string().uuid() }).parse(req.params).cancelRequestId,
    z.discriminatedUnion('decision', [
      z.object({ requestKey: z.string().uuid(), decision: z.literal('approve') }).strict(),
      z.object({ requestKey: z.string().uuid(), decision: z.literal('reject-and-ship'), reason: z.string().optional() }).strict()
    ]).parse(req.body)))
  protectedRoute('POST', '/merchant/orders/:id/ship', (req, user) => orders.ship(user, key(req)))
  const processCancelRequests = () => {
    const result = orders.processDueCancelRequests(clock.now())
    if (result.failed.length) app.log.error({ cancelRequestIds: result.failed }, 'Order cancellation processing failed')
  }
  processCancelRequests()
  const timer = setInterval(() => {
    try { orders.expire() } catch { app.log.error('Order expiration failed') }
    try { catalog.cleanupCartRequests() } catch { app.log.error('Cart request cleanup failed') }
    try { processCancelRequests() } catch { app.log.error('Order cancellation scan failed') }
    void payments.reconcile().catch(() => app.log.error('Payment reconciliation failed'))
  }, 30_000).unref()
  app.addHook('onClose', async () => { clearInterval(timer); db.close() })
  return { app, db, accounts, catalog, orders, payments, clock, fixtures }
}
