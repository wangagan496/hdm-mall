import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { HTTPMethods } from 'fastify'
import { buildTestApp } from './helpers/fixtures.ts'

const priceCents = 2371, initialStock = 23
const productInput = { id: 'rules-product', name: '独立测试商品', category: '测试分类',
  skus: [{ id: 'rules-product-a', spec: '标准', priceCents, stock: initialStock },
    { id: 'rules-product-b', spec: '加大', priceCents: priceCents + 517, stock: 10 }] }

test('交易状态表：禁止跳步，重复写不倒退，付款后到期不退库存', async () => {
  const { app, accounts, db, testData } = await buildTestApp({ databasePath: ':memory:', publicUrl: 'http://127.0.0.1:3000',
    uploadsPath: './unused', mockPayments: true })
  try {
    testData.product(productInput)
    accounts.register('rules_buyer', 'test-password-123')
    accounts.register('rules_merchant', 'test-password-123', 'merchant')
    const buyer = accounts.login('rules_buyer', 'test-password-123')
    const merchant = accounts.login('rules_merchant', 'test-password-123')
    const call = (method: HTTPMethods, url: string, token = buyer.token, payload?: object) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload })
    const address = await call('POST', '/member/address', buyer.token,
      { receiver: '测试', contact: '13800000000', address: '测试地址', isDefault: 1 })
    const created = await call('POST', '/member/order', buyer.token, { requestKey: randomUUID(),
      addressId: address.json().result.id, goods: [{ skuId: 'rules-product-a', count: 1 }] })
    assert.equal(created.statusCode, 200)
    const id = created.json().result.id as string
    const state = () => db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', id)!.state
    const stock = () => db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', 'rules-product-a')!.stock
    const reservedStock = stock()
    assert.equal(state(), 1)
    assert.equal((await call('POST', `/merchant/orders/${id}/ship`, merchant.token)).statusCode, 409)
    assert.equal((await call('PUT', `/member/order/${id}/receipt`)).statusCode, 409)
    assert.equal((await call('PUT', `/member/order/${id}/evaluation`, buyer.token, { score: 5, content: '尚未收货不能评价' })).statusCode, 409)
    assert.equal((await call('POST', `/member/order/${id}/mock-pay`, buyer.token, { amountCents: 1 })).statusCode, 409)
    assert.equal(state(), 1)
    for (let i = 0; i < 2; i++) assert.equal((await call('POST', `/member/order/${id}/mock-pay`, buyer.token, { amountCents: priceCents })).statusCode, 200)
    assert.equal(state(), 2)
    db.run('UPDATE orders SET expires=0 WHERE id=?', id)
    assert.equal((await call('GET', `/member/order/${id}`)).json().result.orderState, 2)
    assert.equal(stock(), reservedStock)
    assert.equal((await call('PUT', `/member/order/${id}/cancel`)).statusCode, 409)
    assert.equal((await call('POST', `/merchant/orders/${id}/ship`, buyer.token)).statusCode, 403)
    assert.equal((await call('POST', `/merchant/orders/${id}/ship`, merchant.token)).statusCode, 200)
    assert.equal((await call('POST', `/merchant/orders/${id}/ship`, merchant.token)).statusCode, 409)
    assert.equal(state(), 3)
    assert.equal((await call('PUT', `/member/order/${id}/receipt`)).statusCode, 200)
    assert.equal((await call('PUT', `/member/order/${id}/receipt`)).statusCode, 409)
    const review = { score: 5, content: '确认收货后的评价' }
    assert.equal((await call('PUT', `/member/order/${id}/evaluation`, buyer.token, review)).statusCode, 200)
    assert.equal((await call('PUT', `/member/order/${id}/evaluation`, buyer.token, review)).statusCode, 409)
    assert.equal(state(), 5)
    assert.equal(stock(), reservedStock)
    assert.equal(db.one<{ count: number }>('SELECT COUNT(*) AS count FROM evaluations WHERE order_id=?', id)!.count, 1)
  } finally { await app.close() }
})
