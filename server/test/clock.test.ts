import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildTestApp } from './helpers/fixtures.ts'

const start = Date.UTC(2030, 0, 1)
test('注入时钟：十五分钟到期自动取消，重复读取与取消只归还一次库存', async () => {
  let now = start
  const options = { databasePath: ':memory:', publicUrl: 'http://fixture', uploadsPath: './unused',
    mockPayments: true, clock: { now: () => now } }
  const f = await buildTestApp(options)
  try {
    f.accounts.register('clock_buyer', 'clock-password-123')
    f.accounts.register('clock_merchant', 'clock-password-123', 'merchant')
    const buyer = f.accounts.login('clock_buyer', 'clock-password-123')
    const merchant = f.accounts.login('clock_merchant', 'clock-password-123')
    const headers = { authorization: `Bearer ${buyer.token}` }
    const address = f.accounts.saveAddress(f.accounts.authenticate(headers.authorization),
      { receiver: '时钟测试', contact: '13800000000', address: '测试地址' })
    f.testData.product({ id: 'clock-product', name: '时钟商品',
      skus: [{ id: 'clock-sku', spec: '标准', priceCents: 2367, stock: 11 }] })
    const created = await f.app.inject({ method: 'POST', url: '/member/order', headers,
      payload: { requestKey: randomUUID(), expectedAmountCents: 4734, addressId: address.id, goods: [{ skuId: 'clock-sku', count: 2 }] } })
    assert.equal(created.statusCode, 200)
    const id = created.json().result.id
    const detail = () => f.app.inject({ url: `/member/order/${id}`, headers })
    assert.equal(f.db.one<{ created: number }>('SELECT created FROM orders WHERE id=?', id)!.created, start)
    assert.equal(f.db.one<{ created: number }>("SELECT created FROM inventory_movements WHERE kind='reserve'")!.created, start)
    now = start + 15 * 60_000 - 1
    assert.equal((await detail()).json().result.orderState, 1)
    now++
    assert.equal((await detail()).json().result.orderState, 6)
    now++
    assert.equal((await detail()).json().result.orderState, 6)
    await f.app.inject({ method: 'PUT', url: `/member/order/${id}/cancel`, headers })
    const stock = await f.app.inject({ url: '/goods?id=clock-product' })
    assert.equal(stock.json().skus[0].inventory, 11)
    const ledger = await f.app.inject({ url: '/merchant/inventory/clock-sku/movements',
      headers: { authorization: `Bearer ${merchant.token}` } })
    const releases = ledger.json().result.items.filter((item: { kind: string }) => item.kind === 'expire')
    assert.equal(releases.length, 1)
    assert.equal(releases[0].createdAt, start + 15 * 60_000)
  } finally { await f.app.close() }
})

test('注入时钟：会话在二十四小时边界失效且拒绝写入，不需要真实等待', async () => {
  let now = start
  const options = { databasePath: ':memory:', publicUrl: 'http://fixture', uploadsPath: './unused',
    mockPayments: true, clock: { now: () => now } }
  const f = await buildTestApp(options)
  try {
    f.accounts.register('clock_session', 'clock-password-123')
    const user = f.accounts.login('clock_session', 'clock-password-123')
    const headers = { authorization: `Bearer ${user.token}` }
    now += 24 * 3600_000 - 1
    assert.equal((await f.app.inject({ url: '/member/profile', headers })).statusCode, 200)
    now++
    assert.equal((await f.app.inject({ url: '/member/profile', headers })).statusCode, 401)
    assert.equal((await f.app.inject({ method: 'POST', url: '/member/address', headers,
      payload: { receiver: '不能写入', contact: '13800000000', address: '过期会话' } })).statusCode, 401)
  } finally { await f.app.close() }
})

test('同一时钟覆盖付款、发货、收货、评价、关系和商家库存调整', async () => {
  let now = 0
  const f = await buildTestApp({ databasePath: ':memory:', publicUrl: 'http://fixture', uploadsPath: './unused',
    mockPayments: true, clock: { now: () => now } })
  try {
    const buyer = f.testData.account({ account: 'time_buyer', password: 'clock-password-123' })
    const friend = f.testData.account({ account: 'time_friend', password: 'clock-password-123' })
    const merchant = f.testData.account({ account: 'time_merchant', password: 'clock-password-123', role: 'merchant' })
    const address = f.testData.address({ userId: buyer.id, receiver: '测试', contact: '13800000000', address: '时间夹具' })
    const product = f.testData.product({ name: '共用时钟', skus: [{ spec: '标准', priceCents: 3157, stock: 9 }] })
    const sku = product.skus[0]!
    const user = f.accounts.authenticate('Bearer ' + buyer.token)
    const order = f.orders.create(user, { requestKey: randomUUID(), expectedAmountCents: sku.priceCents, addressId: address.id, goods: [{ skuId: sku.id, count: 1 }] })
    assert.equal(f.db.one<{ created: number }>('SELECT created FROM orders WHERE id=?', order.id)!.created, 0)
    now = 1000
    f.testData.relation({ ownerId: buyer.id, friendId: friend.id })
    assert.equal(f.db.one<{ created: number }>('SELECT created FROM relations')!.created, now)
    const request = (method: 'POST' | 'PUT', url: string, token: string, payload?: object) =>
      f.app.inject({ method, url, headers: { authorization: 'Bearer ' + token }, payload })
    now = 2000
    assert.equal((await request('POST', '/member/order/' + order.id + '/mock-pay', buyer.token, { amountCents: sku.priceCents })).statusCode, 200)
    assert.equal(f.db.one<{ paid_at: number }>('SELECT paid_at FROM orders WHERE id=?', order.id)!.paid_at, now)
    now = 3000
    assert.equal((await request('POST', '/merchant/orders/' + order.id + '/ship', merchant.token)).statusCode, 200)
    assert.equal(f.db.one<{ shipped_at: number }>('SELECT shipped_at FROM orders WHERE id=?', order.id)!.shipped_at, now)
    now = 4000
    assert.equal((await request('PUT', '/member/order/' + order.id + '/receipt', buyer.token)).statusCode, 200)
    assert.equal(f.db.one<{ received_at: number }>('SELECT received_at FROM orders WHERE id=?', order.id)!.received_at, now)
    now = 5000
    assert.equal((await request('PUT', '/member/order/' + order.id + '/evaluation', buyer.token, { score: 5, content: '时钟一致性评价' })).statusCode, 200)
    assert.equal(f.db.one<{ created: number }>('SELECT created FROM evaluations WHERE order_id=?', order.id)!.created, now)
    now = 6000
    assert.equal((await request('PUT', '/merchant/inventory/' + sku.id + '/adjustments', merchant.token, {
      requestKey: randomUUID(), delta: 2, expectedStock: 8, reason: '时钟测试盘点增加'
    })).statusCode, 200)
    assert.equal(f.db.one<{ created: number }>("SELECT created FROM inventory_movements WHERE kind='adjust'")!.created, now)
    now = 7000
    const cancelled = f.orders.create(user, { requestKey: randomUUID(), expectedAmountCents: sku.priceCents, addressId: address.id, goods: [{ skuId: sku.id, count: 1 }] })
    now = 8000
    f.orders.cancel(user, cancelled.id)
    assert.equal(f.db.one<{ created: number }>("SELECT created FROM inventory_movements WHERE kind='cancel'")!.created, now)
  } finally { await f.app.close() }
})
