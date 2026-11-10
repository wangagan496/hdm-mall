import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTestApp } from './helpers/fixtures.ts'

const options = { databasePath: ':memory:', publicUrl: 'http://fixture', mockPayments: true, uploadsPath: './unused' }
test('首页新增分页只读当前页，分类摘要不加载商品正文且售罄分类隐藏', async () => {
  const f = await buildTestApp(options)
  try {
    for (let i = 0; i < 1000; i++) {
      const id = `bulk-${String(i).padStart(4, '0')}`
      f.testData.product({ id, name: '分页商品', category: '分页服饰',
        skus: [{ id: id + '-sku', spec: '标准', priceCents: 217, stock: 2 }] })
    }
    const all = f.db.all.bind(f.db)
    let materialized = 0, queryCount = 0
    f.db.all = (<T>(sql: string, ...params: Parameters<typeof f.db.all>[1][]) => {
      const rows = all<T>(sql, ...params)
      queryCount++
      if (sql.includes('FROM products')) materialized += rows.length
      return rows
    }) as typeof f.db.all
    for (const path of ['/home/new/page', '/home/recommend/page']) {
      materialized = 0
      const response = await f.app.inject(`${path}?page=2&pageSize=8`)
      assert.equal(response.statusCode, 200)
      const page = response.json().result
      assert.equal(page.counts, 1000); assert.equal(page.items.length, 8); assert.equal(materialized, 8)
      console.log(`HOME_PAGE route=${path} total=${page.counts} materialized=${materialized}`)
    }
    materialized = 0; queryCount = 0
    const legacy = (await f.app.inject('/category/top')).json().result
    const legacyRows = materialized, legacyQueries = queryCount
    materialized = 0; queryCount = 0
    const response = await f.app.inject('/category/summary')
    assert.equal(response.statusCode, 200)
    const categories = response.json().result
    assert.deepEqual(categories, legacy.map((p: any) => ({ id: p.id, name: p.name, picture: p.picture,
      children: p.children.map((c: any) => ({ id: c.id, name: c.name, picture: c.picture })) })))
    assert.equal(materialized, 0)
    assert.equal(queryCount, 1)
    console.log(`CATEGORY_SUMMARY legacyRows=${legacyRows} legacyQueries=${legacyQueries} summaryQueries=${queryCount} legacyBytes=${Buffer.byteLength(JSON.stringify(legacy))} summaryBytes=${Buffer.byteLength(JSON.stringify(categories))}`)
    assert.ok(!JSON.stringify(categories).includes('"goods"'))
    f.db.run('UPDATE skus SET stock=0')
    assert.deepEqual((await f.app.inject('/category/summary')).json().result, [])
    assert.equal((await f.app.inject('/home/new')).json().result.length, 0)
  } finally { await f.app.close() }
})

test('首页分页拒绝无效参数，越界不读正文，旧数组保持兼容', async () => {
  const f = await buildTestApp(options)
  try {
    f.testData.product({ name: '兼容商品', skus: [{ spec: '默认', priceCents: 531, stock: 3 }] })
    for (const path of ['/home/new/page', '/home/recommend/page']) {
      for (const query of ['page=0', 'pageSize=101', 'page=1.5']) assert.equal((await f.app.inject(`${path}?${query}`)).statusCode, 400)
      assert.deepEqual((await f.app.inject(`${path}?page=${Number.MAX_SAFE_INTEGER}`)).json().result.items, [])
    }
    for (const path of ['/home/new', '/home/recommend']) assert.equal((await f.app.inject(path)).json().result.length, 1)
  } finally { await f.app.close() }
})

