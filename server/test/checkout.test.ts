import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildTestApp } from './helpers/fixtures.ts'

test('D3: 报价必填且必须是正整数分，失败不留下订单库存流水', async () => {
  const f = await fixture()
  try {
    for (const expectedAmountCents of [undefined, null, '30', 0, -1, 30.1]) {
      const response = await f.app.inject({ method: 'POST', url: '/member/order', headers: f.headers,
        payload: { ...f.request, expectedAmountCents } })
      assert.equal(response.statusCode, 400)
      assert.equal(response.json().code, '0')
      assert.ok(response.json().requestId)
    }
    assert.equal(f.orders.list(f.user).length, 0)
    assert.equal(f.catalog.sku('apple-red').stock, 10)
  } finally { await f.app.close() }
})


test('B-31/B-32/B-34: 请求号只读恢复、本人隔离、幂等与过期状态', async () => {
  const f = await fixture()
  try {
    const path = '/member/order/by-request/' + f.request.requestKey
    assert.equal((await f.get(path)).statusCode, 404)
    assert.equal(f.orders.list(f.user).length, 0)
    const replies = await Promise.all([f.create(), f.create()])
    assert.equal(replies[0].statusCode, 200)
    assert.equal(replies[1].json().result.id, replies[0].json().result.id)
    const found = await f.get(path)
    assert.equal(found.statusCode, 200)
    assert.equal(found.json().result.id, replies[0].json().result.id)
    assert.equal(found.json().result.orderState, 1)
    const other = f.testData.account({ account: 'other_buyer', password: 'checkout-password' })
    assert.equal((await f.app.inject({ url: path, headers: { authorization: 'Bearer ' + other.token } })).statusCode, 404)
    assert.equal((await f.app.inject({ method: 'POST', url: '/member/order', headers: { authorization: 'Bearer ' + other.token }, payload: f.request })).statusCode, 400)
    assert.equal(f.catalog.sku('apple-red').stock, 7)
    assert.equal(f.orders.list(f.user).length, 1)
    assert.equal((await f.create({ ...f.request, expectedAmountCents: 31 })).statusCode, 409)
    f.advance(15 * 60_000)
    assert.equal((await f.get(path)).json().result.orderState, 6)
    assert.equal(f.catalog.sku('apple-red').stock, 10)
  } finally { await f.app.close() }
})


test('B-24/B-25: 加载与提交缺货给出具体规格，多商品整单回滚', async () => {
  const f = await fixture()
  try {
    for (const skuId of ['apple-red', 'apple-green']) await f.app.inject({ method: 'POST', url: '/member/cart', headers: f.headers, payload: { skuId, count: 3 } })
    const merchant = f.testData.account({ account: 'stock_merchant', password: 'checkout-password', role: 'merchant' })
    f.testData.updateSku({ skuId: 'apple-green', stock: 1, actorId: merchant.id })
    const preview = (await f.get('/member/order/pre')).json().result
    assert.equal(preview.goods.find((item: { skuId: string }) => item.skuId === 'apple-green').stock, 1)
    const response = await f.create({ ...f.request, expectedAmountCents: 90, goods: [{ skuId: 'apple-red', count: 3 }, { skuId: 'apple-green', count: 3 }] })
    assert.equal(response.statusCode, 409)
    assert.equal(response.json().reason, 'STOCK_SHORTAGE')
    assert.deepEqual(response.json().result.goods, [{ skuId: 'apple-green', name: '苹果', spec: '绿', requiredCount: 3, remainingCount: 1 }])
    assert.equal(f.catalog.sku('apple-red').stock, 10)
    assert.equal(f.catalog.sku('apple-green').stock, 1)
    assert.equal(f.orders.list(f.user).length, 0)
    assert.equal((await f.get('/member/cart')).json().result.length, 2)
    assert.equal(f.db.one<{ count: number }>("SELECT COUNT(*) count FROM inventory_movements WHERE kind='reserve'")!.count, 0)
  } finally { await f.app.close() }
})


