import { randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { Accounts, type User } from './accounts.ts'
import { ensure } from './errors.ts'
import { recordStockMovement } from './inventory.ts'
import type { PaymentPreset } from './payment-channel.ts'
import type { Payments } from './payments.ts'

const identifier = z.string().min(1).max(100)
const accountSchema = z.object({
  account: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/),
  password: z.string().min(8).max(128), role: z.enum(['buyer', 'merchant']).default('buyer')
})
const addressSchema = z.object({ userId: identifier, receiver: z.string().trim().min(1).max(50),
  contact: z.string().regex(/^\d{6,20}$/), address: z.string().trim().min(1).max(300),
  fullLocation: z.string().max(100).default(''),
  provinceCode: z.union([z.string(), z.number()]).optional(), cityCode: z.union([z.string(), z.number()]).optional(),
  countyCode: z.union([z.string(), z.number()]).optional(), isDefault: z.union([z.literal(0), z.literal(1)]).default(0) })
const productSchema = z.object({
  id: identifier.optional(), name: z.string().trim().min(1).max(100),
  category: z.string().trim().min(1).max(100).default('测试分类'),
  description: z.string().max(300).default('独立测试商品'),
  skus: z.array(z.object({ id: identifier.optional(), spec: z.string().min(1).max(100),
    priceCents: z.number().int().min(1).max(100000000),
    stock: z.number().int().min(0).max(1000000) })).min(1).max(100)
})

/** 仅由 buildApp 在明确测试模式下创建；直接调用与 HTTP 共用鉴权和校验。 */
export class TestFixtures {
  private accounts: Accounts
  private credential: string
  private payments: Payments
  constructor(accounts: Accounts, credential: string, payments: Payments) { this.accounts = accounts; this.credential = credential; this.payments = payments }
  private authorize(credential: unknown) {
    const expected = Buffer.from(this.credential)
    const actual = Buffer.from(typeof credential === 'string' ? credential : '')
    ensure(actual.length === expected.length && timingSafeEqual(actual, expected), 403, '测试凭证无效')
  }
  private user(id: string) {
    const user = this.accounts.db.one<User>('SELECT * FROM users WHERE id=?', id)
    ensure(user, 404, '夹具账号不存在')
    return user
  }
  createAccount(credential: unknown, input: unknown) {
    this.authorize(credential)
    const data = accountSchema.parse(input)
    this.accounts.register(data.account, data.password, data.role)
    return this.accounts.login(data.account, data.password)
  }
  createAddress(credential: unknown, input: unknown) {
    this.authorize(credential)
    const { userId, ...data } = addressSchema.parse(input)
    return this.accounts.saveAddress(this.user(userId), data)
  }
  createRelation(credential: unknown, input: unknown) {
    this.authorize(credential)
    const data = z.object({ ownerId: identifier, friendId: identifier,
      accepted: z.boolean().default(true) }).parse(input)
    const owner = this.user(data.ownerId), friend = this.user(data.friendId)
    const relation = this.accounts.invite(owner, friend.account)
    if (data.accepted) this.accounts.updateRelation(friend, relation.id, 'accept')
    return relation
  }
  createProduct(credential: unknown, input: unknown) {
    this.authorize(credential)
    const data = productSchema.parse(input), db = this.accounts.db
    return db.transaction(() => {
      const id = data.id ?? randomUUID()
      db.run('INSERT INTO products VALUES(?,?,?,?,?)', id, data.name, data.category, '/assets/product.svg', data.description)
      const skus = data.skus.map(sku => {
        const skuId = sku.id ?? randomUUID()
        db.run('INSERT INTO skus VALUES(?,?,?,?,?)', skuId, id, sku.spec, sku.priceCents, sku.stock)
        recordStockMovement(db, { kind: 'opening', skuId, delta: sku.stock }, this.accounts.clock)
        return { ...sku, id: skuId }
      })
      const parentKey = 'parent:' + data.category, childKey = 'child:' + data.category + ':' + data.name
      let parent = db.one<{ id: string }>('SELECT id FROM categories WHERE source_key=?', parentKey)
      if (!parent) {
        parent = { id: randomUUID() }
        db.run('INSERT INTO categories VALUES(?,?,NULL,?)', parent.id, data.category, parentKey)
      }
      let child = db.one<{ id: string }>('SELECT id FROM categories WHERE source_key=?', childKey)
      if (!child) {
        child = { id: randomUUID() }
        db.run('INSERT INTO categories VALUES(?,?,?,?)', child.id, data.name, parent.id, childKey)
      }
      db.run('INSERT INTO product_categories VALUES(?,?)', id, child.id)
      return { id, name: data.name, skus, categoryId: parent.id, subcategoryId: child.id }
    })
  }
  updateSku(credential: unknown, input: unknown) {
    this.authorize(credential)
    const data = z.object({ skuId: identifier, priceCents: z.number().int().min(1).max(100000000).optional(),
      stock: z.number().int().min(0).max(1000000).optional(), actorId: identifier.optional() }).parse(input)
    const db = this.accounts.db
    return db.transaction(() => {
      const sku = db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', data.skuId)
      ensure(sku, 404, '商品规格不存在')
      if (data.priceCents !== undefined) db.run('UPDATE skus SET price=? WHERE id=?', data.priceCents, data.skuId)
      if (data.stock !== undefined && data.stock !== sku.stock) {
        ensure(data.actorId && this.user(data.actorId).role === 'merchant', 400, '调库存需指定夹具商家')
        db.run('UPDATE skus SET stock=? WHERE id=?', data.stock, data.skuId)
        db.run("INSERT INTO inventory_movements(sku_id,actor_id,kind,delta,balance,business_key,created,reason) VALUES(?,?,'adjust',?,?,?,?,?)",
          data.skuId, data.actorId, data.stock - sku.stock, data.stock, 'fixture:' + randomUUID(), this.accounts.clock.now(), '测试夹具调库存')
      }
      return { skuId: data.skuId }
    })
  }
  configurePayments(credential: unknown, input: unknown) {
    this.authorize(credential)
    const data = z.object({ paymentId: z.string().min(1).max(100).default('next'), preset: z.object({
      outcome: z.enum(['success', 'fail', 'unknown', 'close-paid']).default('unknown'),
      paidAt: z.number().int().optional(), query: z.enum(['match', 'opposite', 'missing-time']).optional(),
      refundFailures: z.number().int().min(0).max(100).optional()
    }) }).parse(input)
    const { paymentId, preset } = data as { paymentId: string; preset: PaymentPreset }
    const channel = this.payments.channel
    ensure(channel && 'setPreset' in channel && typeof channel.setPreset === 'function', 409, '当前支付渠道不支持模拟预设')
    channel.setPreset(paymentId, preset)
    return { configured: true }
  }
}

export function registerFixtureRoutes(app: FastifyInstance, fixtures: TestFixtures) {
  const routes = {
    accounts: fixtures.createAccount.bind(fixtures), addresses: fixtures.createAddress.bind(fixtures),
    products: fixtures.createProduct.bind(fixtures), relations: fixtures.createRelation.bind(fixtures),
    payments: fixtures.configurePayments.bind(fixtures), skus: fixtures.updateSku.bind(fixtures)
  }
  for (const [kind, create] of Object.entries(routes)) {
    app.post('/__test/fixtures/' + kind, async req => ({
      code: '1', result: create(req.headers['x-test-fixture-key'], req.body)
    }))
  }
}
