import { removeAfterSaleSchema } from './helpers/legacy-v11.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildTestApp } from './helpers/fixtures.ts'
import { Database } from '../src/database.ts'
import { Catalog } from '../src/catalog.ts'
import { Orders } from '../src/orders.ts'
import { createBackup, restoreBackup, verifyBackup } from '../src/backup.ts'

const priceCents = 2371, initialStock = 23
const productInput = { id: 'inventory-product', name: '独立测试商品', category: '测试分类',
  skus: [{ id: 'inventory-product-a', spec: '标准', priceCents, stock: initialStock },
    { id: 'inventory-product-b', spec: '加大', priceCents: priceCents + 517, stock: 10 }] }

async function fixture(databasePath = ':memory:') {
  const ctx = await buildTestApp({ databasePath, uploadsPath: './unused', publicUrl: 'http://127.0.0.1:3000', mockPayments: true })
  ctx.testData.product(productInput)
  ctx.accounts.register('stock_buyer', 'test-password-123')
  ctx.accounts.register('stock_merchant', 'test-password-123', 'merchant')
  const buyer = ctx.accounts.login('stock_buyer', 'test-password-123')
  const merchant = ctx.accounts.login('stock_merchant', 'test-password-123')
  const user = ctx.accounts.authenticate(`Bearer ${buyer.token}`)
  const address = ctx.accounts.saveAddress(user, { receiver: '库存测试', contact: '13800000000', address: '测试地址' })
  const catalog = new Catalog(ctx.db, 'http://127.0.0.1:3000')
  const orders = new Orders(ctx.db, ctx.accounts, catalog, true)
  const create = (count = 1, requestKey = randomUUID()) => orders.create(user, {
    addressId: address.id, requestKey, expectedAmountCents: priceCents * count - (priceCents * count >= 9900 ? 1000 : 0), goods: [{ skuId: 'inventory-product-a', count }]
  }).id
  const ledger = () => ctx.db.all('SELECT * FROM inventory_movements ORDER BY id')
  const reconcile = () => ctx.db.all(`SELECT s.id FROM skus s LEFT JOIN inventory_movements m ON m.sku_id=s.id
    GROUP BY s.id HAVING s.stock<>COALESCE(SUM(m.delta),0)`)
  return { ...ctx, buyer, merchant, user, address, catalog, orders, create, ledger, reconcile }
}

test('初始化与重复下单取消都只记一次流水，数量余额操作者可追溯', async () => {
  const f = await fixture()
  try {
    assert.equal(f.ledger().length, productInput.skus.length)
    f.catalog.seed()
    const seeded = f.ledger().length
    assert.equal(seeded, productInput.skus.length + 8)
    f.catalog.seed()
    assert.equal(f.ledger().length, seeded)
    const key = randomUUID(), id = f.create(2, key)
    assert.equal(f.create(2, key), id)
    assert.throws(() => f.create(3, key), /同一次下单/)
    const reservation = f.db.one<{ delta: number; balance: number; actor_id: string; business_key: string }>(
      'SELECT * FROM inventory_movements WHERE order_id=?', id)!
    assert.equal(reservation.delta, -2); assert.equal(reservation.balance, initialStock - 2)
    assert.equal(reservation.actor_id, f.user.id)
    assert.equal(reservation.business_key, `reserve:${id}:inventory-product-a`)
    f.orders.cancel(f.user, id); f.orders.cancel(f.user, id)
    const rows = f.db.all<{ kind: string; delta: number; balance: number; actor_id: string }>(
      'SELECT * FROM inventory_movements WHERE order_id=? ORDER BY id', id)
    assert.deepEqual(rows.map(row => [row.kind, row.delta, row.balance]), [['reserve', -2, initialStock - 2], ['cancel', 2, initialStock]])
    assert.equal(rows[1]!.actor_id, f.user.id)
    assert.deepEqual(f.reconcile(), [])
  } finally { await f.app.close() }
})