async function fixture() {
  let now = Date.UTC(2026, 10, 6)
  const context = await buildTestApp({ databasePath: ':memory:', publicUrl: 'http://fixture', uploadsPath: './unused',
    mockPayments: true, clock: { now: () => now } })
  const buyer = context.testData.account({ account: 'checkout_buyer', password: 'checkout-password' })
  const user = context.accounts.authenticate('Bearer ' + buyer.token)
  const headers = { authorization: 'Bearer ' + buyer.token }
  const address = context.testData.address({ userId: user.id, receiver: '买家', contact: '13800000000', address: '测试地址' })
  const product = context.testData.product({ name: '苹果', skus: [
    { id: 'apple-red', spec: '红', priceCents: 10, stock: 10 },
    { id: 'apple-green', spec: '绿', priceCents: 20, stock: 10 }
  ] })
  const request = { requestKey: randomUUID(), addressId: address.id, expectedAmountCents: 30, goods: [{ skuId: 'apple-red', count: 3 }] }
  const create = (body = request) => context.app.inject({ method: 'POST', url: '/member/order', headers, payload: body })
  const get = (url: string) => context.app.inject({ url, headers })
  return { ...context, user, buyer, headers, address, product, request, create, get, advance: (ms: number) => { now += ms } }
}

test('B-23: 报价变化返回409和分明细，不创建订单不扣库存不删购物车', async () => {
  const f = await fixture()
  try {
    await f.app.inject({ method: 'POST', url: '/member/cart', headers: f.headers, payload: { skuId: 'apple-red', count: 3 } })
    assert.equal(f.orders.preOrder(f.user).summary.totalPayPrice, 0.3)
    f.testData.updateSku({ skuId: 'apple-red', priceCents: 11 })
    const response = await f.create()
    assert.equal(response.statusCode, 409)
    assert.equal(response.json().reason, 'PRICE_CHANGED')
    assert.deepEqual(response.json().result, { totalAmountCents: 33, goods: [
      { skuId: 'apple-red', name: '苹果', spec: '红', priceCents: 11, count: 3, subtotalCents: 33 }
    ] })
    assert.equal(f.orders.list(f.user).length, 0)
    assert.equal(f.catalog.sku('apple-red').stock, 10)
    assert.equal((await f.get('/member/cart')).json().result[0].count, 3)
    assert.equal((await f.create({ ...f.request, requestKey: randomUUID(), expectedAmountCents: 33 })).statusCode, 200)
  } finally { await f.app.close() }
})

test('B-21 L1/L2: 0.1元乘3的行小计、购物车、结算、详情和支付均为30分', async () => {
  const f = await fixture()
  try {
    await f.app.inject({ method: 'POST', url: '/member/cart', headers: f.headers, payload: { skuId: 'apple-red', count: 3 } })
    const cart = (await f.get('/member/cart')).json().result
    assert.equal(Math.round(cart[0].price * 100) * cart[0].count, 30)
    const preview = f.orders.preOrder(f.user)
    assert.equal(preview.goods[0].totalPayPrice, '0.3')
    assert.equal(preview.summary.totalPayPrice, 0.3)
    assert.equal((await f.get('/member/order/pre')).json().result.summary.totalPayPrice, 0.3)
    const created = await f.create()
    assert.equal(created.statusCode, 200)
    const detail = (await f.get('/member/order/' + created.json().result.id)).json().result
    assert.equal(detail.payMoney, 0.3)
    const payment = await f.app.inject({ method: 'POST', url: '/member/order/' + detail.id + '/payments', headers: f.headers, payload: { amountCents: 30 } })
    assert.equal(payment.statusCode, 200)
    assert.equal(f.db.one<{ amount: number }>('SELECT amount FROM orders')!.amount, 30)
    assert.equal(f.db.one<{ amount: number }>('SELECT amount FROM payments')!.amount, 30)
  } finally { await f.app.close() }
})
