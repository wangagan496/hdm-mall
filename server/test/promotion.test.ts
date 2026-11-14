import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { buildTestApp } from './helpers/fixtures.ts'
import { discountShares } from '../src/promotions.ts'

async function fixture() {
  const ctx = await buildTestApp({ databasePath: ':memory:', uploadsPath: './unused', mockPayments: true, publicUrl: 'http://localhost' })
  const password = randomBytes(24).toString('hex')
  const buyer = ctx.testData.account({ account: 'promotion_buyer', password })
  const merchant = ctx.testData.account({ account: 'promotion_seller', password, role: 'merchant' })
  const address = ctx.testData.address({ userId: buyer.id, receiver: 'Buyer', contact: '13800000000', address: '测试地址' })
  const product = ctx.testData.product({ name: '满减测试商品', skus: [{ spec: '标准', priceCents: 3300, stock: 100 }] })
  const sku = product.skus[0]!
  const call = async (method: string, url: string, payload?: object, token = buyer.token) => {
    const response = await ctx.app.inject({ method: method as never, url, headers: { authorization: 'Bearer ' + token }, payload })
    return { status: response.statusCode, body: response.json() }
  }
  return { ctx, buyer, merchant, address, sku, call }
}

test('A2 默认满99减10：门槛下、恰好门槛、超门槛均由服务端报价', async () => {
  const f = await fixture()
  try {
    for (const [count, total, discount, payable, gap] of [[2, 66, 0, 66, 3300], [3, 99, 10, 89, 0], [4, 132, 10, 122, 0]]) {
      const response = await f.call('GET', `/member/order/pre?skuId=${f.sku.id}&count=${count}`)
      assert.equal(response.status, 200)
      assert.equal(response.body.result.summary.totalPrice, total)
      assert.equal(response.body.result.summary.discountPrice, discount)
      assert.equal(response.body.result.summary.totalPayPrice, payable)
      assert.equal(response.body.result.promotion.remainingCents, gap)
    }
  } finally { await f.ctx.app.close() }
})

test('A2 订单锁定规则和多行分摊，最后一行补齐1分', async () => {
  const f = await fixture()
  try {
    const other = f.ctx.testData.product({ name: '其他满减商品', skus: [{ spec: '甲', priceCents: 3300, stock: 10 }, { spec: '乙', priceCents: 3300, stock: 10 }] })
    const goods = [f.sku, ...other.skus].map(sku => ({ skuId: sku.id, count: 1 }))
    const response = await f.call('POST', '/member/order', { requestKey: randomUUID(), addressId: f.address.id, goods, expectedAmountCents: 8900 })
    assert.equal(response.status, 200)
    const detail = (await f.call('GET', `/member/order/${response.body.result.id}`)).body.result
    assert.equal(detail.payMoney, 89)
    assert.equal(detail.totalMoney, 99)
    assert.equal(detail.discountCents, 1000)
    assert.equal(detail.promotion.thresholdCents, 9900)
    assert.deepEqual(detail.skus.map((item: { discountShareCents: number }) => item.discountShareCents), [333, 333, 334])
  } finally { await f.ctx.app.close() }
})

test('A2 商家修改和停用规则写审计，买家无权修改，旧报价返回PRICE_CHANGED', async () => {
  const f = await fixture()
  try {
    const rule = { requestKey: randomUUID(), expectedRevision: 1, thresholdCents: 9900, discountCents: 2000, enabled: true }
    assert.equal((await f.call('PUT', '/merchant/settings/promotion', rule)).status, 403)
    const edit = await f.call('PUT', '/merchant/settings/promotion', rule, f.merchant.token)
    assert.equal(edit.status, 200)
    assert.equal(edit.body.result.revision, 2)
    assert.deepEqual((await f.call('PUT', '/merchant/settings/promotion', rule, f.merchant.token)).body, edit.body)
    const response = await f.call('POST', '/member/order', { requestKey: randomUUID(), addressId: f.address.id,
      goods: [{ skuId: f.sku.id, count: 3 }], expectedAmountCents: 8900, expectedPromotionRevision: 1 })
    assert.equal(response.status, 409)
    assert.equal(response.body.reason, 'PRICE_CHANGED')
    assert.equal((await f.call('PUT', '/merchant/settings/promotion', { ...rule, requestKey: randomUUID(), expectedRevision: 2, enabled: false }, f.merchant.token)).status, 200)
    const quote = (await f.call('GET', `/member/order/pre?skuId=${f.sku.id}&count=3`)).body.result
    assert.equal(quote.summary.discountPrice, 0)
    assert.equal(quote.summary.totalPayPrice, 99)
    const audit = await f.call('GET', '/merchant/audit-log?action=promotion.edit', undefined, f.merchant.token)
    assert.equal(audit.status, 200)
    assert.equal(audit.body.result.counts, 2)
    for (const invalid of [{ thresholdCents: 0 }, { thresholdCents: 2000 }, { discountCents: 0 }, { discountCents: 9900 }]) {
      assert.equal((await f.call('PUT', '/merchant/settings/promotion', { ...rule, ...invalid, requestKey: randomUUID(), expectedRevision: 3 }, f.merchant.token)).status, 400)
    }
  } finally { await f.ctx.app.close() }
})

