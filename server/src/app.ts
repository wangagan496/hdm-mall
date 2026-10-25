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
import { AppError, ensure } from './errors.ts'

export interface AppOptions { databasePath: string; publicUrl: string; mockPayments: boolean; production?: boolean; corsOrigins?: string[]; uploadsPath: string; logger?: boolean }
const idSchema = z.string().min(1).max(100)
const credentials = z.object({ account: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/), password: z.string().min(8).max(128) })
const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(10), orderState: z.coerce.number().int().min(0).max(6).default(0) })
const addressFields = z.object({ receiver: z.string().trim().min(1).max(50), contact: z.string().regex(/^\d{6,20}$/), address: z.string().trim().min(1).max(300), fullLocation: z.string().max(100).optional(), provinceCode: z.union([z.string(),z.number()]).optional(), cityCode: z.union([z.string(),z.number()]).optional(), countyCode: z.union([z.string(),z.number()]).optional(), isDefault: z.union([z.literal(0), z.literal(1)]) })
const createAddressFields = addressFields.extend({ isDefault: addressFields.shape.isDefault.default(1) })
const key = (req: FastifyRequest) => z.object({ id: idSchema }).parse(req.params).id
function maskNickname(nickname: string): string { const chars = Array.from(nickname); return `${chars[0] ?? ''}***${chars.length > 2 ? chars[chars.length - 1] : ''}` }
function page<T>(items: T[], query: unknown) {
  const p = pageSchema.parse(query)
  return { items: items.slice((p.page - 1) * p.pageSize, p.page * p.pageSize), counts: items.length, pages: Math.ceil(items.length / p.pageSize), page: p.page, pageSize: p.pageSize }
}