test('超时归还标明系统操作，重复扫描和已付款订单不重复增加库存', async () => {
  const f = await fixture()
  try {
    const id = f.create(2)
    f.db.run('UPDATE orders SET expires=0 WHERE id=?', id)
    f.orders.expire(); f.orders.expire(); f.orders.cancel(f.user, id)
    const released = f.db.all<{ kind: string; actor_id: string | null; delta: number }>(
      "SELECT * FROM inventory_movements WHERE order_id=? AND kind<>'reserve'", id)
    assert.equal(released.length, 1)
    assert.equal(released[0]!.kind, 'expire'); assert.equal(released[0]!.actor_id, null); assert.equal(released[0]!.delta, 2)
    const paid = f.create()
    f.orders.pay(f.user, paid, priceCents)
    f.db.run('UPDATE orders SET expires=0 WHERE id=?', paid)
    f.orders.expire()
    assert.throws(() => f.orders.cancel(f.user, paid), /只有未付款/)
    assert.equal(f.db.all('SELECT * FROM inventory_movements WHERE order_id=?', paid).length, 1)
    assert.deepEqual(f.reconcile(), [])
  } finally { await f.app.close() }
})

test('流水写失败时下单及归还整笔回滚，已写的其他规格流水也撤销', async () => {
  const f = await fixture()
  try {
    f.catalog.addCart(f.user, 'inventory-product-a', 1, randomUUID())
    const before = f.ledger(), original = f.db.run.bind(f.db)
    let writes = 0
    f.db.run = (sql, ...params) => {
      if (sql.startsWith('INSERT INTO inventory_movements') && ++writes === 2) throw new Error('ledger write failure')
      return original(sql, ...params)
    }
    assert.throws(() => f.orders.create(f.user, { addressId: f.address.id, requestKey: randomUUID(),
      expectedAmountCents: priceCents * 2 + 517, goods: [{ skuId: 'inventory-product-a', count: 1 }, { skuId: 'inventory-product-b', count: 1 }] }), /ledger write failure/)
    f.db.run = original
    assert.deepEqual(f.ledger(), before)
    assert.equal(f.db.all('SELECT * FROM orders').length, 0)
    assert.equal(f.catalog.cart(f.user).length, 1)
    assert.deepEqual(f.reconcile(), [])
    const id = f.create(2), reserved = f.ledger()
    f.db.run = (sql, ...params) => {
      if (sql.startsWith('INSERT INTO inventory_movements')) throw new Error('release ledger failure')
      return original(sql, ...params)
    }
    assert.throws(() => f.orders.cancel(f.user, id), /release ledger failure/)
    f.db.run = original
    assert.equal(f.orders.detail(f.user, id).orderState, 1)
    assert.deepEqual(f.ledger(), reserved)
    assert.equal(f.catalog.sku('inventory-product-a').stock, initialStock - 2)
    f.orders.cancel(f.user, id)
    assert.deepEqual(f.reconcile(), [])
  } finally { await f.app.close() }
})

test('同批到期处理失败全部回滚，重新处理只记一次归还', async () => {
  const f = await fixture()
  try {
    f.create(); f.create()
    f.db.run('UPDATE orders SET expires=0')
    const before = f.ledger(), original = f.db.run.bind(f.db)
    let writes = 0
    f.db.run = (sql, ...params) => {
      if (sql.startsWith('INSERT INTO inventory_movements') && ++writes === 2) throw new Error('expiry failure')
      return original(sql, ...params)
    }
    assert.throws(() => f.orders.expire(), /expiry failure/)
    f.db.run = original
    assert.deepEqual(f.ledger(), before)
    assert.equal(f.catalog.sku('inventory-product-a').stock, initialStock - 2)
    assert.equal(f.db.all('SELECT id FROM orders WHERE state=1').length, 2)
    f.orders.expire(); f.orders.expire()
    assert.equal(f.db.all("SELECT id FROM inventory_movements WHERE kind='expire'").length, 2)
    assert.deepEqual(f.reconcile(), [])
  } finally { await f.app.close() }
})