test('A2 多次部分退款按购买分摊退款，不追优惠，合计等于实付', async () => {
  const f = await fixture()
  try {
    const created = await f.call('POST', '/member/order', { requestKey: randomUUID(), addressId: f.address.id,
      goods: [{ skuId: f.sku.id, count: 3 }], expectedAmountCents: 8900 })
    assert.equal(created.status, 200)
    const orderId = created.body.result.id
    assert.equal((await f.call('POST', `/member/order/${orderId}/mock-pay`, { amountCents: 8900 })).status, 200)
    assert.equal((await f.call('POST', `/merchant/orders/${orderId}/ship`, {carrier:'顺丰',trackingNo:'SF12345678'}, f.merchant.token)).status, 200)
    for (const amount of [2967, 2967, 2966]) {
      const request = await f.call('POST', `/member/order/${orderId}/after-sales`, { requestKey: randomUUID(), kind: 'refund-missing',
        description: '这件商品没有收到', items: [{ skuId: f.sku.id, count: 1 }] })
      assert.equal(request.status, 200)
      const saleId = request.body.result.afterSaleId
      const detail = (await f.call('GET', `/member/order/${orderId}`)).body.result
      assert.equal(detail.afterSales[0].amountCents, amount)
      assert.equal((await f.call('POST', `/merchant/after-sales/${saleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)).status, 200)
    }
    const detail = (await f.call('GET', `/member/order/${orderId}`)).body.result
    assert.equal(detail.refunds.reduce((sum: number, refund: { amount: number }) => sum + Math.round(refund.amount * 100), 0), 8900)
    assert.equal(detail.canApplyAfterSale, false)
  } finally { await f.ctx.app.close() }
})

test('A2 已付款取消整单只退满减后的实付', async () => {
  const f = await fixture()
  try {
    const created = await f.call('POST', '/member/order', { requestKey: randomUUID(), addressId: f.address.id,
      goods: [{ skuId: f.sku.id, count: 3 }], expectedAmountCents: 8900 })
    const orderId = created.body.result.id
    assert.equal((await f.call('POST', `/member/order/${orderId}/mock-pay`, { amountCents: 8900 })).status, 200)
    const cancel = await f.call('POST', `/member/order/${orderId}/cancel-requests`, { requestKey: randomUUID() })
    assert.equal(cancel.status, 200)
    const cancelId = cancel.body.result.cancelRequestId
    const approved = await f.call('POST', `/merchant/orders/${orderId}/cancel-requests/${cancelId}/resolve`, { requestKey: randomUUID(), decision: 'approve' }, f.merchant.token)
    assert.equal(approved.status, 200)
    const detail = (await f.call('GET', `/member/order/${orderId}`)).body.result
    assert.equal(detail.refunds[0].amount, 89)
  } finally { await f.ctx.app.close() }
})

test('A2 优惠分摊限额优先保护每件商品至少实付1分', () => {
  assert.deepEqual(discountShares([9899, 1, 1], 1000), [1000, 0, 0])
  assert.deepEqual(discountShares([3300, 3300, 3300], 1000), [333, 333, 334])
  assert.deepEqual(discountShares([1, 1], 1), [1, 0])
  assert.deepEqual(discountShares([100, 2], 20, [1, 2]), [20, 0])
})

test('A2 多件低价商品分批少件退款，最后零元直接完成且不多退1分', async () => {
  const f = await fixture()
  try {
    f.ctx.db.run('UPDATE promotions SET threshold=2,discount=1 WHERE id=1')
    const sku = f.ctx.testData.product({ name: '一分商品', skus: [{ spec: '标准', priceCents: 1, stock: 10 }] }).skus[0]!
    const created = await f.call('POST', '/member/order', { requestKey: randomUUID(), addressId: f.address.id, goods: [{ skuId: sku.id, count: 2 }], expectedAmountCents: 1 })
    assert.equal(created.status, 200)
    const orderId = created.body.result.id
    assert.equal((await f.call('POST', `/member/order/${orderId}/mock-pay`, { amountCents: 1 })).status, 200)
    assert.equal((await f.call('POST', `/merchant/orders/${orderId}/ship`, {carrier:'顺丰',trackingNo:'SF12345678'}, f.merchant.token)).status, 200)
    for (const amount of [1, 0]) {
      const requested = await f.call('POST', `/member/order/${orderId}/after-sales`, { requestKey: randomUUID(), kind: 'refund-missing', description: '少收到一件商品', items: [{ skuId: sku.id, count: 1 }] })
      assert.equal(requested.status, 200)
      assert.equal((await f.call('POST', `/merchant/after-sales/${requested.body.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)).status, 200)
      const sale = (await f.call('GET', `/member/order/${orderId}`)).body.result.afterSales[0]
      assert.equal(sale.amountCents, amount)
      assert.equal(sale.state, amount === 0 ? 'completed' : 'refunded')
      if (amount === 0) assert.equal(sale.refundId, null)
    }
    const detail = (await f.call('GET', `/member/order/${orderId}`)).body.result
    assert.equal(detail.refunds.length, 1)
    assert.equal(detail.refunds[0].amount, 0.01)
    assert.equal(detail.canApplyAfterSale, false)
  } finally { await f.ctx.app.close() }
})

test('A2 边界：默认满减的最后一行1分商品不能承担2分尾差', async () => {
  const f = await fixture()
  try {
    const product = f.ctx.testData.product({ name: '分摊边界商品', skus: [
      { spec: '主商品', priceCents: 9900, stock: 10 },
      ...Array.from({ length: 11 }, (_, index) => ({ spec: `一分商品${index + 1}`, priceCents: 1, stock: 10 }))
    ] })
    const response = await f.call('POST', '/member/order', { requestKey: randomUUID(), addressId: f.address.id,
      goods: product.skus.map(sku => ({ skuId: sku.id, count: 1 })), expectedAmountCents: 8911 })
    assert.equal(response.status, 200, '合法商品和默认规则不应因尾差分摊导致下单失败')
  } finally { await f.ctx.app.close() }
})

test('A2 边界：默认满减保留低价商品1分实付并允许售后', async () => {
  const f = await fixture()
  try {
    const product = f.ctx.testData.product({ name: '零元售后边界商品', skus: [
      { spec: '主商品', priceCents: 9899, stock: 10 }, { spec: '一分甲', priceCents: 1, stock: 10 }, { spec: '一分乙', priceCents: 1, stock: 10 }
    ] })
    const created = await f.call('POST', '/member/order', { requestKey: randomUUID(), addressId: f.address.id,
      goods: product.skus.map(sku => ({ skuId: sku.id, count: 1 })), expectedAmountCents: 8901 })
    assert.equal(created.status, 200)
    const orderId = created.body.result.id
    assert.equal((await f.call('POST', `/member/order/${orderId}/mock-pay`, { amountCents: 8901 })).status, 200)
    assert.equal((await f.call('POST', `/merchant/orders/${orderId}/ship`, {carrier:'顺丰',trackingNo:'SF12345678'}, f.merchant.token)).status, 200)
    const requested = await f.call('POST', `/member/order/${orderId}/after-sales`, { requestKey: randomUUID(), kind: 'return-no-reason',
      items: [{ skuId: product.skus[2]!.id, count: 1 }] })
    assert.equal(requested.status, 200)
    const detail = (await f.call('GET', `/member/order/${orderId}`)).body.result
    assert.equal(detail.afterSales[0].amountCents, 1)
    assert.deepEqual(detail.skus.map((item: { discountShareCents: number }) => item.discountShareCents), [1000, 0, 0])
  } finally { await f.ctx.app.close() }
})