async function relationsFixture() {
  const f = await buildTestApp(options)
  f.accounts.register('owner', 'relation-test-pass')
  f.accounts.register('outsider', 'relation-test-pass')
  const owner = f.accounts.login('owner', 'relation-test-pass'), outsider = f.accounts.login('outsider', 'relation-test-pass')
  const seedUser = f.db.one<any>('SELECT * FROM users WHERE id=?', outsider.id)!
  f.db.transaction(() => {
    for (let i = 24; i >= 0; i--) {
      const id = `friend-${String(i).padStart(2, '0')}`
      f.db.run('INSERT INTO users(id,account,password,nickname,role,profile) SELECT ?,?,password,nickname,role,profile FROM users WHERE id=?', id, id, seedUser.id)
      f.db.run('INSERT INTO relations VALUES(?,?,?,?,?)', `relation-${String(i).padStart(2, '0')}`, owner.id, id, i === 24 ? 'revoked' : i === 23 ? 'pending' : 'accepted', 1)
    }
    f.db.run('INSERT INTO relations VALUES(?,?,?,?,?)', 'incoming', outsider.id, owner.id, 'accepted', 2)
    f.db.run('INSERT INTO relations VALUES(?,?,?,?,?)', 'private', outsider.id, 'friend-00', 'accepted', 3)
  })
  const get = (path: string) => f.app.inject({ url: path, headers: { authorization: `Bearer ${owner.token}` } })
  return { ...f, owner, get }
}

test('关系列表先限定本人和方向再分页，稳定次序不重漏并只读取当前页', async () => {
  const f = await relationsFixture()
  try {
    const ids: string[] = [], all = f.db.all.bind(f.db)
    let materialized = 0
    f.db.all = (<T>(sql: string, ...params: Parameters<typeof f.db.all>[1][]) => {
      const rows = all<T>(sql, ...params)
      if (sql.includes('FROM relations')) materialized += rows.length
      return rows
    }) as typeof f.db.all
    for (let page = 1; page <= 3; page++) {
      materialized = 0
      const response = await f.get(`/member/relations/page?page=${page}&pageSize=10`)
      assert.equal(response.statusCode, 200)
      const result = response.json().result
      assert.equal(result.counts, 25); assert.equal(result.pages, 3)
      assert.equal(materialized, result.items.length)
      for (const row of result.items) {
        assert.deepEqual(Object.keys(row).sort(), ['id', 'status', 'ownerId', 'friendId', 'ownerAccount', 'friendAccount'].sort())
        ids.push(row.id)
      }
    }
    assert.deepEqual(ids, ['incoming', ...Array.from({ length: 24 }, (_, i) => `relation-${String(i).padStart(2, '0')}`)])
    const payer = (await f.get('/member/relations/page?scope=payer&page=3&pageSize=10')).json().result
    assert.equal(payer.counts, 23); assert.equal(payer.items.length, 3)
    assert.ok(payer.items.every((r: any) => r.ownerId === f.owner.id && r.status === 'accepted'))
    f.db.run("UPDATE relations SET status='revoked' WHERE id='relation-22'")
    assert.equal((await f.get('/member/relations/page?scope=payer')).json().result.counts, 22)
    assert.equal((await f.get('/member/relations')).json().result.length, 24)
  } finally { await f.app.close() }
})

test('关系列表拒绝未登录和非法条件，空页及超大页码安全返回', async () => {
  const f = await relationsFixture()
  try {
    let reads = 0
    const all = f.db.all.bind(f.db)
    f.db.all = (<T>(sql: string, ...params: Parameters<typeof f.db.all>[1][]) => {
      if (sql.includes('FROM relations')) reads++
      return all<T>(sql, ...params)
    }) as typeof f.db.all
    assert.equal((await f.app.inject('/member/relations/page')).statusCode, 401)
    for (const query of ['page=0', 'pageSize=101', 'scope=other', "scope=payer%27%20OR%201=1"]) {
      assert.equal((await f.get(`/member/relations/page?${query}`)).statusCode, 400)
    }
    assert.deepEqual((await f.get(`/member/relations/page?page=${Number.MAX_SAFE_INTEGER}`)).json().result.items, [])
    assert.equal(reads, 0)
  } finally { await f.app.close() }
})