test('商家按规格分页核对流水，买家和匿名请求不能访问，手工改库存会显示差异', async () => {
  const f = await fixture()
  try {
    const id = f.create(); f.orders.cancel(f.user, id)
    const auth = { authorization: `Bearer ${f.merchant.token}` }
    for (const url of ['/merchant/inventory', '/merchant/inventory/inventory-product-a/movements']) {
      assert.equal((await f.app.inject({ url })).statusCode, 401)
      assert.equal((await f.app.inject({ url, headers: { authorization: `Bearer ${f.buyer.token}` } })).statusCode, 403)
    }
    const page = await f.app.inject({ url: '/merchant/inventory/inventory-product-a/movements?pageSize=2', headers: auth })
    assert.equal(page.statusCode, 200)
    assert.equal(page.json().result.counts, 3)
    assert.deepEqual(page.json().result.items.map((item: { kind: string }) => item.kind), ['cancel', 'reserve'])
    const next = await f.app.inject({ url: '/merchant/inventory/inventory-product-a/movements?pageSize=2&page=2', headers: auth })
    assert.equal(next.json().result.items[0].kind, 'opening')
    assert.equal((await f.app.inject({ url: '/merchant/inventory/missing/movements', headers: auth })).statusCode, 404)
    assert.equal((await f.app.inject({ url: '/merchant/inventory?pageSize=101', headers: auth })).statusCode, 400)
    const clean = await f.app.inject({ url: '/merchant/inventory?skuId=inventory-product-a', headers: auth })
    assert.equal(clean.json().result.counts, 1)
    assert.equal(clean.json().result.items[0].difference, 0)
    f.db.run('UPDATE skus SET stock=? WHERE id=?', initialStock - 1, 'inventory-product-a')
    const dirty = await f.app.inject({ url: '/merchant/inventory?skuId=inventory-product-a', headers: auth })
    assert.equal(dirty.json().result.items[0].recordedStock, initialStock)
    assert.equal(dirty.json().result.items[0].difference, -1)
  } finally { await f.app.close() }
})

test('重复请求幂等：最后一件连续下单只记成功订单，流水不可更新、删除或重复释放', async () => {
  const f = await fixture()
  try {
    f.create(initialStock - 1)
    const results = await Promise.all([1, 2].map(() => f.app.inject({ method: 'POST', url: '/member/order',
      headers: { authorization: `Bearer ${f.buyer.token}` }, payload: { addressId: f.address.id, requestKey: randomUUID(),
        expectedAmountCents: priceCents, goods: [{ skuId: 'inventory-product-a', count: 1 }] } })))
    assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409])
    assert.equal(f.db.all("SELECT id FROM inventory_movements WHERE kind='reserve'").length, 2)
    assert.deepEqual(f.reconcile(), [])
    const id = results.find(result => result.statusCode === 200)!.json().result.id
    f.orders.cancel(f.user, id)
    assert.throws(() => f.db.run('UPDATE inventory_movements SET delta=100 WHERE id=1'), /append-only/)
    assert.throws(() => f.db.run('DELETE FROM inventory_movements WHERE id=1'), /append-only/)
    assert.throws(() => f.db.run(`INSERT INTO inventory_movements(sku_id,order_id,kind,delta,balance,business_key,created)
      VALUES(?,?,'expire',1,2,'another-key',0)`, 'inventory-product-a', id), /UNIQUE/)
    assert.equal(f.catalog.sku('inventory-product-a').stock, 1)
    assert.deepEqual(f.reconcile(), [])
  } finally { await f.app.close() }
})

// 生成与上一版相同的 v2 结构及真实待付款订单，验证基线迁移而非重造历史。
async function legacyFixture(path: string) {
  const f = await fixture(path)
  const id = f.create(2)
  await f.app.close()
  const legacy = new DatabaseSync(path)
  try { removeAfterSaleSchema(legacy); legacy.exec(`DROP TRIGGER inventory_no_update; DROP TRIGGER inventory_no_delete; DROP TABLE inventory_movements;
    DROP TRIGGER product_revision_sku_update; DROP TRIGGER product_revision_sku_insert; DROP TRIGGER product_revision_fields; DROP INDEX product_enabled_spec; DROP TABLE product_changes; DROP TABLE product_images; ALTER TABLE skus DROP COLUMN enabled; ALTER TABLE products DROP COLUMN revision; ALTER TABLE products DROP COLUMN status; DROP TABLE cart_requests; DROP TABLE order_cancel_actions; DROP TABLE order_cancel_requests; DROP TABLE refund_retry_actions; DROP TABLE payment_review_resolutions; DROP TABLE payment_notices; DROP TABLE refunds; DROP TABLE payments; PRAGMA user_version=2;`) }
  finally { legacy.close() }
  return id
}

