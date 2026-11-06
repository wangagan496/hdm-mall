import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildTestApp } from './helpers/fixtures.ts'

async function fixture() {
  let now = Date.UTC(2026, 10, 6)
  const context = await buildTestApp({ databasePath: ':memory:', publicUrl: 'http://fixture', uploadsPath: './unused',
    mockPayments: true, clock: { now: () => now } })
  const buyer = context.testData.account({ account: 'cart_buyer', password: 'password' })
  const other = context.testData.account({ account: 'cart_other', password: 'password' })
  const user = context.accounts.authenticate('Bearer ' + buyer.token)
  const address = context.testData.address({ userId: user.id, receiver: '买家', contact: '13800000000', address: '地址' })
  context.testData.product({ name: '苹果', skus: [{ id: 'cart-apple', spec: '红', priceCents: 100, stock: 5 },
    { id: 'cart-pear', spec: '绿', priceCents: 200, stock: 5 }] })
  const post = (payload: object, token = buyer.token) => context.app.inject({ method: 'POST', url: '/member/cart',
    headers: { authorization: `Bearer ${token}` }, payload })
  const get = (url: string) => context.app.inject({ url, headers: { authorization: `Bearer ${buyer.token}` } })
  return { ...context, buyer, other, address, post, get, advance: (ms: number) => { now += ms } }
}

test('B-14: 同号重试返回原结果，异参冲突，账号隔离', async () => {
  const f = await fixture()
  try {
    const payload = { skuId: 'cart-apple', count: 2, requestKey: randomUUID() }
    const first = await f.post(payload)
    assert.equal(first.statusCode, 200)
    assert.deepEqual((await f.post(payload)).json().result, first.json().result)
    assert.equal((await f.post({ ...payload, count: 1 })).statusCode, 409)
    assert.equal((await f.post(payload, f.other.token)).statusCode, 200)
    assert.equal((await f.get('/member/cart')).json().result[0].count, 2)
    assert.equal(f.db.one<{ count: number }>('SELECT COUNT(*) count FROM cart_requests')!.count, 2)
  } finally { await f.app.close() }
})

test('B-15/B-16: 请求号必填，库存不足不写入', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.post({ skuId: 'cart-apple', count: 1 })).statusCode, 400)
    assert.equal((await f.post({ skuId: 'cart-apple', count: 6, requestKey: randomUUID() })).statusCode, 409)
    assert.equal((await f.get('/member/cart')).json().result.length, 0)
    assert.equal((await f.post({ skuId: 'cart-apple', count: 2, requestKey: randomUUID() })).json().result.count, 2)
    assert.equal((await f.post({ skuId: 'cart-apple', count: 4, requestKey: randomUUID() })).statusCode, 409)
    assert.equal((await f.get('/member/cart/count')).json().result.count, 2)
  } finally { await f.app.close() }
})

test('B-17/B-18: 指定规格预览和立即购买不动购物车', async () => {
  const f = await fixture()
  try {
    await f.post({ skuId: 'cart-apple', count: 2, requestKey: randomUUID() })
    await f.post({ skuId: 'cart-pear', count: 1, requestKey: randomUUID() })
    const before = (await f.get('/member/cart')).json().result
    const preview = (await f.get('/member/order/pre?skuId=cart-apple&count=1')).json().result
    assert.equal(preview.goods.length, 1)
    assert.equal(preview.goods[0].skuId, 'cart-apple')
    assert.equal(preview.goods[0].count, 1)
    assert.equal(preview.summary.totalPayPrice, 1)
    assert.deepEqual((await f.get('/member/cart')).json().result, before)
    const order = await f.app.inject({ method: 'POST', url: '/member/order', headers: { authorization: `Bearer ${f.buyer.token}` },
      payload: { requestKey: randomUUID(), source: 'buy-now', addressId: f.address.id, expectedAmountCents: 100,
        goods: [{ skuId: 'cart-apple', count: 1 }] } })
    assert.equal(order.statusCode, 200)
    assert.deepEqual((await f.get('/member/cart')).json().result.map(({ stock, ...item }: { stock: number }) => item),
      before.map(({ stock, ...item }: { stock: number }) => item))
    assert.equal((await f.get(`/member/order/${order.json().result.id}`)).json().result.skus[0].quantity, 1)
  } finally { await f.app.close() }
})

test('D9: 来源参与下单幂等，购物车来源仍移出商品', async () => {
  const f = await fixture()
  try {
    await f.post({ skuId: 'cart-apple', count: 2, requestKey: randomUUID() })
    const request = { requestKey: randomUUID(), source: 'buy-now', addressId: f.address.id, expectedAmountCents: 100,
      goods: [{ skuId: 'cart-apple', count: 1 }] }
    const create = (payload: object) => f.app.inject({ method: 'POST', url: '/member/order',
      headers: { authorization: `Bearer ${f.buyer.token}` }, payload })
    assert.equal((await create(request)).statusCode, 200)
    assert.equal((await create({ ...request, source: 'cart' })).statusCode, 409)
    assert.equal((await create({ ...request, requestKey: randomUUID(), source: 'cart' })).statusCode, 200)
    assert.equal((await f.get('/member/cart')).json().result.length, 0)
  } finally { await f.app.close() }
})

test('B-14: 回执写入失败时购物车整体回滚，同号可安全重试', async () => {
  const f = await fixture()
  try {
    const run = f.db.run.bind(f.db)
    f.db.run = (sql, ...params) => {
      if (sql.startsWith('INSERT INTO cart_requests')) throw new Error('receipt disk failure')
      return run(sql, ...params)
    }
    const body = { skuId: 'cart-apple', count: 2, requestKey: randomUUID() }
    assert.equal((await f.post(body)).statusCode, 500)
    assert.equal((await f.get('/member/cart')).json().result.length, 0)
    assert.equal(f.db.one<{ count: number }>('SELECT COUNT(*) count FROM cart_requests')!.count, 0)
    f.db.run = run
    assert.equal((await f.post(body)).json().result.count, 2)
    assert.equal((await f.post(body)).json().result.count, 2)
  } finally { await f.app.close() }
})

test('D9: 指定预览参数成对校验，缺货仍展示，未知规格拒绝', async () => {
  const f = await fixture()
  try {
    for (const query of ['skuId=cart-apple', 'count=1', 'skuId=cart-apple&count=0', 'skuId=cart-apple&count=1.5']) {
      assert.equal((await f.get('/member/order/pre?' + query)).statusCode, 400)
    }
    assert.equal((await f.get('/member/order/pre?skuId=missing&count=1')).statusCode, 404)
    const preview = (await f.get('/member/order/pre?skuId=cart-apple&count=6')).json().result
    assert.equal(preview.goods[0].stock, 5)
    assert.equal(preview.goods[0].count, 6)
    assert.equal((await f.get('/member/cart')).json().result.length, 0)
  } finally { await f.app.close() }
})
