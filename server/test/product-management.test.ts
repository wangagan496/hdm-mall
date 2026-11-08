import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildTestApp } from './helpers/fixtures.ts'

async function fixture() {
  const f = await buildTestApp({ databasePath: ':memory:', uploadsPath: './unused', publicUrl: 'http://fixture', mockPayments: true })
  f.testData.product({ id: 'catalog-base', name: '原有商品', category: '测试分类', skus: [{ id: 'base-sku', spec: '标准款', priceCents: 1200, stock: 5 }] })
  f.accounts.register('merchant_product', 'test-password-123', 'merchant')
  f.accounts.register('buyer_product', 'test-password-123', 'buyer')
  const merchant = f.accounts.login('merchant_product', 'test-password-123')
  const buyer = f.accounts.login('buyer_product', 'test-password-123')
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, token = merchant.token) =>
    f.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } })
  const categories = await call('GET', '/merchant/products/categories')
  const categoryId = categories.statusCode === 200 ? categories.json().result[0].id : 'missing-category'
  const input = () => ({ requestKey: randomUUID(), name: '商家新商品', categoryId, description: '说明',
    skus: [{ spec: '标准款', priceCents: 1900, stock: 20, enabled: true }, { spec: '加大款', priceCents: 2400, stock: 10, enabled: true }] })
  return { ...f, call, merchant, buyer, input }
}

test('商家一次新建完整商品与两规格，同号返回原回执，买家不可写且回执按账号隔离', async () => {
  const f = await fixture()
  try {
    const payload = f.input(), response = await f.call('POST', '/merchant/products', payload)
    assert.equal(response.statusCode, 200, response.body)
    const product = response.json().result
    assert.equal(product.name, payload.name)
    assert.equal(product.status, 'on')
    assert.equal(product.skus.length, 2)
    assert.deepEqual(product.skus.map((sku: { stock: number }) => sku.stock), [20, 10])
    assert.deepEqual((await f.call('POST', '/merchant/products', payload)).json(), response.json())
    assert.equal((await f.call('POST', '/merchant/products', { ...payload, name: '不同内容' })).statusCode, 409)
    assert.deepEqual((await f.call('GET', '/merchant/products/changes/' + payload.requestKey)).json(), response.json())
    assert.equal((await f.call('POST', '/merchant/products', f.input(), f.buyer.token)).statusCode, 403)
    assert.equal((await f.call('GET', '/merchant/products/changes/' + payload.requestKey, undefined, f.buyer.token)).statusCode, 403)
    const movements = await f.call('GET', '/merchant/inventory/' + product.skus[0].id + '/movements')
    assert.equal(movements.statusCode, 200)
    assert.equal(movements.json().result.items[0].kind, 'opening')
    assert.equal(movements.json().result.items[0].balance, 20)
  } finally { await f.app.close() }
})

test('一次编辑同步改价库存和规格，回执固定，旧版本冲突附最新内容，失败整笔回滚', async () => {
  const f = await fixture()
  try {
    const initial = (await f.call('POST', '/merchant/products', f.input())).json().result
    const payload = { requestKey: randomUUID(), expectedRevision: initial.revision, name: '改后商品',
      skus: [{ id: initial.skus[0].id, priceCents: 2200, stock: 25, expectedStock: 20 }, { id: initial.skus[1].id, enabled: false },
        { spec: '新规格', priceCents: 3000, stock: 8, enabled: true }] }
    const response = await f.call('PUT', '/merchant/products/' + initial.id, payload)
    assert.equal(response.statusCode, 200, response.body)
    const changed = response.json().result
    assert.equal(changed.name, '改后商品'); assert.ok(changed.revision > initial.revision)
    assert.equal(changed.skus[0].priceCents, 2200); assert.equal(changed.skus[0].stock, 25)
    assert.equal(changed.skus[1].enabled, false); assert.equal(changed.skus.length, 3)
    assert.deepEqual((await f.call('PUT', '/merchant/products/' + initial.id, payload)).json(), response.json())
    const movements = (await f.call('GET', '/merchant/inventory/' + initial.skus[0].id + '/movements')).json().result.items
    assert.equal(movements[0].reason, '商品编辑调整'); assert.equal(movements[0].delta, 5)
    const stale = await f.call('PUT', '/merchant/products/' + initial.id, { requestKey: randomUUID(), expectedRevision: initial.revision, description: '过期修改' })
    assert.equal(stale.statusCode, 409); assert.equal(stale.json().reason, 'PRODUCT_REVISION_CHANGED')
    assert.equal(stale.json().result.revision, changed.revision)
    const invalid = await f.call('PUT', '/merchant/products/' + initial.id, { requestKey: randomUUID(), expectedRevision: changed.revision,
      name: '不应生效', skus: [{ id: initial.skus[0].id, stock: 99, expectedStock: 25 }, { id: 'foreign-sku', enabled: false }] })
    assert.equal(invalid.statusCode, 400)
    assert.deepEqual((await f.call('GET', '/merchant/products/' + initial.id)).json().result, changed)
    assert.equal((await f.call('PUT', '/merchant/products/' + initial.id, { requestKey: randomUUID(), expectedRevision: changed.revision, categoryId: 'different' })).statusCode, 400)
  } finally { await f.app.close() }
})

