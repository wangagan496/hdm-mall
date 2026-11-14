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
    f.db.run('INSERT INTO order_items(order_id,sku_id,product_id,name,picture,spec,price,count) VALUES(?,?,?,?,?,?,?,?)', id, 'center-product-a', 'center-product', id, '/assets/product.svg', '标准款', priceCents, 1)
  }
  const get = (path: string, name = 'friend') => f.app.inject({ url: path, headers: { authorization: `Bearer ${users[name].token}` } })
  return { ...f, users, add, get }
}

test('亲友分组在分页前筛选且数量覆盖全部可读订单，权限与明细一致', async () => {
  const f = await fixture()
  try {
    for (let i = 0; i < 23; i++) f.add(`group-pay-${String(i).padStart(2, '0')}`, 1, null, 'friend')
    f.add('group-receipt', 3, 'friend')
    f.add('group-private', 1, null, 'other')
    const all = (await f.get('/member/family-orders')).json().result
    const expected = { all: all.length, pay: all.filter((o: any) => o.canPay).length,
      receipt: all.filter((o: any) => o.canReceive).length,
      pending: all.filter((o: any) => o.needsAttention || ['confirming', 'review'].includes(o.paymentState)).length }
    for (const group of ['pay', 'receipt', 'pending', 'all']) {
      const result = (await f.get(`/member/family-orders/page?group=${group}&pageSize=10`)).json().result
      assert.deepEqual(result.groupCounts, expected)
      assert.equal(result.counts, expected[group as keyof typeof expected])
      if (group === 'receipt') assert.deepEqual(result.items.map((o: any) => o.id), ['group-receipt'])
    }
    const last = (await f.get('/member/family-orders/page?group=pay&page=3&pageSize=10')).json().result
    assert.equal(last.items.length, 3)
    assert.equal((await f.get('/member/family-orders/page?group=invalid')).statusCode, 400)
    f.db.run("UPDATE relations SET status='revoked' WHERE id='friend'")
    const revoked = (await f.get('/member/family-orders/page?group=pay')).json().result
    assert.equal(revoked.groupCounts.pay, 0)
    assert.equal(revoked.groupCounts.all, 1)
  } finally { await f.app.close() }
})

test('E19 亲友分组分页复用已得计数，每次请求仅计算四个分组且零结果不重计', async () => {
  const f = await fixture()
  try {
    f.add('count-reuse-pay', 1, null, 'friend')
    const original = f.db.one.bind(f.db)
    let countQueries = 0
    f.db.one = (<T>(sql: string, ...params: Parameters<typeof f.db.one>[1][]) => {
      if (sql.startsWith('SELECT COUNT(*) AS count FROM orders o WHERE')) countQueries++
      return original<T>(sql, ...params)
    }) as typeof f.db.one
    for (const group of ['all', 'pay', 'receipt', 'pending']) {
      countQueries = 0
      const response = await f.get(`/member/family-orders/page?group=${group}&pageSize=10`)
      assert.equal(response.statusCode, 200)
      const page = response.json().result
      assert.equal(page.counts, group === 'all' || group === 'pay' ? 1 : 0)
      assert.deepEqual(page.groupCounts, { pay: 1, receipt: 0, pending: 0, all: 1 })
      assert.equal(countQueries, 4, '分组统计已给出当前分页总数，不应重复扫描')
    }
  } finally { await f.app.close() }
})

test('亲友分组与确认中、关闭后核对、人工核实和未读通知的展示字段一致', async () => {
  const f = await fixture()
  try {
    const now = Date.now()
    for (const [id, state, review, next] of [['pending', 'pending', null, now + 600000], ['closed', 'closed', null, now + 600000],
      ['review', 'pending', now, now + 600000], ['failed', 'failed', null, null]] as const) {
      f.add(id, 1, null, 'friend')
      f.db.run(`INSERT INTO payments(id,order_id,payer_id,amount,state,created,grace_deadline,review_at,next_query_at)
        VALUES(?,?,?,?,?,?,?,?,?)`, id, id, f.users.friend.id, priceCents, state, now, now + 900000, review, next)
    }
    f.add('notified', 2, 'friend')
    f.db.run("INSERT INTO payment_notices(id,order_id,recipient_id,kind,created) VALUES('notice','notified',?,'review',?)", f.users.friend.id, now)
    f.add('restricted-receipt', 3, 'other')
    f.db.run(`INSERT INTO payments(id,order_id,payer_id,amount,state,created,grace_deadline)
      VALUES('previous','restricted-receipt',?,?,'failed',?,?)`, f.users.friend.id, priceCents, now, now + 900000)
    const all = (await f.get('/member/family-orders')).json().result
    const predicates = { pay: (o: any) => o.canPay === true, receipt: (o: any) => o.canReceive === true,
      pending: (o: any) => o.needsAttention || ['confirming', 'review'].includes(o.paymentState) }
    for (const group of ['pay', 'receipt', 'pending'] as const) {
      const expected = all.filter(predicates[group]).map((o: any) => o.id)
      const result = (await f.get(`/member/family-orders/page?group=${group}`)).json().result
      assert.deepEqual(result.items.map((o: any) => o.id), expected)
      assert.equal(result.groupCounts[group], expected.length)
    }
    assert.equal((await f.get('/member/family-orders/page?group=pending', 'other')).json().result.groupCounts.pending, 0)
  } finally { await f.app.close() }
})

test('亲友订单分页先限定可读范围，同时间翻页不重漏，解绑立即移除未参与订单', async () => {
  const f = await fixture()
  try {
    for (let i = 22; i >= 0; i--) f.add(`invited-${String(i).padStart(2, '0')}`, 1, null, 'friend')
    f.add('paid', 2, 'friend'); f.add('received', 5, 'other', null, 'friend')
    f.add('can-receive', 3, 'other'); f.add('self-paid', 3, 'buyer')
    f.add('not-invited', 1, null, 'other'); f.add('cancelled', 6, null, 'friend')
    f.add('own', 1, null, null, null, 'friend')
    f.add('cancelled-without-payment-record', 6, 'friend', null, 'friend')
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

test('买家全部分页包含本人的已取消订单，数量页数正确且其他栏目仍按状态筛选', async () => {
  const f = await fixture()
  try {
    for (let index = 0; index < 12; index++) f.add(`cancelled-${String(index).padStart(2, '0')}`, 6)
    for (let state = 1; state <= 5; state++) f.add(`active-${state}`, state)
    f.add('foreign-cancelled', 6, null, null, null, 'other')
    const ids: string[] = []
    for (let page = 1; page <= 2; page++) {
      const response = await f.get(`/member/order?orderState=0&page=${page}&pageSize=10`, 'buyer')
      assert.equal(response.statusCode, 200)
      const result = response.json().result
      assert.equal(result.counts, 17); assert.equal(result.pages, 2)
      ids.push(...result.items.map((order: { id: string }) => order.id))
    }
    assert.equal(new Set(ids).size, 17)
    assert.equal(ids.filter(id => id.startsWith('cancelled-')).length, 12)
    const buyer = f.accounts.authenticate(`Bearer ${f.users.buyer.token}`)
    assert.equal(f.orders.list(buyer).length, 17)
    for (let state = 1; state <= 5; state++) {
      const result = (await f.get(`/member/order?orderState=${state}&page=1&pageSize=10`, 'buyer')).json().result
      assert.equal(result.counts, 1); assert.equal(result.pages, 1)
      assert.deepEqual(result.items.map((order: { id: string }) => order.id), [`active-${state}`])
      assert.equal(f.orders.list(buyer, state).length, 1)
    }
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
