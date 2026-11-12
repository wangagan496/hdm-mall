import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildTestApp } from './helpers/fixtures.ts'
import { Catalog } from '../src/catalog.ts'
import { Orders } from '../src/orders.ts'
import { Database } from '../src/database.ts'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const priceCents = 2371, initialStock = 23
const productInput = { id: 'optimization-product', name: '独立测试商品', category: '测试分类',
  skus: [{ id: 'optimization-product-a', spec: '标准', priceCents, stock: initialStock },
    { id: 'optimization-product-b', spec: '加大', priceCents: priceCents + 517, stock: 10 }] }

async function fixture() {
  const f = await buildTestApp({ databasePath: ':memory:', publicUrl: 'http://127.0.0.1:3000', mockPayments: true, uploadsPath: './data/test-uploads' })
  f.testData.product(productInput)
  f.testData.product({ id: 'optimization-bag', name: '测试双肩包', category: '测试箱包',
    skus: [{ id: 'optimization-bag-a', spec: '标准', priceCents: 9123, stock: initialStock }] })
  f.testData.product({ id: 'optimization-storage', name: '测试收纳包', category: '测试箱包',
    skus: [{ id: 'optimization-storage-a', spec: '标准', priceCents: 3147, stock: initialStock }] })
  f.accounts.register('optimizer', 'test-password-123')
  const login = f.accounts.login('optimizer', 'test-password-123')
  const user = f.accounts.authenticate(`Bearer ${login.token}`)
  const address = f.accounts.saveAddress(user, { receiver: '测试', contact: '13800000000', address: '测试地址' })
  const catalog = new Catalog(f.db, 'http://127.0.0.1:3000')
  const orders = new Orders(f.db, f.accounts, catalog, true)
  const create = () => orders.create(user, { requestKey: randomUUID(), expectedAmountCents: priceCents, addressId: address.id, goods: [{ skuId: 'optimization-product-a', count: 1 }] }).id
  return { ...f, catalog, orders, login, user, create }
}
test('资料读写返回本次凭证和完整资料，不更新会话期限，地区可回显', async () => {
  const f = await fixture()
  try {
    const sessions = f.db.all('SELECT * FROM sessions')
    const response = await f.app.inject({ method: 'PUT', url: '/member/profile', headers: { authorization: `Bearer ${f.login.token}` }, payload: {
      nickname: '  最新昵称  ', gender: '未知', birthday: '2000-01-02', provinceCode: '11', cityCode: '1101', countyCode: '110101', profession: '工程师', fullLocation: '北京市 北京市 东城区'
    } })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().result.token, f.login.token)
    assert.equal(response.json().result.id, f.user.id)
    assert.equal(response.json().result.nickname, '最新昵称')
    const loaded = await f.app.inject({ method: 'GET', url: '/member/profile', headers: { authorization: `Bearer ${f.login.token}` } })
    assert.equal(loaded.json().result.fullLocation, '北京市 北京市 东城区')
    assert.deepEqual(f.db.all('SELECT * FROM sessions'), sessions)
    assert.equal((await f.app.inject({ method: 'GET', url: '/member/profile' })).statusCode, 401)
  } finally { await f.app.close() }
})
test('全部分页包含已取消订单，页数一致，只整理当前页且可明确查询取消状态', async () => {
  const f = await fixture()
  try {
    const ids = Array.from({ length: 8 }, () => f.create())
    ids.slice(0, 3).forEach(id => f.orders.cancel(f.user, id))
    const queries: string[] = []
    const originalAll = f.db.all.bind(f.db)
    f.db.all = (<T>(sql: string, ...params: Parameters<typeof f.db.all>[1][]) => { queries.push(sql); return originalAll<T>(sql, ...params) }) as typeof f.db.all
    const first = f.orders.listPage(f.user, 0, 1, 2)
    assert.equal(first.counts, 8); assert.equal(first.pages, 4); assert.equal(first.items.length, 2)
    assert.equal(queries.filter(query => query.includes('FROM order_items')).length, 2)
    assert.ok(queries.some(query => query.includes('LIMIT ? OFFSET ?')))
    const all = [first, f.orders.listPage(f.user, 0, 2, 2), f.orders.listPage(f.user, 0, 3, 2),
      f.orders.listPage(f.user, 0, 4, 2)].flatMap(page => page.items)
    assert.equal(new Set(all.map(order => order.id)).size, 8)
    assert.equal(all.filter(order => order.orderState === 6).length, 3)
    assert.equal(f.orders.listPage(f.user, 0, 5, 2).items.length, 0)
    assert.equal(f.orders.listPage(f.user, 6, 1, 10).counts, 3)
    const cancelled = await f.orders.cancel(f.user, ids[0]!)
    assert.equal(cancelled.orderState, 6); assert.ok(cancelled.skus.length)
  } finally { await f.app.close() }
})
test('订单、明细或购物车步骤失败时库存和订单一起回滚', async () => {
  const f = await fixture()
  try {
    for (const failAt of ['INSERT INTO orders', 'INSERT INTO order_items', 'DELETE FROM carts']) {
      const beforeStock = f.catalog.sku('optimization-product-a').stock
      const beforeCount = f.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM orders')!.count
      const beforeLedger = f.db.all('SELECT * FROM inventory_movements ORDER BY id')
      const original = f.db.run.bind(f.db)
      f.db.run = (sql, ...params) => { if (sql.startsWith(failAt)) throw new Error('injected write failure'); return original(sql, ...params) }
      assert.throws(() => f.create(), /injected write failure/)
      f.db.run = original
      assert.equal(f.catalog.sku('optimization-product-a').stock, beforeStock)
      assert.equal(f.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM orders')!.count, beforeCount)
      assert.deepEqual(f.db.all('SELECT * FROM inventory_movements ORDER BY id'), beforeLedger)
    }
  } finally { await f.app.close() }
})
test('分类持久化编号，父子筛选、关键词和全量排序在分页前生效', async () => {
  const f = await fixture()
  try {
    const bag = f.catalog.categories().find(category => category.name === '测试箱包')!
    const storage = bag.children.find(category => category.name === '测试收纳包')!
    assert.equal(f.catalog.list('', bag.id).length, 2)
    assert.deepEqual(f.catalog.list('', storage.id).map(item => item.id), ['optimization-storage'])
    assert.equal(f.catalog.list('不存在的词', storage.id).length, 0)
    f.db.run('UPDATE categories SET name=? WHERE id=?', '旅行箱包', bag.id)
    f.catalog.seed()
    assert.equal(f.catalog.categories().find(category => category.name === '旅行箱包')!.id, bag.id)
    const result = await f.app.inject({ method: 'POST', url: '/search/all', payload: { categoryId: bag.id, sortField: 'price', sortMethod: 'asc', page: 1, pageSize: 1 } })
    assert.equal(result.statusCode, 200)
    assert.equal(result.json().result.pageData.items[0].id, 'optimization-storage')
    assert.equal(result.json().result.pageData.counts, 2)
    f.db.run('UPDATE skus SET stock=0 WHERE product_id=?', 'optimization-storage')
    assert.equal(f.catalog.categories().find(category => category.id === bag.id)!.children.find(category => category.id === storage.id)!.goods.length, 0)
  } finally { await f.app.close() }
})
test('商品详情成功直接返回资料，参数和不存在错误仍保留错误约定', async () => {
  const f = await fixture()
  try {
    const response = await f.app.inject({ method: 'GET', url: '/goods?id=optimization-product' })
    assert.equal(response.json().id, 'optimization-product'); assert.equal(response.json().result, undefined)
    assert.equal((await f.app.inject({ method: 'GET', url: '/goods' })).statusCode, 400)
    assert.equal((await f.app.inject({ method: 'GET', url: '/goods?id=missing' })).statusCode, 404)
    assert.equal((await f.app.inject({ method: 'GET', url: '/health' })).json().code, '1')
  } finally { await f.app.close() }
})

test('订单读请求合并过期探测，首次读仍处理过期单且写请求强制检查', async () => {
  const f = await fixture()
  try {
    const expiredId = f.create()
    f.db.run('UPDATE orders SET expires=0 WHERE id=?', expiredId)
    const beforeStock = f.catalog.sku('optimization-product-a').stock
    const expirationProbe = 'SELECT id FROM orders WHERE state=1 AND expires<=? LIMIT 1'
    let probes = 0
    const originalOne = f.db.one.bind(f.db)
    f.db.one = (<T>(sql: string, ...params: Parameters<typeof f.db.one>[1][]) => {
      if (sql === expirationProbe) probes++
      return originalOne<T>(sql, ...params)
    }) as typeof f.db.one

    const firstRead = f.orders.list(f.user)
    assert.equal(firstRead.length, 1)
    assert.equal(firstRead[0]!.id, expiredId)
    assert.equal(firstRead[0]!.orderState, 6)
    assert.equal(f.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', expiredId)!.state, 6)
    assert.equal(f.catalog.sku('optimization-product-a').stock, beforeStock + 1)
    assert.equal(probes, 1)

    f.orders.list(f.user)
    assert.equal(probes, 1)

    const writeCheckedId = f.create()
    f.db.run('UPDATE orders SET expires=0 WHERE id=?', writeCheckedId)
    const beforeWrite = probes
    assert.throws(() => f.orders.invitePayer(f.user, writeCheckedId, null), /只能为待付款订单选择付款方式/)
    assert.equal(probes, beforeWrite + 1)
    assert.equal(f.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', writeCheckedId)!.state, 6)
  } finally { await f.app.close() }
})

test('商品和购物车 GET 首次读取沿用合并过期检查', async () => {
  const f = await fixture()
  try {
    const id = f.create()
    f.db.run('UPDATE orders SET expires=0 WHERE id=?', id)
    const beforeStock = f.catalog.sku('optimization-product-a').stock
    const goods = await f.app.inject({ method: 'GET', url: '/goods?id=optimization-product' })
    assert.equal(goods.statusCode, 200)
    assert.equal(f.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', id)!.state, 6)
    assert.equal(f.catalog.sku('optimization-product-a').stock, beforeStock + 1)
    const cart = await f.app.inject({ method: 'GET', url: '/member/cart', headers: { authorization: `Bearer ${f.login.token}` } })
    assert.equal(cart.statusCode, 200)
    assert.equal(f.db.all("SELECT id FROM inventory_movements WHERE order_id=? AND kind='expire'", id).length, 1)
  } finally { await f.app.close() }
})

test('购物车一次 JOIN 读取商品资料，不按商品数量触发规格查询', async () => {
  const f = await fixture()
  try {
    f.catalog.addCart(f.user, 'optimization-product-a', 1, randomUUID())
    f.catalog.addCart(f.user, 'optimization-bag-a', 1, randomUUID())
    f.catalog.addCart(f.user, 'optimization-storage-a', 1, randomUUID())
    const oneQueries: string[] = []
    const allQueries: string[] = []
    const originalOne = f.db.one.bind(f.db)
    const originalAll = f.db.all.bind(f.db)
    f.db.one = (<T>(sql: string, ...params: Parameters<typeof f.db.one>[1][]) => { oneQueries.push(sql); return originalOne<T>(sql, ...params) }) as typeof f.db.one
    f.db.all = (<T>(sql: string, ...params: Parameters<typeof f.db.all>[1][]) => { allQueries.push(sql); return originalAll<T>(sql, ...params) }) as typeof f.db.all
    const items = f.catalog.cart(f.user)
    assert.equal(items.length, 3)
    assert.deepEqual(items.map(item => item.skuId), ['optimization-product-a', 'optimization-bag-a', 'optimization-storage-a'])
    assert.equal(oneQueries.filter(sql => sql.includes('FROM skus s JOIN products p')).length, 0)
    assert.equal(allQueries.filter(sql => sql.includes('FROM carts c JOIN skus s')).length, 1)
  } finally { await f.app.close() }
})

test('购物车角标只读取数量汇总，包含未勾选和售罄商品并隔离账号', async () => {
  const f = await fixture()
  try {
    f.accounts.register('cart_other', 'test-password-123')
    const otherLogin = f.accounts.login('cart_other', 'test-password-123')
    const other = f.accounts.authenticate(`Bearer ${otherLogin.token}`)
    f.catalog.addCart(f.user, 'optimization-product-a', 2, randomUUID())
    f.catalog.addCart(f.user, 'optimization-product-b', 3, randomUUID())
    f.catalog.addCart(other, 'optimization-product-a', 7, randomUUID())
    f.db.run('UPDATE carts SET selected=0 WHERE user_id=?', f.user.id)
    f.db.run('UPDATE skus SET stock=0 WHERE id=?', 'optimization-product-a')
    const originalAll = f.db.all.bind(f.db)
    let materializedRows = 0
    f.db.all = (<T>(sql: string, ...params: Parameters<typeof f.db.all>[1][]) => {
      const rows = originalAll<T>(sql, ...params)
      materializedRows += rows.length
      return rows
    }) as typeof f.db.all
    const count = async (token?: string) => f.app.inject({ method: 'GET', url: '/member/cart/count',
      headers: token ? { authorization: `Bearer ${token}` } : {} })
    const own = await count(f.login.token)
    assert.equal(own.statusCode, 200)
    assert.deepEqual(own.json(), { code: '1', result: { count: 5 } })
    assert.equal((await count(otherLogin.token)).json().result.count, 7)
    assert.equal((await count()).statusCode, 401)
    f.db.run('DELETE FROM carts WHERE user_id=?', f.user.id)
    assert.equal((await count(f.login.token)).json().result.count, 0)
    assert.equal(materializedRows, 0, '角标不应读取购物车或商品明细行')
  } finally { await f.app.close() }
})

test('购物车修改单项只读取该项，保留完整回应、库存校验和账号隔离', async () => {
  const f = await fixture()
  try {
    f.catalog.addCart(f.user, 'optimization-product-a', 1, randomUUID())
    f.catalog.addCart(f.user, 'optimization-bag-a', 2, randomUUID())
    f.catalog.addCart(f.user, 'optimization-storage-a', 3, randomUUID())
    const expected = { ...f.catalog.cart(f.user)[1], count: 4, selected: false }
    f.accounts.register('cart_update_other', 'test-password-123')
    const otherLogin = f.accounts.login('cart_update_other', 'test-password-123')
    const other = f.accounts.authenticate(`Bearer ${otherLogin.token}`)
    f.catalog.addCart(other, 'optimization-bag-a', 7, randomUUID())
    const originalAll = f.db.all.bind(f.db)
    let rowsRead = 0
    f.db.all = (<T>(sql: string, ...params: Parameters<typeof f.db.all>[1][]) => {
      const rows = originalAll<T>(sql, ...params)
      rowsRead += rows.length
      return rows
    }) as typeof f.db.all
    const update = (skuId: string, payload: object, token = f.login.token) => f.app.inject({
      method: 'PUT', url: `/member/cart/${skuId}`, headers: { authorization: `Bearer ${token}` }, payload })
    const result = await update('optimization-bag-a', { count: 4, selected: false })
    assert.equal(result.statusCode, 200)
    assert.deepEqual(result.json().result, expected)
    assert.equal(rowsRead, 1, '修改一个商品不应读取其他购物车条目')
    assert.equal((await update('optimization-bag-a', { selected: true })).json().result.count, 4)
    assert.equal((await update('optimization-bag-a', { count: initialStock + 1 })).statusCode, 409)
    assert.equal((await update('optimization-product-a', { count: 1 }, otherLogin.token)).statusCode, 404)
    assert.equal(f.db.one<{ count: number }>('SELECT count FROM carts WHERE user_id=? AND sku_id=?', other.id, 'optimization-bag-a')!.count, 7)
    assert.equal(f.db.one<{ count: number }>('SELECT count FROM carts WHERE user_id=? AND sku_id=?', f.user.id, 'optimization-bag-a')!.count, 4)
  } finally { await f.app.close() }
})

test('购物车全选只修改本人状态，不读取商品明细且保留 null 回应', async () => {
  const f = await fixture()
  try {
    f.catalog.addCart(f.user, 'optimization-product-a', 2, randomUUID())
    f.catalog.addCart(f.user, 'optimization-bag-a', 3, randomUUID())
    f.accounts.register('cart_select_other', 'test-password-123')
    const otherLogin = f.accounts.login('cart_select_other', 'test-password-123')
    const other = f.accounts.authenticate(`Bearer ${otherLogin.token}`)
    f.catalog.addCart(other, 'optimization-product-a', 7, randomUUID())
    const originalAll = f.db.all.bind(f.db)
    let reads = 0
    f.db.all = (<T>(sql: string, ...params: Parameters<typeof f.db.all>[1][]) => {
      reads++
      return originalAll<T>(sql, ...params)
    }) as typeof f.db.all
    for (const selected of [false, true]) {
      const response = await f.app.inject({ method: 'PUT', url: '/member/cart/selected',
        headers: { authorization: `Bearer ${f.login.token}` }, payload: { selected } })
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json(), { code: '1', result: null })
      assert.equal(f.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM carts WHERE user_id=? AND selected=?', f.user.id, Number(selected))!.count, 2)
      assert.equal(f.db.one<{ selected: number }>('SELECT selected FROM carts WHERE user_id=? AND sku_id=?', other.id, 'optimization-product-a')!.selected, 1)
    }
    assert.equal(reads, 0, '全选不应为了 null 回应加载购物车')
  } finally { await f.app.close() }
})

test('旧版数据库迁移保留商品，分类编号重启后保持稳定', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hdm-migration-'))
  const path = join(directory, 'legacy.sqlite')
  const legacy = new DatabaseSync(path)
  legacy.exec(readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'))
  legacy.prepare('INSERT INTO products VALUES(?,?,?,?,?)').run('legacy-product', '原有商品', '原有分类', '/assets/product.svg', '保留说明')
  legacy.prepare('INSERT INTO skus VALUES(?,?,?,?,?)').run('legacy-sku', 'legacy-product', '原有规格', 1234, 7)
  legacy.close()
  let migrated: Database | undefined
  try {
    migrated = new Database(path)
    const catalog = new Catalog(migrated, 'http://fixture')
    catalog.seed()
    const category = catalog.categories().find(row => row.name === '原有分类')!
    const child = category.children[0]!
    assert.equal(catalog.sku('legacy-sku').stock, 7)
    assert.equal(catalog.list('', child.id)[0]!.id, 'legacy-product')
    migrated.close(); migrated = new Database(path)
    const reloaded = new Catalog(migrated, 'http://fixture'); reloaded.seed()
    assert.equal(reloaded.categories().find(row => row.name === '原有分类')!.id, category.id)
    assert.equal(reloaded.categories().find(row => row.id === category.id)!.children[0]!.id, child.id)
    assert.equal(migrated.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 17)
  } finally {
    migrated?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
