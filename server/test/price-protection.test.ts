import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { buildTestApp } from './helpers/fixtures.ts'
import { identityHeaders } from './helpers/identity-headers.ts'

const ONE_DAY_S = 86400
const ONE_DAY_MS = 86400_000

async function fixture() {
  let now = Date.UTC(2026, 10, 18, 8)
  const ctx = await buildTestApp({ databasePath: ':memory:', uploadsPath: './unused',
    publicUrl: 'http://localhost', mockPayments: true, clock: { now: () => now } })
  const buyer = ctx.testData.account({ account: 'buyer', password: 'test-password-123' })
  const merchant = ctx.testData.account({ account: 'seller', password: 'test-password-123', role: 'merchant' })
  const delivery = ctx.testData.address({ userId: buyer.id, receiver: '验收人', contact: '13800000000', address: '验收地址一号' })
  const product = ctx.testData.product({ name: '测试商品', category: '箱包', description: '品质保证。',
    skus: [{ spec: '标准款', priceCents: 2300, stock: 100 }] })
  const sku = product.skus[0]!
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, token = buyer.token) => {
    const response = await ctx.app.inject({ method, url, headers: identityHeaders(ctx.accounts, token), payload })
    return { status: response.statusCode, ...response.json() }
  }
  const tick = (ms: number) => { now += ms }
  // re-login 刷新 token（时钟推进超过 24 小时后 session 失效）
  const relogin = async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/login', payload: { account: 'buyer', password: 'test-password-123' } })
    buyer.token = r.json().result.token
  }
  const draft = (extra: object = {}) => call('POST', '/merchant/settings/protection/draft',
    { requestKey: randomUUID(), windowDays: 7, budgetPerOrderCents: 1000, totalBudgetCents: 50000, effectiveAtOffset: ONE_DAY_S, ...extra }, merchant.token)
  const confirm = (policyId: string, policyHash: string) => call('POST', '/merchant/settings/protection/confirm', { policyId, policyHash }, merchant.token)
  const publish = (token: string, policyId: string, requestKey: string) => call('POST', '/merchant/settings/protection/publish', { token, policyId, requestKey }, merchant.token)
  const list = () => call('GET', '/merchant/settings/protection', undefined, merchant.token)
  const placeAndPayOrder = async () => {
    const orderRes = await call('POST', '/member/order', { requestKey: randomUUID(),
      goods: [{ skuId: sku.id, count: 1 }], addressId: delivery.id, expectedAmountCents: 2300 })
    assert.equal(orderRes.status, 200, JSON.stringify(orderRes))
    const orderId = orderRes.result.id as string
    assert.equal((await call('POST', '/member/order/' + orderId + '/mock-pay', { amountCents: 2300 })).status, 200)
    return orderId
  }
  return { ctx, buyer, merchant, sku, product, delivery, call, tick, relogin, draft, confirm, publish, list, placeAndPayOrder, getNow: () => now }
}

test('价保政策草稿→确认→发布流程', async () => {
  const f = await fixture()
  try {
    const draftRes = await f.draft()
    assert.equal(draftRes.status, 200, JSON.stringify(draftRes))
    const { policyId, policyHash } = draftRes.result as { policyId: string; policyHash: string }
    assert.ok(typeof policyId === 'string' && policyId.length > 0)
    assert.ok(typeof policyHash === 'string' && policyHash.length === 64)

    const confirmRes = await f.confirm(policyId, policyHash)
    assert.equal(confirmRes.status, 200, JSON.stringify(confirmRes))
    const { token } = confirmRes.result as { token: string }
    assert.ok(typeof token === 'string' && token.length > 0)

    const reqKey = randomUUID()
    const pubRes = await f.publish(token, policyId, reqKey)
    assert.equal(pubRes.status, 200, JSON.stringify(pubRes))
    const { receiptId, publishedAt } = pubRes.result as { receiptId: string; publishedAt: number }
    assert.ok(typeof receiptId === 'string' && receiptId.length > 0)
    assert.ok(typeof publishedAt === 'number')

    const listRes = await f.list()
    assert.equal(listRes.status, 200)
    assert.equal(listRes.result[0].published, true)
    assert.equal(listRes.result[0].receiptId, receiptId)
  } finally { await f.ctx.app.close() }
})

test('重复 requestKey 返回原回执', async () => {
  const f = await fixture()
  try {
    const draftRes = await f.draft()
    assert.equal(draftRes.status, 200)
    const { policyId, policyHash } = draftRes.result as { policyId: string; policyHash: string }
    const confirmRes = await f.confirm(policyId, policyHash)
    const { token } = confirmRes.result as { token: string }
    const reqKey = randomUUID()
    const first = await f.publish(token, policyId, reqKey)
    assert.equal(first.status, 200)
    const second = await f.publish(token, policyId, reqKey)
    assert.equal(second.status, 200)
    assert.equal(first.result.receiptId, second.result.receiptId)
  } finally { await f.ctx.app.close() }
})

