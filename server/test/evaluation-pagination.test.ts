import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.ts'

async function fixture(count: number) {
  const f = await buildApp({ databasePath: ':memory:', publicUrl: 'http://fixture', mockPayments: true, uploadsPath: './unused' })
  f.accounts.register('review_reader', 'review-test-password')
  const owner = f.db.one<{ id: string }>('SELECT id FROM users WHERE account=?', 'review_reader')!.id
  f.db.run('UPDATE users SET nickname=? WHERE id=?', '😀用户甲', owner)
  const expected: { id: string; created: number }[] = []
  f.db.transaction(() => {
    // 倒序插入与相同毫秒的评价用于检查跨页次序；直接准备数据，不充作下单流程证明。
    for (let index = count + 6; index >= 0; index--) {
      const id = `review-${String(index).padStart(5, '0')}`
      const created = 1700000000000 + index % 3
      const product = index < count ? 'hdm-1' : 'hdm-2'
      f.db.run('INSERT INTO orders(id,owner_id,state,amount,address,request_key,request_body,created,expires) VALUES(?,?,5,1900,?,?,?,?,?)',
        id, owner, '{"contact":"13800138000","address":"private"}', id, '{}', created, created + 900000)
      f.db.run('INSERT INTO order_items VALUES(?,?,?,?,?,?,?,?)', id, `${product}-a`, product, '测试商品', '/assets/product.svg', '标准款', 1900, 1)
      if (index === 0) {
        f.db.run('INSERT INTO order_items VALUES(?,?,?,?,?,?,?,?)', id, 'hdm-1-b', 'hdm-1', '测试商品', '/assets/product.svg', '加大款', 2400, 1)
      }
      if (index === count + 6) continue // 尚未评价的订单不计入总数。
      f.db.run('INSERT INTO evaluations VALUES(?,?,?,?)', id, 5, `评价内容 ${index}`, created)
      if (index < count) expected.push({ id, created })
    }
  })
  expected.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
  return { ...f, expected }
}

test('商品评价按商品计数且一单多规格不重复，同毫秒评价跨页次序固定并保留脱敏契约', async () => {
  const f = await fixture(23)
  try {
    const actual: string[] = []
    for (let page = 1; page <= 5; page++) {
      const response = await f.app.inject(`/goods/hdm-1/evaluate/page?page=${page}&pageSize=5`)
      assert.equal(response.statusCode, 200)
      const result = response.json().result
      assert.equal(result.counts, 23); assert.equal(result.pages, 5)
      assert.equal(result.page, page); assert.equal(result.pageSize, 5)
      assert.equal(result.items.length, page === 5 ? 3 : 5)
      for (const item of result.items) {
        assert.deepEqual(Object.keys(item).sort(), ['content', 'createTime', 'id', 'member', 'pictures', 'score'])
        assert.deepEqual(item.member, { nickname: '😀***甲' })
        assert.deepEqual(item.pictures, [])
        assert.equal(item.score, 5)
        assert.equal(item.createTime, new Date(f.expected.find(row => row.id === item.id)!.created).toISOString())
        actual.push(item.id)
      }
    }
    assert.deepEqual(actual, f.expected.map(row => row.id))
    assert.equal(new Set(actual).size, 23)
    const other = (await f.app.inject('/goods/hdm-2/evaluate/page')).json().result
    assert.equal(other.counts, 6)
    assert.equal(other.items.length, 6)
  } finally { await f.app.close() }
})

test('两千条商品评价请求二十条时仅取当前页，不把所有正文读入应用', async () => {
  const f = await fixture(2000)
  try {
    const reads: number[] = []
    const all = f.db.all.bind(f.db)
    f.db.all = (<T>(sql: string, ...params: Parameters<typeof f.db.all>[1][]) => {
      const rows = all<T>(sql, ...params)
      if (sql.includes('evaluations')) reads.push(rows.length)
      return rows
    }) as typeof f.db.all
    const response = await f.app.inject('/goods/hdm-1/evaluate/page?page=7&pageSize=20')
    assert.equal(response.statusCode, 200)
    const result = response.json().result
    assert.equal(result.counts, 2000); assert.equal(result.pages, 100)
    console.log(`EVALUATION_PAGE total=${result.counts} returned=${result.items.length} materialized=${reads.reduce((a, b) => a + b, 0)}`)
    assert.deepEqual(reads, [20], '数据库读取的评价正文必须限定为当前页')
    assert.deepEqual(result.items.map((row: { id: string }) => row.id), f.expected.slice(120, 140).map(row => row.id))
  } finally { await f.app.close() }
})

test('评价页在查询前拒绝非法参数，空结果、越界页和超大合法页保持分页契约', async () => {
  const f = await fixture(12)
  try {
    let reviewReads = 0
    const all = f.db.all.bind(f.db)
    f.db.all = (<T>(sql: string, ...params: Parameters<typeof f.db.all>[1][]) => {
      if (sql.includes('evaluations')) reviewReads++
      return all<T>(sql, ...params)
    }) as typeof f.db.all
    for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=no', 'pageSize=0', 'pageSize=101', 'pageSize=1.5']) {
      assert.equal((await f.app.inject(`/goods/hdm-1/evaluate/page?${query}`)).statusCode, 400)
    }
    assert.equal(reviewReads, 0, '非法分页不能先读取评价正文')
    for (const page of [3, Number.MAX_SAFE_INTEGER]) {
      const response = await f.app.inject(`/goods/hdm-1/evaluate/page?page=${page}&pageSize=10`)
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json().result, { items: [], counts: 12, pages: 2, page, pageSize: 10 })
    }
    for (const product of ['missing', "x' OR 1=1 --"]) {
      const response = await f.app.inject(`/goods/${encodeURIComponent(product)}/evaluate/page`)
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json().result, { items: [], counts: 0, pages: 0, page: 1, pageSize: 10 })
    }
  } finally { await f.app.close() }
})
