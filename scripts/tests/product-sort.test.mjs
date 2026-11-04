import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../../server/src/app.ts'
import { execute, pageMethods, sourceOf } from './native-harness.mjs'

test('原生临时排序与数据库全量排序在大小写、标点及 Unicode 编号下完全一致', async () => {
  const f = await buildApp({ databasePath: ':memory:', publicUrl: 'http://fixture', mockPayments: true, uploadsPath: './unused' })
  try {
    const ids = ['a', 'A', 'a-', 'a_', 'a10', 'a2', 'é', '中', '\uE000', '\u{10000}', '😀', '😀a']
    const products = ids.map((id, i) => ({ id, name: '排序测试', price: i % 3 + 1, orderNum: 0 }))
    f.db.transaction(() => {
      for (const p of products) {
        f.db.run('INSERT INTO products VALUES(?,?,?,?,?)', p.id, p.name, '测试', '/assets/product.svg', '')
        f.db.run('INSERT INTO skus VALUES(?,?,?,?,?)', p.id + '-sku', p.id, '标准', p.price * 100, 1)
      }
    })
    const { compareGoodsIds } = execute(sourceOf('mixed-development-h5/features/home/src/main/ets/data/api/searchPresentation.ets'))
    class ListDataSource {
      items = []
      loadData(items) { this.items = items }
      totalCount() { return this.items.length }
      getData(i) { return this.items[i] }
    }
    const View = pageMethods('mixed-development-h5/features/home/src/main/ets/presentation/views/SearchResultView.ets', 'SearchResultView', {}, {
      ListDataSource, Scroller: class {}, compareGoodsIds,
    })
    const page = new View()
    page.restartSearch = () => {} // 保留真实临时排序，仅替换后续网络入口。
    for (const sortField of ['price', 'orderNum', 'publishTime']) {
      for (const sortMethod of ['asc', 'desc']) {
        page.lazyDataSource.loadData([...products].reverse())
        page.changeSort(sortField, sortMethod)
        const actual = []
        for (let current = 1; current <= 4; current++) {
          const response = await f.app.inject({ method: 'POST', url: '/search/all', payload: {
            keyword: '排序测试', sortField, sortMethod, page: current, pageSize: 3,
          } })
          assert.equal(response.statusCode, 200)
          actual.push(...response.json().result.pageData.items.map(p => p.id))
        }
        assert.deepEqual(Array.from(page.lazyDataSource.items, p => p.id), actual)
      }
    }
    assert.deepEqual([...ids].sort(compareGoodsIds), [...ids].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))))
    assert.equal(compareGoodsIds('a', 'a'), 0)
  } finally { await f.app.close() }
})