export async function buildApp(options: AppOptions) {
  ensure(!(options.production && options.mockPayments), 500, '正式环境禁止启用模拟支付')
  const db = new Database(options.databasePath)
  const accounts = new Accounts(db), catalog = new Catalog(db, options.publicUrl)
  const orders = new Orders(db, accounts, catalog, options.mockPayments)
  catalog.seed()
  const app = Fastify({ logger: options.logger ?? false, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 1024 * 1024 })
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
    reply.code(status).send({ code: '0', msg, requestId: req.id })
  })
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ code: '0', msg: '接口不存在' }))
  const ok = (result: unknown) => ({ code: '1', result })
  const protectedRoute = (method: HTTPMethods, url: string, handler: (req: FastifyRequest, user: User) => unknown) => {
    app.route({ method, url, handler: async req => ok(await handler(req, accounts.authenticate(req.headers.authorization))) })
  }
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
  protectedRoute('GET', '/member/profile', (_req, user) => accounts.profile(user))
  protectedRoute('PUT', '/member/profile', (req, user) => {
    const data = z.object({ nickname: z.string().trim().min(1).max(50), gender: z.enum(['男','女','未知']), birthday: z.string().max(20), profession: z.string().max(100), provinceCode: z.string().max(20), cityCode: z.string().max(20), countyCode: z.string().max(20) }).parse(req.body)
    return accounts.updateProfile(user, data)
  })
  protectedRoute('POST', '/member/profile/avatar', async (req, user) => {
    const file = await req.file(); ensure(file, 400, '请选择头像')
    const buffer = await file.toBuffer()
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    ensure(jpeg && file.mimetype === 'image/jpeg', 400, '仅支持 JPEG 头像')
    const name = `${randomUUID()}.jpg`
    await mkdir(options.uploadsPath, { recursive: true })
    await writeFile(join(options.uploadsPath, name), buffer)
    const avatar = `${options.publicUrl}/uploads/${name}`
    accounts.updateProfile(user, { avatar })
    return { avatar }
  })
  app.get('/uploads/:name', async (req, reply) => {
    const { name } = z.object({ name: z.string().uuid().transform(v => v) }).parse({ name: (req.params as { name: string }).name.replace(/\.jpg$/, '') })
    try { return reply.type('image/jpeg').send(await readFile(join(options.uploadsPath, name + '.jpg'))) }
    catch { throw new AppError(404, '图片不存在') }
  })
  app.get('/assets/product.svg', async (_req, reply) => reply.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" rx="32" fill="#fff0e8"/><path d="M100 145h200v170H100zM150 145v-35h100v35" fill="none" stroke="#ba4e32" stroke-width="12"/><text x="200" y="245" text-anchor="middle" font-size="42" fill="#ba4e32">HDM</text></svg>'))
  app.get('/home/banner', async () => ok([{ id: 'self-1', imgUrl: options.publicUrl + '/assets/product.svg', hrefUrl: '/category/category-0', type: '1' }]))
  for (const route of ['/home/category/head', '/category/top']) app.get(route, async () => { orders.expire(); return ok(catalog.categories()) })
  for (const route of ['/home/new', '/home/recommend']) app.get(route, async () => { orders.expire(); return ok(catalog.list()) })
  app.get('/home/goods/guessLike', async req => { orders.expire(); return ok(page(catalog.list(), req.query)) })
  app.get('/hot/:type', async req => { orders.expire(); return ok({ id: 'hot', title: '自营精选', subTypes: [{ id: 'all', title: '全部', goodsItems: page(catalog.list(), req.query) }] }) })
  app.get('/goods', async req => { orders.expire(); return ok(catalog.detail(z.object({ id: idSchema }).parse(req.query).id)) })
  app.post('/search/all', async req => {
    orders.expire()
    const data = z.object({ keyword: z.string().max(100).default('') }).parse(req.body)
    return ok({ pageData: page(catalog.list(data.keyword), req.body) })
  })
  app.get('/goods/:id/evaluate/page', async req => {
    const rows = db.all<{ order_id: string; content: string; score: number; created: number; nickname: string }>('SELECT e.*,u.nickname FROM evaluations e JOIN orders o ON o.id=e.order_id JOIN users u ON u.id=o.owner_id WHERE EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=e.order_id AND i.product_id=?) ORDER BY e.created DESC', key(req))
    return ok(page(rows.map(r => ({ id: r.order_id, content: r.content, score: r.score, createTime: new Date(r.created).toISOString(), pictures: [], member: { nickname: maskNickname(r.nickname) } })), req.query))
  })
  protectedRoute('GET', '/member/address', (_req, user) => accounts.addresses(user))
  protectedRoute('GET', '/member/address/:id', (req, user) => { const address = accounts.addresses(user).find(a => a.id === key(req)); ensure(address, 404, '地址不存在'); return address })
  protectedRoute('POST', '/member/address', (req, user) => accounts.saveAddress(user, createAddressFields.parse(req.body)))
  protectedRoute('PUT', '/member/address/:id', (req, user) => accounts.saveAddress(user, addressFields.partial().parse(req.body), key(req)))
  protectedRoute('DELETE', '/member/address/:id', (req, user) => { db.run('DELETE FROM addresses WHERE id=? AND user_id=?', key(req), user.id); return { id: key(req) } })
  protectedRoute('GET', '/member/cart', (_req, user) => { orders.expire(); return catalog.cart(user) })
  protectedRoute('GET', '/member/cart/count', (_req, user) => ({ count: catalog.cart(user).reduce((sum, item) => sum + item.count, 0) }))
  protectedRoute('POST', '/member/cart', (req, user) => {
    orders.expire(); const data = z.object({ skuId: idSchema, count: z.number().int().min(1).max(999) }).parse(req.body)
    return catalog.addCart(user, data.skuId, data.count)
  })
  protectedRoute('PUT', '/member/cart/:id', (req, user) => catalog.updateCart(user, key(req), z.object({ selected: z.boolean().optional(), count: z.number().int().min(1).max(999).optional() }).parse(req.body)))
  protectedRoute('DELETE', '/member/cart', (req, user) => {
    const { ids } = z.object({ ids: z.array(idSchema).max(100) }).parse(req.body)
    db.transaction(() => { for (const id of ids) db.run('DELETE FROM carts WHERE user_id=? AND sku_id=?', user.id, id) }); return null
  })
  protectedRoute('GET', '/member/relations', (_req, user) => accounts.relations(user))
  protectedRoute('POST', '/member/relations', (req, user) => accounts.invite(user, z.object({ account: credentials.shape.account }).parse(req.body).account))
  protectedRoute('PUT', '/member/relations/:id', (req, user) => accounts.updateRelation(user, key(req), z.object({ action: z.enum(['accept','revoke']) }).parse(req.body).action))
  protectedRoute('GET', '/member/order/pre', (_req, user) => orders.preOrder(user))
  protectedRoute('POST', '/member/order', (req, user) => orders.create(user, z.object({ requestKey: z.string().min(16).max(100), addressId: idSchema, goods: z.array(z.object({ skuId: idSchema, count: z.number().int().min(1).max(999) })).min(1).max(100) }).parse(req.body)))
  protectedRoute('GET', '/member/order', (req, user) => page(orders.list(user, pageSchema.parse(req.query).orderState), req.query))
  protectedRoute('GET', '/member/family-orders', (_req, user) => orders.list(user, 0, true))
  protectedRoute('GET', '/member/order/:id', (req, user) => orders.detail(user, key(req)))
  protectedRoute('PUT', '/member/order/:id/payer', (req, user) => orders.invitePayer(user, key(req), z.object({ friendId: idSchema.nullable() }).parse(req.body).friendId))
  protectedRoute('POST', '/member/order/:id/mock-pay', (req, user) => orders.pay(user, key(req), z.object({ amountCents: z.number().int().positive() }).parse(req.body).amountCents))
  protectedRoute('PUT', '/member/order/:id/cancel', (req, user) => orders.cancel(user, key(req)))
  protectedRoute('POST', '/member/order/:id/reminder', (req, user) => orders.remind(user, key(req)))
  protectedRoute('PUT', '/member/order/:id/receipt', (req, user) => orders.receive(user, key(req)))
  protectedRoute('PUT', '/member/order/:id/evaluation', (req, user) => {
    const data = z.object({ score: z.number().int().min(1).max(5), content: z.string().trim().min(5).max(500) }).parse(req.body)
    return orders.evaluate(user, key(req), data.score, data.content)
  })
  protectedRoute('GET', '/merchant/orders', (_req, user) => orders.merchantList(user))
  protectedRoute('POST', '/merchant/orders/:id/ship', (req, user) => orders.ship(user, key(req)))
  const timer = setInterval(() => { try { orders.expire() } catch { app.log.error('Order expiration failed') } }, 30_000).unref()
  app.addHook('onClose', async () => { clearInterval(timer); db.close() })
  return { app, db, accounts }
}