test('v2 备份仍可恢复并升级，历史待付款取消只记录真实归还，重启不重复基线', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-stock-migration-'))
  const path = join(root, 'live', 'mall.sqlite')
  let ctx: Awaited<ReturnType<typeof buildTestApp>> | undefined
  try {
    const id = await legacyFixture(path)
    const backup = await createBackup({ databasePath: path, uploadsPath: join(root, 'live', 'uploads'), destination: join(root, 'v2-backup') })
    assert.equal(backup.manifest.schemaVersion, 2)
    const restored = await restoreBackup({ backupPath: backup.root, destination: join(root, 'restored') })
    const options = { databasePath: join(restored.root, 'mall.sqlite'), uploadsPath: join(restored.root, 'uploads'), publicUrl: 'http://127.0.0.1:3000', mockPayments: true }
    ctx = await buildTestApp(options)
    assert.equal(ctx.db.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 19)
    assert.equal(ctx.db.all('SELECT * FROM inventory_movements').length, productInput.skus.length)
    assert.equal(ctx.db.one<{ delta: number }>('SELECT delta FROM inventory_movements WHERE sku_id=?', 'inventory-product-a')!.delta, initialStock - 2)
    const user = ctx.accounts.login('stock_buyer', 'test-password-123')
    const response = await ctx.app.inject({ method: 'PUT', url: `/member/order/${id}/cancel`, headers: { authorization: `Bearer ${user.token}` } })
    assert.equal(response.statusCode, 200)
    assert.equal(ctx.db.all('SELECT * FROM inventory_movements WHERE order_id=?', id).length, 1)
    assert.equal(ctx.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', 'inventory-product-a')!.stock, initialStock)
    const nextBackup = await createBackup({ databasePath: options.databasePath, uploadsPath: options.uploadsPath, destination: join(root, 'v3-backup') })
    assert.equal(nextBackup.manifest.schemaVersion, 19)
    assert.equal(nextBackup.counts.inventory_movements, productInput.skus.length + 1)
    await ctx.app.close(); ctx = undefined
    ctx = await buildTestApp(options)
    assert.equal(ctx.db.all('SELECT * FROM inventory_movements').length, productInput.skus.length + 1)
  } finally { await ctx?.app.close(); await rm(root, { recursive: true, force: true }) }
})

test('v3 迁移中途失败会回滚表与版本并关闭连接，修正冲突后可重新迁移', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-stock-rollback-'))
  const path = join(root, 'mall.sqlite')
  try {
    await legacyFixture(path)
    const conflict = new DatabaseSync(path)
    try { conflict.exec('CREATE TRIGGER inventory_no_update BEFORE UPDATE ON products BEGIN SELECT 1; END;') }
    finally { conflict.close() }
    assert.throws(() => new Database(path), /already exists/)
    const check = new DatabaseSync(path)
    try {
      assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 2)
      assert.equal(check.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='inventory_movements'").get()!.count, 0)
      assert.equal(check.prepare('SELECT stock FROM skus WHERE id=?').get('inventory-product-a')!.stock, initialStock - 2)
      check.exec('DROP TRIGGER inventory_no_update')
    } finally { check.close() }
    const migrated = new Database(path)
    try { assert.equal(migrated.all('SELECT * FROM inventory_movements').length, productInput.skus.length) }
    finally { migrated.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('库存流水不一致写入快照，未登记的不一致即使重填哈希也不能通过校验', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-stock-backup-'))
  const path = join(root, 'live', 'mall.sqlite')
  const f = await fixture(path)
  try {
    const options = { databasePath: path, uploadsPath: join(root, 'live', 'uploads') }
    const backup = await createBackup({ ...options, destination: join(root, 'valid') })
    f.db.run('UPDATE skus SET stock=? WHERE id=?', initialStock - 1, 'inventory-product-a')
    const inconsistent = await createBackup({ ...options, destination: join(root, 'invalid') })
    assert.deepEqual(inconsistent.manifest.issues, [{ type: 'inventory-mismatch', skuId: 'inventory-product-a' }])
    const snapshot = join(backup.root, 'mall.sqlite'), changed = new DatabaseSync(snapshot)
    try { changed.prepare('UPDATE skus SET stock=? WHERE id=?').run(initialStock - 1, 'inventory-product-a') } finally { changed.close() }
    const bytes = await readFile(snapshot)
    backup.manifest.files[0] = { path: 'mall.sqlite', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    await writeFile(join(backup.root, 'manifest.json'), JSON.stringify(backup.manifest))
    await assert.rejects(verifyBackup(backup.root), /库存与流水/)
    await assert.rejects(restoreBackup({ backupPath: backup.root, destination: join(root, 'restore') }), /库存与流水/)
  } finally { await f.app.close(); await rm(root, { recursive: true, force: true }) }
})
