import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.ts'

async function fixture(count = 37) {
  const f = await buildApp({ databasePath: ':memory:', publicUrl: 'http://fixture', mockPayments: true, uploadsPath: './unused' })
  const products: { id: string; name: string; category: string; price: number; child: string; stock: number }[] = []
  f.db.transaction(() => {
    f.db.run('INSERT INTO categories VALUES(?,?,NULL,?)', 'test-root', '测试分类', 'test-root')
    for (const id of ['test-a', 'test-b']) f.db.run('INSERT INTO categories VALUES(?,?,?,?)', id, id, 'test-root', id)
    for (let index = count - 1; index >= 0; index--) {
      const id = `test-${String(index).padStart(4, '0')}`, child = index % 2 ? 'test-a' : 'test-b'
      const name = index === 0 ? "scale %_ O'Reilly Case" : `scale 商品 ${index}`
      const price = 1000 + index % 4 * 100, stock = index === 3 ? 0 : 2
      products.push({ id, name, category: '测试类别', price, child, stock })
      f.db.run('INSERT INTO products VALUES(?,?,?,?,?)', id, name, '测试类别', '/assets/product.svg', '测试说明')
      f.db.run('INSERT INTO skus VALUES(?,?,?,?,?)', `${id}-a`, id, '有货规格', price, stock)
      f.db.run('INSERT INTO skus VALUES(?,?,?,?,?)', `${id}-b`, id, '便宜但售罄', 1, 0)
      f.db.run('INSERT INTO product_categories VALUES(?,?)', id, child)
    }
  })
  const search = (payload: object) => f.app.inject({ method: 'POST', url: '/search/all', payload })
  return { ...f, products, search }
}

test('商品数据库分页在筛选和排序之后执行，保留父子分类、可售价格及稳定跨页结果', async () => {
  const f = await fixture()
  try {
    for (const sortField of ['price', 'publishTime', 'orderNum']) {
      for (const sortMethod of ['asc', 'desc']) {
        const expected = f.products.filter(p => p.stock > 0).sort((a, b) => {
          const id = Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))
          const primary = sortField === 'price' ? a.price - b.price : sortField === 'orderNum' ? 0 : id
          return (sortMethod === 'asc' ? primary : -primary) || id
        })
        const ids: string[] = []
        for (let page = 1; page <= 4; page++) {
          const response = await f.search({ keyword: 'scale', categoryId: 'test-root', sortField, sortMethod, page, pageSize: 10 })
          assert.equal(response.statusCode, 200)
          const result = response.json().result.pageData
          assert.equal(result.counts, 36); assert.equal(result.pages, 4)
          for (const item of result.items) {
            assert.equal(item.price, expected.find(p => p.id === item.id)!.price / 100)
            assert.equal(item.originalPrice, item.price)
            assert.equal(item.picture, 'http://fixture/assets/product.svg')
            ids.push(item.id)
          }
        }
        assert.deepEqual(ids, expected.map(p => p.id))
        assert.equal(new Set(ids).size, 36)
      }
    }
    const child = (await f.search({ categoryId: 'test-a', pageSize: 100 })).json().result.pageData
    assert.equal(child.counts, f.products.filter(p => p.child === 'test-a' && p.stock).length)
    assert.ok(child.items.every((p: { id: string }) => f.products.find(item => item.id === p.id)!.child === 'test-a'))
    for (const keyword of ['%_', "O'Reilly", 'Case', '测试类别']) {
      const result = (await f.search({ keyword, pageSize: 100 })).json().result.pageData
      assert.equal(result.counts, keyword === '测试类别' ? 36 : 1)
    }
    assert.equal((await f.search({ keyword: 'case' })).json().result.pageData.counts, 0)
    assert.equal((await f.search({ keyword: "' OR 1=1 --" })).json().result.pageData.counts, 0)
  } finally { await f.app.close() }
})

test('千件商品查询一页只读入当前页，搜索、猜你喜欢和热门接口保留分页结构', async () => {
  const f = await fixture(1001)
  try {
    let readRows = 0
    const all = f.db.all.bind(f.db)
    f.db.all = (<T>(sql: string, ...params: Parameters<typeof f.db.all>[1][]) => {
      const rows = all<T>(sql, ...params)
      if (sql.includes('FROM products')) readRows += rows.length
      return rows
    }) as typeof f.db.all
    const search = await f.search({ keyword: 'scale', page: 3, pageSize: 20 })
    assert.equal(search.statusCode, 200)
    const result = search.json().result.pageData
    assert.equal(result.counts, 1000); assert.equal(result.pages, 50); assert.equal(result.items.length, 20)
    console.log(`CATALOG_PAGE total=${result.counts} returned=${result.items.length} materialized=${readRows}`)
    assert.equal(readRows, 20)
    for (const path of ['/home/goods/guessLike', '/hot/1']) {
      readRows = 0
      const response = await f.app.inject(`${path}?page=3&pageSize=20`)
      assert.equal(response.statusCode, 200)
      const data = path.includes('/hot') ? response.json().result.subTypes[0].goodsItems : response.json().result
      assert.equal(data.counts, 1004); assert.equal(data.items.length, 20); assert.equal(data.page, 3)
      assert.equal(readRows, 20)
    }
  } finally { await f.app.close() }
})

test('商品分页先验证参数，未知分类、空结果及超大页码保持明确结果', async () => {
  const f = await fixture()
  try {
    let reads = 0
    const all = f.db.all.bind(f.db)
    f.db.all = (<T>(sql: string, ...params: Parameters<typeof f.db.all>[1][]) => {
      if (sql.includes('FROM products')) reads++
      return all<T>(sql, ...params)
    }) as typeof f.db.all
    for (const payload of [{ page: 0 }, { pageSize: 101 }, { sortField: 'price;DROP TABLE products' }, { sortMethod: 'invalid' }, { categoryId: 'missing' }]) {
      assert.equal((await f.search(payload)).statusCode, 400)
    }
    for (const path of ['/home/goods/guessLike', '/hot/1']) assert.equal((await f.app.inject(`${path}?page=0`)).statusCode, 400)
    assert.equal(reads, 0)
    for (const payload of [{ keyword: 'missing' }, { keyword: 'scale', page: Number.MAX_SAFE_INTEGER }]) {
      const response = await f.search(payload)
      assert.equal(response.statusCode, 200); assert.deepEqual(response.json().result.pageData.items, [])
    }
  } finally { await f.app.close() }
})

test('商品详情价格与列表一致，最低价规格售罄时展示仍可购买的规格价格', async () => {
  const f = await fixture(1)
  try {
    const detail = (await f.app.inject('/goods?id=test-0000')).json()
    assert.equal(detail.price, 10)
    assert.equal(detail.skus.find((s: { id: string }) => s.id === 'test-0000-b').inventory, 0)
    f.db.run('UPDATE skus SET stock=0 WHERE product_id=?', 'test-0000')
    assert.equal((await f.search({ keyword: 'scale' })).json().result.pageData.counts, 0)
    assert.equal((await f.app.inject('/goods?id=test-0000')).json().inventory, 0)
  } finally { await f.app.close() }
})
