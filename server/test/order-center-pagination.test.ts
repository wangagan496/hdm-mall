import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTestApp } from './helpers/fixtures.ts'

const priceCents = 2371, initialStock = 23
const productInput = { id: 'center-product', name: '独立测试商品', category: '测试分类',
  skus: [{ id: 'center-product-a', spec: '标准', priceCents, stock: initialStock },
    { id: 'center-product-b', spec: '加大', priceCents: priceCents + 517, stock: 10 }] }

async function fixture() {
  const f = await buildTestApp({ databasePath: ':memory:', publicUrl: 'http://fixture', mockPayments: true, uploadsPath: './unused' })
  f.testData.product(productInput)
  const users: Record<string, { id: string; token: string }> = {}
  for (const name of ['buyer', 'friend', 'other', 'merchant']) {
    f.accounts.register(name, 'center-test-password', name === 'merchant' ? 'merchant' : 'buyer')
    users[name] = f.accounts.login(name, 'center-test-password')
  }
  for (const name of ['friend', 'merchant']) {
    f.db.run("INSERT INTO relations VALUES(?,?,?,'accepted',?)", name, users.buyer.id, users[name].id, Date.now())
  }
  const add = (id: string, state: number, payer: string | null = null, invited: string | null = null, receiver: string | null = null, owner = 'buyer', created = 1700000000000) => {
    f.db.run('INSERT INTO orders(id,owner_id,state,amount,address,request_key,request_body,created,expires,paid_by,invited_payer,received_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      id, users[owner].id, state, priceCents, '{"receiver":"测试","contact":"13800138000","address":"private"}', id, '{}', created, Date.now() + 900000,
      payer ? users[payer].id : null, invited ? users[invited].id : null, receiver ? users[receiver].id : null)
    f.db.run('INSERT INTO order_items VALUES(?,?,?,?,?,?,?,?)', id, 'center-product-a', 'center-product', id, '/assets/product.svg', '标准款', priceCents, 1)
  }
  const get = (path: string, name = 'friend') => f.app.inject({ url: path, headers: { authorization: `Bearer ${users[name].token}` } })
  return { ...f, users, add, get }
}

test('亲友订单分页先限定可读范围，同时间翻页不重漏，解绑立即移除未参与订单', async () => {
  const f = await fixture()
  try {
    for (let i = 22; i >= 0; i--) f.add(`invited-${String(i).padStart(2, '0')}`, 1, null, 'friend')
    f.add('paid', 2, 'friend'); f.add('received', 5, 'other', null, 'friend')
    f.add('can-receive', 3, 'other'); f.add('self-paid', 3, 'buyer')
    f.add('not-invited', 1, null, 'other'); f.add('cancelled', 6, null, 'friend')
    f.add('own', 1, null, null, null, 'friend')
    const ids: string[] = []
    for (let page = 1; page <= 3; page++) {
      const response = await f.get(`/member/family-orders/page?page=${page}&pageSize=10`)
      assert.equal(response.statusCode, 200)
      const result = response.json().result
      assert.equal(result.counts, 26); assert.equal(result.pages, 3)
      for (const order of result.items) {
        assert.equal(order.address, undefined)
        assert.equal((await f.get(`/member/order/${order.id}`)).statusCode, 200)
        ids.push(order.id)
      }
    }
    assert.equal(new Set(ids).size, 26)
    assert.deepEqual(ids, [...ids].sort())
    assert.equal((await f.get('/member/family-orders')).json().result.length, 26)
    f.db.run("UPDATE relations SET status='revoked' WHERE id='friend'")
    const remaining = (await f.get('/member/family-orders/page')).json().result
    assert.deepEqual(remaining.items.map((r: { id: string }) => r.id), ['paid', 'received'])
    assert.equal(remaining.counts, 2)
    assert.equal((await f.get('/member/family-orders/page', 'other')).json().result.counts, 2)
  } finally { await f.app.close() }
})

test('商家发货分页只整理当前页的明细，按最早下单顺序返回并排除已发货订单', async () => {
  const f = await fixture()
  try {
    f.db.transaction(() => {
      for (let i = 199; i >= 0; i--) f.add(`ship-${String(i).padStart(3, '0')}`, 2, 'buyer', null, null, 'buyer', 1700000000000 + i)
      f.add('shipped', 3, 'buyer')
    })
    let details = 0, rowsRead = 0
    const all = f.db.all.bind(f.db)
    f.db.all = (<T>(sql: string, ...params: Parameters<typeof f.db.all>[1][]) => {
      const rows = all<T>(sql, ...params)
      if (sql.startsWith('SELECT * FROM order_items')) details++
      if (sql.includes('SELECT o.* FROM orders')) rowsRead += rows.length
      return rows
    }) as typeof f.db.all
    const response = await f.get('/merchant/orders/page?page=2&pageSize=10', 'merchant')
    assert.equal(response.statusCode, 200)
    const result = response.json().result
    assert.equal(result.counts, 200); assert.equal(result.pages, 20)
    assert.deepEqual(result.items.map((r: { id: string }) => r.id), Array.from({ length: 10 }, (_, i) => `ship-${String(i + 10).padStart(3, '0')}`))
    assert.ok(result.items.every((r: { address?: object }) => r.address))
    assert.equal(details, 10); assert.equal(rowsRead, 10)
    console.log(`MERCHANT_PAGE total=${result.counts} materialized=${rowsRead} detailQueries=${details}`)
    f.db.run("UPDATE orders SET state=3 WHERE id='ship-010'")
    const updated = (await f.get('/merchant/orders/page?page=2&pageSize=10', 'merchant')).json().result
    assert.equal(updated.counts, 199); assert.equal(updated.items[0].id, 'ship-011')
  } finally { await f.app.close() }
})

test('商家身份作为亲友不能从亲友列表或详情取得地址，发货入口仍可取履约地址', async () => {
  const f = await fixture()
  try {
    f.add('invited-merchant', 1, null, 'merchant')
    f.add('merchant-paid', 2, 'merchant')
    for (const path of ['/member/family-orders/page', '/member/family-orders']) {
      const result = (await f.get(path, 'merchant')).json().result
      assert.ok((Array.isArray(result) ? result : result.items).every((r: { address?: object }) => !r.address))
    }
    assert.equal((await f.get('/member/order/merchant-paid', 'merchant')).json().result.address, undefined)
    assert.ok((await f.get('/merchant/orders/page', 'merchant')).json().result.items[0].address)
    assert.ok((await f.get('/merchant/orders', 'merchant')).json().result[0].address)
    assert.ok((await f.get('/member/order/merchant-paid', 'buyer')).json().result.address)
  } finally { await f.app.close() }
})

test('订单分页验证登录角色和参数，空页与超大合法页码不出错', async () => {
  const f = await fixture()
  try {
    for (const path of ['/member/family-orders/page', '/merchant/orders/page']) {
      assert.equal((await f.app.inject(path)).statusCode, 401)
      const name = path.startsWith('/merchant') ? 'merchant' : 'friend'
      for (const query of ['page=0', 'pageSize=101', 'page=1.5']) assert.equal((await f.get(`${path}?${query}`, name)).statusCode, 400)
      const result = (await f.get(`${path}?page=${Number.MAX_SAFE_INTEGER}`, name)).json().result
      assert.deepEqual(result, { items: [], counts: 0, pages: 0, page: Number.MAX_SAFE_INTEGER, pageSize: 10 })
    }
    assert.equal((await f.get('/merchant/orders/page')).statusCode, 403)
  } finally { await f.app.close() }
})