test('token 过期被拒', async () => {
  const f = await fixture()
  try {
    const draftRes = await f.draft()
    const { policyId, policyHash } = draftRes.result as { policyId: string; policyHash: string }
    const confirmRes = await f.confirm(policyId, policyHash)
    const { token } = confirmRes.result as { token: string }
    f.tick(16 * 60_000) // 超过 15 分钟窗口
    const pubRes = await f.publish(token, policyId, randomUUID())
    assert.equal(pubRes.status, 403)
  } finally { await f.ctx.app.close() }
})

test('token 重放被拒', async () => {
  const f = await fixture()
  try {
    const draftRes = await f.draft()
    const { policyId, policyHash } = draftRes.result as { policyId: string; policyHash: string }
    const confirmRes = await f.confirm(policyId, policyHash)
    const { token } = confirmRes.result as { token: string }
    const reqKey1 = randomUUID()
    assert.equal((await f.publish(token, policyId, reqKey1)).status, 200)
    const reqKey2 = randomUUID()
    const replay = await f.publish(token, policyId, reqKey2)
    assert.equal(replay.status, 409)
  } finally { await f.ctx.app.close() }
})

test('effectiveAtOffset < 86400 被拒', async () => {
  const f = await fixture()
  try {
    const res = await f.draft({ effectiveAtOffset: 3600 })
    assert.equal(res.status, 400)
  } finally { await f.ctx.app.close() }
})

test('非商家身份被拒', async () => {
  const f = await fixture()
  try {
    const res = await f.call('POST', '/merchant/settings/protection/draft',
      { requestKey: randomUUID(), windowDays: 7, budgetPerOrderCents: 1000, totalBudgetCents: 50000, effectiveAtOffset: ONE_DAY_S })
    assert.equal(res.status, 403)
  } finally { await f.ctx.app.close() }
})

test('总预算低于单笔上限被拒', async () => {
  const f = await fixture()
  try {
    const res = await f.draft({ budgetPerOrderCents: 5000, totalBudgetCents: 1000 })
    assert.equal(res.status, 400)
  } finally { await f.ctx.app.close() }
})

test('买家订单详情有价保摘要（paid_at 在有效窗口内）', async () => {
  const f = await fixture()
  try {
    // 发布价保政策，effective_at = now + 1天
    const draftRes = await f.draft()
    const { policyId, policyHash } = draftRes.result as { policyId: string; policyHash: string }
    const confirmRes = await f.confirm(policyId, policyHash)
    const { token } = confirmRes.result as { token: string }
    assert.equal((await f.publish(token, policyId, randomUUID())).status, 200)

    // 时钟推进 2 天，使 effective_at 已过、仍在 7 天窗口内
    f.tick(2 * ONE_DAY_MS)
    await f.relogin()
    const orderId = await f.placeAndPayOrder()
    const detailRes = await f.call('GET', '/member/order/' + orderId)
    assert.equal(detailRes.status, 200)
    const brief = detailRes.result.protectionBrief
    assert.ok(brief !== null && typeof brief === 'object', '应有 protectionBrief')
    assert.equal(brief.windowDays, 7)
    assert.equal(brief.budgetPerOrderCents, 1000)
    assert.ok(typeof brief.effectiveAt === 'number')
    assert.ok(typeof brief.receiptId === 'string')
  } finally { await f.ctx.app.close() }
})

test('买家订单详情无价保（paid_at 在 effective_at 之前）', async () => {
  const f = await fixture()
  try {
    // 下单，此时价保还未发布
    const orderId = await f.placeAndPayOrder()
    // 发布价保（effective_at = 1 天后）
    const draftRes = await f.draft()
    const { policyId, policyHash } = draftRes.result as { policyId: string; policyHash: string }
    const confirmRes = await f.confirm(policyId, policyHash)
    const { token } = confirmRes.result as { token: string }
    assert.equal((await f.publish(token, policyId, randomUUID())).status, 200)
    const detailRes = await f.call('GET', '/member/order/' + orderId)
    assert.equal(detailRes.status, 200)
    assert.equal(detailRes.result.protectionBrief, null)
  } finally { await f.ctx.app.close() }
})

test('paid_at 超出价保窗口后 protectionBrief 为 null', async () => {
  const f = await fixture()
  try {
    // 推进 effective_at 已过，然后下单
    const draftRes = await f.draft()
    const { policyId, policyHash } = draftRes.result as { policyId: string; policyHash: string }
    const confirmRes = await f.confirm(policyId, policyHash)
    const { token } = confirmRes.result as { token: string }
    assert.equal((await f.publish(token, policyId, randomUUID())).status, 200)
    // 推进到窗口之外（> 7 天）
    f.tick(9 * ONE_DAY_MS)
    await f.relogin()
    const orderId = await f.placeAndPayOrder()
    const detailRes = await f.call('GET', '/member/order/' + orderId)
    assert.equal(detailRes.status, 200)
    assert.equal(detailRes.result.protectionBrief, null)
  } finally { await f.ctx.app.close() }
})