test('买家下单造成的库存变化不阻断商家下架或非库存编辑', async () => {
  const f = await fixture()
  try {
    const product = (await f.call('POST', '/merchant/products', f.input())).json().result
    const address = f.testData.address({ userId: f.buyer.id, receiver: '买家', contact: '13800000000', address: '测试地址' })
    const order = await f.call('POST', '/member/order', { requestKey: randomUUID(), addressId: address.id,
      expectedAmountCents: 1900, goods: [{ skuId: product.skus[0].id, count: 1 }] }, f.buyer.token)
    assert.equal(order.statusCode, 200)
    const afterSale = (await f.call('GET', '/merchant/products/' + product.id)).json().result
    assert.equal(afterSale.skus[0].stock, product.skus[0].stock - 1)
    assert.equal(afterSale.revision, product.revision)
    const rename = await f.call('PUT', '/merchant/products/' + product.id, { requestKey: randomUUID(), expectedRevision: product.revision,
      name: '下单后仍可编辑' })
    assert.equal(rename.statusCode, 200, rename.body)
    assert.equal(rename.json().result.description, product.description)
    assert.equal(rename.json().result.skus[0].stock, product.skus[0].stock - 1)
    const off = await f.call('PUT', '/merchant/products/' + product.id, { requestKey: randomUUID(), expectedRevision: product.revision, status: 'off' })
    assert.equal(off.statusCode, 200, off.body)
    const on = await f.call('PUT', '/merchant/products/' + product.id, { requestKey: randomUUID(), status: 'on' })
    assert.equal(on.statusCode, 200, on.body)
  } finally { await f.app.close() }
})

test('只改一个字段保留说明和已停用规格，其他商家改价仍使旧表单冲突', async () => {
  const f = await fixture()
  try {
    const product = (await f.call('POST', '/merchant/products', f.input())).json().result
    const disabled = await f.call('PUT', '/merchant/products/' + product.id, { requestKey: randomUUID(), expectedRevision: product.revision,
      skus: [{ id: product.skus[1].id, enabled: false }] })
    assert.equal(disabled.statusCode, 200)
    f.accounts.register('other_merchant', 'test-password-123', 'merchant')
    const other = f.accounts.login('other_merchant', 'test-password-123')
    const changed = await f.call('PUT', '/merchant/products/' + product.id, { requestKey: randomUUID(), expectedRevision: disabled.json().result.revision,
      skus: [{ id: product.skus[1].id, priceCents: 2500 }] }, other.token)
    assert.equal(changed.statusCode, 200)
    assert.equal(changed.json().result.skus[1].enabled, false)
    assert.equal(changed.json().result.description, product.description)
    const stale = await f.call('PUT', '/merchant/products/' + product.id, { requestKey: randomUUID(), expectedRevision: disabled.json().result.revision, name: '旧表单名称' })
    assert.equal(stale.statusCode, 409)
    assert.equal(stale.json().reason, 'PRODUCT_REVISION_CHANGED')
    assert.equal(stale.json().result.skus[1].priceCents, 2500)
  } finally { await f.app.close() }
})

