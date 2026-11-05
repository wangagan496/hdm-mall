import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.ts'

const credential = 'fixture-test-credential-32-characters'
const options = { databasePath: ':memory:', uploadsPath: './data/test-uploads',
  publicUrl: 'http://127.0.0.1:3000', mockPayments: true, testMode: true, testFixtures: { credential } }

test('夹具默认不存在，生产配置和非测试模式拒绝开启', async () => {
  const ordinary = await buildApp({ ...options, testFixtures: undefined })
  try { assert.equal((await ordinary.app.inject({ method: 'POST', url: '/__test/fixtures/products', payload: {} })).statusCode, 404) }
  finally { await ordinary.app.close() }
  await assert.rejects(buildApp({ ...options, production: true, mockPayments: false,
    publicUrl: 'https://mall.example.com', corsOrigins: ['https://mall.example.com'] }), /正式环境禁止启用测试夹具/)
  await assert.rejects(buildApp({ ...options, testMode: false }), /测试模式/)
  await assert.rejects(buildApp({ ...options, testFixtures: { credential: 'short' } }), /测试凭证/)
})

test('独立夹具凭证创建完整数据，买家令牌不可使用且各实例隔离', async () => {
  const f = await buildApp({ ...options, clock: { now: () => 123456 } })
  const other = await buildApp(options)
  try {
    const call = (kind: string, payload: Record<string, unknown>, key = credential) => f.app.inject({
      method: 'POST', url: '/__test/fixtures/' + kind, headers: { 'x-test-fixture-key': key }, payload })
    const response = await call('accounts', { account: 'fixture_buyer', password: 'password-123', role: 'buyer' })
    assert.equal(response.statusCode, 200, response.body)
    const buyer = response.json().result
    const merchant = (await call('accounts', { account: 'fixture_merchant', password: 'password-123', role: 'merchant' })).json().result
    const friend = (await call('accounts', { account: 'fixture_friend', password: 'password-123' })).json().result
    assert.equal(f.accounts.authenticate('Bearer ' + merchant.token).role, 'merchant')
    for (const kind of ['accounts', 'addresses', 'products', 'relations']) {
      assert.equal((await call(kind, {}, buyer.token)).statusCode, 403)
      assert.equal((await f.app.inject({ method: 'POST', url: '/__test/fixtures/' + kind,
        headers: { authorization: 'Bearer ' + buyer.token }, payload: {} })).statusCode, 403)
    }
    assert.equal((await call('addresses', { userId: buyer.id, receiver: '买家', contact: '13800138000',
      address: '测试地址', isDefault: 0 })).statusCode, 200)
    assert.equal((await call('relations', { ownerId: buyer.id, friendId: friend.id })).statusCode, 200)
    const product = (await call('products', { name: '独立商品', category: '夹具分类',
      skus: [{ spec: '小', priceCents: 2371, stock: 7 }, { spec: '大', priceCents: 2843, stock: 3 }] })).json().result
    assert.equal(f.catalog.sku(product.skus[0].id).price, 2371)
    assert.equal(f.catalog.detail(product.id).inventory, 10)
    assert.equal(f.db.one<{ created: number }>('SELECT created FROM inventory_movements LIMIT 1')!.created, 123456)
    assert.equal(f.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM products')!.count, 1)
    assert.equal(other.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM products')!.count, 0)
    assert.equal(f.db.one<{ created: number }>('SELECT created FROM relations')!.created, 123456)
    assert.throws(() => f.fixtures!.createProduct(buyer.token, { name: '越权', skus: [{ spec: '默认', priceCents: 100, stock: 1 }] }), /测试凭证/)
    const direct = f.fixtures!.createProduct(credential, { name: '直接夹具', skus: [{ spec: '默认', priceCents: 3457, stock: 4 }] })
    assert.equal(f.catalog.sku(direct.skus[0]!.id).stock, 4)
    assert.equal((await call('products', { name: '非法库存', skus: [{ spec: '默认', priceCents: 100, stock: -1 }] })).statusCode, 400)
    assert.equal(f.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM products')!.count, 2)
    const before = f.db.all('SELECT * FROM inventory_movements ORDER BY id')
    assert.throws(() => f.fixtures!.createProduct(credential, { id: 'rollback-product', name: '整笔回滚',
      skus: [{ id: 'collision', spec: '一', priceCents: 111, stock: 1 },
        { id: 'collision', spec: '二', priceCents: 222, stock: 2 }] }), /UNIQUE/)
    assert.equal(f.db.one('SELECT id FROM products WHERE id=?', 'rollback-product'), undefined)
    assert.deepEqual(f.db.all('SELECT * FROM inventory_movements ORDER BY id'), before)
  } finally { await f.app.close(); await other.app.close() }
})
