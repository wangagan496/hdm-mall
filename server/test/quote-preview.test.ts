import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { buildTestApp } from './helpers/fixtures.ts'
import { readConfig } from '../src/config.ts'
import { QuotePreview } from '../src/quote-preview/index.ts'

async function fixture() {
  let now = 1794873600000
  const ctx = await buildTestApp({ databasePath: ':memory:', uploadsPath: './unused', publicUrl: 'http://localhost', mockPayments: true, clock: { now: () => now } })
  const buyer = ctx.testData.account({ account: 'quote_buyer', password: randomBytes(24).toString('hex') })
  const merchant = ctx.testData.account({ account: 'quote_seller', password: randomBytes(24).toString('hex'), role: 'merchant' })
  const product = ctx.testData.product({ name: '报价商品', skus: [{ spec: '甲', priceCents: 3300, stock: 100 }, { spec: '乙', priceCents: 6600, stock: 100 }] })
  const [sku, other] = product.skus
  const items = [{ skuId: sku!.id, count: 1 }, { skuId: other!.id, count: 1 }]
  const call = async (payload: object, token = buyer.token) => {
    const res = await ctx.app.inject({ method: 'POST', url: '/member/quote-preview', headers: identityHeaders(ctx.accounts, token), payload })
    return { status: res.statusCode, body: res.json() }
  }
  return { ctx, buyer, merchant, product, sku: sku!, other: other!, items, call, advance: () => { now += 3600000 } }
}
function snapshot(db: Awaited<ReturnType<typeof fixture>>['ctx']['db']) {
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  return JSON.stringify(tables.map(({ name }) => [name, db.all(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`)]))
}
test('报价同输入、同版本完全一致；输入排序不影响编号，观测时间不参与身份', async () => {
  const f = await fixture()
  try {
    const a = (await f.call({ items: f.items })).body.result
    assert.equal(a.amountCents, 8900)
    assert.deepEqual(a.lines.map((line: { productName: string; spec: string }) => [line.productName, line.spec]).sort(), [['报价商品', '乙'], ['报价商品', '甲']].sort())
    assert.deepEqual((await f.call({ items: [...f.items].reverse() })).body.result, a)
    f.advance()
    const b = (await f.call({ items: f.items })).body.result
    assert.equal(a.quoteId, b.quoteId)
    assert.equal(a.receipt, b.receipt)
    assert.notEqual(a.observedAt, b.observedAt)
  } finally { await f.ctx.app.close() }
})
test('报价逐项移除复用整篮算法，跨门槛与remainingCents一致，单行移除含全部数量', async () => {
  const f = await fixture()
  try {
    const items = [{ skuId: f.sku.id, count: 3 }, { skuId: f.other.id, count: 1 }]
    const full = (await f.call({ items })).body.result
    for (const removal of full.removals) {
      const without = (await f.call({ items: items.filter(i => i.skuId !== removal.skuId) })).body.result
      assert.equal(removal.amountWithoutCents, without.amountCents)
      assert.equal(removal.decreaseCents, full.amountCents - without.amountCents)
      assert.equal(removal.remainingCents, without.promotion.remainingCents)
      assert.equal(removal.losesPromotion, full.promotion.hit && !without.promotion.hit)
    }
    const single = (await f.call({ items: [{ skuId: f.sku.id, count: 3 }] })).body.result
    const empty = (await f.call({ items: [] })).body.result
    assert.equal(single.removals[0].amountWithoutCents, empty.amountCents)
    assert.equal(single.removals[0].removedCount, 3)
    assert.equal(single.removals[0].losesPromotion, true)
    assert.equal(single.removals[0].remainingCents, 9900)
  } finally { await f.ctx.app.close() }
})
test('改单价给出前后金额、真实差额、前后编号与版本来源', async () => {
  const f = await fixture()
  try {
    const old = (await f.call({ items: f.items })).body.result
    f.ctx.testData.updateSku({ skuId: f.sku.id, priceCents: 3500 })
    const next = (await f.call({ items: f.items, previousReceipt: old.receipt })).body.result
    assert.equal(next.comparison.deltaCents, 200)
    assert.equal(next.comparison.previousQuoteId, old.quoteId)
    assert.notEqual(next.quoteId, old.quoteId)
    const reason = next.comparison.reasons.find((r: {kind: string}) => r.kind === 'unit-price')
    assert.equal(reason.beforeCents, 3300); assert.equal(reason.afterCents, 3500)
    assert.equal(reason.message, '『报价商品 甲』单价从 ¥33.00 调到 ¥35.00')
    assert.ok(next.lines.every((line: {productRevision:number}) => line.productRevision > 0))
    assert.equal(next.details.at(-1).moneyCents, next.amountCents)
  } finally { await f.ctx.app.close() }
})
for (const change of ['discount', 'threshold', 'disable', 'revision-only'] as const) test('满减变化说明与差额：' + change, async () => {
  const f = await fixture()
  try {
    const old = (await f.call({ items: f.items })).body.result
    const changes = { discount: 'discount=2000', threshold: 'threshold=10000', disable: 'enabled=0', 'revision-only': 'enabled=1' }
    f.ctx.db.run(`UPDATE promotions SET ${changes[change]},revision=revision+1 WHERE id=1`)
    const next = (await f.call({ items: f.items, previousReceipt: old.receipt })).body.result
    assert.equal(next.comparison.deltaCents, change === 'discount' ? -1000 : change === 'revision-only' ? 0 : 1000)
    assert.equal(next.comparison.reasons[0].kind, 'promotion')
    assert.equal(next.comparison.beforeRule.revision, 1)
    assert.equal(next.comparison.afterRule.revision, 2)
    const messages = {
      discount: '满减规则已修改：满 ¥99.00 减 ¥10.00 → 满 ¥99.00 减 ¥20.00',
      threshold: '满减规则已修改：满 ¥99.00 减 ¥10.00 → 满 ¥100.00 减 ¥10.00',
      disable: '满减已停用（原满 ¥99.00 减 ¥10.00）',
      'revision-only': '满减规则已更新，优惠不变：满 ¥99.00 减 ¥10.00'
    }
    assert.equal(next.comparison.reasons[0].message, messages[change])
    if (change === 'threshold') assert.equal(next.promotion.remainingCents, 100)
    if (change === 'disable') assert.equal(next.promotion.remainingCents, 0)
  } finally { await f.ctx.app.close() }
})
for (const change of ['off', 'stock', 'missing', 'disabled-sku'] as const) test('不能报价时明确拒绝、不删项重算、不伪造差额：' + change, async () => {
  const f = await fixture()
  try {
    // 单独建无历史引用的规格模拟消失；绝不删除或关闭不可改写的库存历史保护。
    if (change === 'missing') f.ctx.db.run('INSERT INTO skus(id,product_id,spec,price,stock) VALUES(?,?,?,?,?)', 'removable-sku', f.product.id, '可移除夹具', 3300, 1)
    const items = change === 'missing' ? [{ skuId: 'removable-sku', count: 1 }] : f.items
    const old = (await f.call({ items })).body.result
    if (change === 'off') f.ctx.db.run("UPDATE products SET status='off',revision=revision+1 WHERE id=?", f.product.id)
    if (change === 'stock') f.ctx.db.run('UPDATE skus SET stock=0 WHERE id=?', f.sku.id)
    if (change === 'missing') {
      f.ctx.db.run('DELETE FROM skus WHERE id=?', 'removable-sku')
    }
    if (change === 'disabled-sku') f.ctx.db.run('UPDATE skus SET enabled=0 WHERE id=?', f.sku.id)
    const next = await f.call({ items, previousReceipt: old.receipt })
    assert.equal(next.status, change === 'missing' ? 400 : 409)
    assert.equal(next.body.reason, 'QUOTE_UNAVAILABLE')
    assert.equal(next.body.result.previousQuoteId, old.quoteId)
    assert.equal(next.body.result.amountCents, null)
    assert.equal(next.body.result.deltaCents, null)
    assert.ok(next.body.result.reasons.some((r: {kind: string}) => r.kind === (change === 'disabled-sku' ? 'off' : change)))
    const messages = { off: '『报价商品 甲』已下架', stock: '『报价商品 甲』库存不足，需要 1 件，可用 0 件', missing: '有一件商品已不存在', 'disabled-sku': '『报价商品 甲』该规格已停售' }
    assert.ok(next.body.msg.includes(messages[change]))
    assert.doesNotMatch(next.body.msg, /revision|SKU|\d分/)
  } finally { await f.ctx.app.close() }
})
test('伪造、篡改、跨买家、不同篮子的凭据均不作为旧报价', async () => {
  const f = await fixture()
  try {
    const old = (await f.call({ items: f.items })).body.result
    const [body, signature] = old.receipt.split('.')
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString())
    forged.amountCents = 1
    const receipts = ['invalid', Buffer.from(JSON.stringify(forged)).toString('base64url') + '.' + signature, body + '.' + (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)]
    for (const previousReceipt of receipts) assert.equal((await f.call({ items: f.items, previousReceipt })).body.result.comparison, null)
    const otherBuyer = f.ctx.testData.account({ account: 'other_quote', password: randomBytes(24).toString('hex') })
    assert.equal((await f.call({ items: f.items, previousReceipt: old.receipt }, otherBuyer.token)).body.result.comparison, null)
    assert.equal((await f.call({ items: [f.items[0]], previousReceipt: old.receipt })).body.result.comparison, null)
    const unchanged = (await f.call({ items: f.items, previousReceipt: old.receipt })).body.result
    assert.equal(unchanged.comparison.deltaCents, 0)
    assert.deepEqual(unchanged.comparison.reasons, [])
  } finally { await f.ctx.app.close() }
})
test('非法输入明确拒绝，安全整数分校验拒绝乘法和求和溢出', async () => {
  const f = await fixture()
  try {
    for (const input of [{ items: [{}] }, { items: [{ skuId: f.sku.id }] }, { items: [{ skuId: 'unknown', count: 1 }] },
      ...[0,-1,0.5,'1',1000,null].map(count => ({ items: [{ skuId: f.sku.id, count }] })), { items: [f.items[0],f.items[0]] }, { oldPrice: 1 }]) {
      assert.equal((await f.call(input)).status, 400)
    }
    f.ctx.db.run('UPDATE skus SET price=? WHERE id=?', Number.MAX_SAFE_INTEGER, f.sku.id)
    assert.equal((await f.call({ items: [{ skuId: f.sku.id, count: 2 }] })).status, 400)
    assert.equal((await f.call({ items: f.items })).status, 400)
  } finally { await f.ctx.app.close() }
})
test('报价前后所有数据库表快照相同，未触发到期订单维护；默认只读选中购物车', async () => {
  const f = await fixture()
  try {
    const address = f.ctx.testData.address({ userId: f.buyer.id, receiver: 'Buyer', contact: '13800000000', address: '测试' })
    await f.ctx.app.inject({ method: 'POST', url: '/member/order', headers: identityHeaders(f.ctx.accounts, f.buyer.token),
      payload: { source: 'buy-now', requestKey: randomUUID(), addressId: address.id, goods: [{ skuId: f.sku.id, count: 1 }], expectedAmountCents: 3300 } })
    f.ctx.db.run('INSERT INTO carts(user_id,sku_id,count,selected) VALUES(?,?,?,1)', f.buyer.id, f.other.id, 1)
    f.advance()
    const before = snapshot(f.ctx.db)
    const result = await f.call({})
    assert.equal(result.status, 200)
    assert.equal(result.body.result.lines[0].skuId, f.other.id)
    await f.call({ items: f.items, previousReceipt: 'forged' })
    await f.call({ items: [{ skuId: 'missing', count: 1 }] })
    assert.equal(snapshot(f.ctx.db), before)
    assert.equal(f.ctx.db.one<{state:number}>('SELECT state FROM orders')!.state, 1)
  } finally { await f.ctx.app.close() }
})
test('报价和实际下单金额相同，鉴权和买家身份边界保留', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.call({ items: f.items }, f.merchant.token)).status, 403)
    assert.equal((await f.ctx.app.inject({ method: 'POST', url: '/member/quote-preview', payload: {} })).statusCode, 401)
    const quote = (await f.call({ items: f.items })).body.result
    const address = f.ctx.testData.address({ userId: f.buyer.id, receiver: 'Buyer', contact: '13800000000', address: '测试' })
    const created = await f.ctx.app.inject({ method: 'POST', url: '/member/order', headers: identityHeaders(f.ctx.accounts, f.buyer.token), payload: {
      source: 'buy-now', requestKey: randomUUID(), addressId: address.id, goods: f.items, expectedAmountCents: quote.amountCents, expectedPromotionRevision: quote.promotion.rule.revision } })
    assert.equal(created.statusCode, 200)
    assert.equal(f.ctx.db.one<{amount:number}>('SELECT amount FROM orders WHERE id=?', created.json().result.id)!.amount, quote.amountCents)
  } finally { await f.ctx.app.close() }
})
test('报价密钥沿用环境或文件配置读取，拒绝短密钥且不依赖支付配置', () => {
  assert.throws(() => readConfig({ QUOTE_PREVIEW_SECRET: 'short' }), /QUOTE_PREVIEW_SECRET/)
  const secret = randomBytes(32).toString('hex')
  assert.equal(readConfig({ QUOTE_PREVIEW_SECRET: secret }).appOptions.quotePreviewSecret, secret)
  assert.throws(() => readConfig({ QUOTE_PREVIEW_SECRET: secret, QUOTE_PREVIEW_SECRET_FILE: 'unused' }), /只能填写一个/)
})

test('未配置稳定密钥时重启失效旧凭据，按无上次报价处理', async () => {
  const f = await fixture()
  try {
    const firstProcess = new QuotePreview(f.ctx.db)
    const auth = () => f.ctx.accounts.authenticate(`Bearer ${f.buyer.token}`)
    const old = firstProcess.preview(auth(), { items: f.items }, 123)
    f.ctx.testData.updateSku({ skuId: f.sku.id, priceCents: 3500 })
    const restarted = new QuotePreview(f.ctx.db).preview(auth(), { items: f.items, previousReceipt: old.receipt }, 456)
    assert.equal(restarted.comparison, null)
    assert.equal(restarted.amountCents, 9100)
  } finally { await f.ctx.app.close() }
})

test('满减从关闭重新启用时，买家读到本次实际优惠条件', async () => {
  const f = await fixture()
  try {
    f.ctx.db.run('UPDATE promotions SET enabled=0 WHERE id=1')
    const old = (await f.call({ items: f.items })).body.result
    f.ctx.db.run('UPDATE promotions SET enabled=1,revision=revision+1 WHERE id=1')
    const next = (await f.call({ items: f.items, previousReceipt: old.receipt })).body.result
    assert.equal(next.comparison.reasons[0].message, '满减已启用：满 ¥99.00 减 ¥10.00')
    assert.equal(next.comparison.deltaCents, -1000)
  } finally { await f.ctx.app.close() }
})
import { identityHeaders } from './helpers/identity-headers.ts'