test('编辑库存必须带载入值，买家下单导致变化时返回最新商品并阻止覆盖', async () => {
  const f = await fixture()
  try {
    const product = (await f.call('POST', '/merchant/products', f.input())).json().result
    const address = f.testData.address({ userId: f.buyer.id, receiver: '买家', contact: '13800000000', address: '测试地址' })
    const order = await f.call('POST', '/member/order', { requestKey: randomUUID(), addressId: address.id,
      expectedAmountCents: 1900, goods: [{ skuId: product.skus[0].id, count: 1 }] }, f.buyer.token)
    assert.equal(order.statusCode, 200)
    const staleStock = await f.call('PUT', '/merchant/products/' + product.id, { requestKey: randomUUID(), expectedRevision: product.revision,
      skus: [{ id: product.skus[0].id, stock: product.skus[0].stock + 5, expectedStock: product.skus[0].stock }] })
    assert.equal(staleStock.statusCode, 409)
    assert.equal(staleStock.json().reason, 'PRODUCT_STOCK_CHANGED')
    assert.equal(staleStock.json().result.skus[0].stock, product.skus[0].stock - 1)
    assert.equal(staleStock.json().result.revision, product.revision)
    const missingExpected = await f.call('PUT', '/merchant/products/' + product.id, { requestKey: randomUUID(), expectedRevision: product.revision,
      skus: [{ id: product.skus[0].id, stock: product.skus[0].stock + 5 }] })
    assert.equal(missingExpected.statusCode, 400)
  } finally { await f.app.close() }
})

test('商品下架与规格停用贯穿搜索详情购物车预结算和提交，旧请求与订单不被阻断', async () => {
  const f = await fixture()
  try {
    const product = (await f.call('POST', '/merchant/products', f.input())).json().result
    const skuId = product.skus[0].id
    const address = f.testData.address({ userId: f.buyer.id, receiver: '买家', contact: '13800000000', address: '测试地址' })
    const create = { requestKey: randomUUID(), addressId: address.id, expectedAmountCents: 1900, goods: [{ skuId, count: 1 }] }
    const order = await f.call('POST', '/member/order', create, f.buyer.token)
    assert.equal(order.statusCode, 200)
    for (const id of [skuId, 'base-sku']) assert.equal((await f.call('POST', '/member/cart', { requestKey: randomUUID(), skuId: id, count: 1 }, f.buyer.token)).statusCode, 200)
    const latest = (await f.call('GET', '/merchant/products/' + product.id)).json().result
    const off = await f.call('PUT', '/merchant/products/' + product.id, { requestKey: randomUUID(), expectedRevision: latest.revision, status: 'off' })
    assert.equal(off.statusCode, 200)
    const search = (await f.call('POST', '/search/all', { keyword: '商家新商品' })).json().result.pageData
    assert.equal(search.counts, 0)
    const detail = (await f.call('GET', '/goods?id=' + product.id)).json()
    assert.equal(detail.status, 'off'); assert.equal(detail.available, false)
    assert.equal((await f.call('POST', '/member/cart', { requestKey: randomUUID(), skuId, count: 1 }, f.buyer.token)).statusCode, 409)
    await f.call('PUT', '/member/cart/selected', { selected: true }, f.buyer.token)
    const cart = (await f.call('GET', '/member/cart', undefined, f.buyer.token)).json().result
    assert.equal(cart.find((row: { skuId: string }) => row.skuId === skuId).selected, false)
    assert.equal(cart.find((row: { skuId: string }) => row.skuId === skuId).unavailableReason, '已下架')
    const quote = (await f.call('GET', '/member/order/pre', undefined, f.buyer.token)).json().result
    assert.deepEqual(quote.goods.map((row: { skuId: string }) => row.skuId), ['base-sku'])
    assert.equal(quote.excludedGoods[0].skuId, skuId)
    const rejected = await f.call('POST', '/member/order', { ...create, requestKey: randomUUID() }, f.buyer.token)
    assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().reason, 'PRODUCT_UNAVAILABLE')
    assert.deepEqual((await f.call('POST', '/member/order', create, f.buyer.token)).json(), order.json())
    assert.equal((await f.call('POST', '/member/order/' + order.json().result.id + '/mock-pay', { amountCents: 1900 }, f.buyer.token)).statusCode, 200)
    assert.equal((await f.call('DELETE', '/member/cart/invalid', undefined, f.buyer.token)).statusCode, 200)
    assert.equal((await f.call('GET', '/member/cart', undefined, f.buyer.token)).json().result.length, 1)
    const disabled = await f.call('PUT', '/merchant/products/' + product.id, { requestKey: randomUUID(), expectedRevision: off.json().result.revision,
      status: 'on', skus: product.skus.map((sku: { id: string }) => ({ id: sku.id, enabled: false })) })
    assert.equal(disabled.statusCode, 200)
    const unavailable = (await f.call('GET', '/goods?id=' + product.id)).json()
    assert.equal(unavailable.available, false); assert.equal(unavailable.skus.length, 0)
    assert.equal(unavailable.inventory, 0); assert.equal(Number.isFinite(unavailable.price), true)
  } finally { await f.app.close() }
})
