import { removeAfterSaleSchema } from './helpers/legacy-v11.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Database } from '../src/database.ts'
import { buildTestApp } from './helpers/fixtures.ts'
import { createBackup, verifyBackup, restoreBackup } from '../src/backup.ts'

test('011: 空库建到 11，重复启动不丢加购回执', () => {
  const root = mkdtempSync(join(tmpdir(), 'cart-migrate-'))
  const path = join(root, 'mall.sqlite')
  try {
    const first = new Database(path)
    assert.equal(first.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 16)
    first.run("INSERT INTO users(id,account,password,nickname) VALUES('buyer','buyer','password','buyer')")
    first.run('INSERT INTO cart_requests VALUES(?,?,?,?,?)', 'buyer', 'key', '{}', '{}', 123)
    first.close()
    const next = new Database(path)
    assert.equal(next.one<{ created: number }>('SELECT created FROM cart_requests WHERE user_id=? AND request_key=?', 'buyer', 'key')!.created, 123)
    assert.equal(next.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 16)
    next.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('009: 版本 8 有数据升级，保留账号并补齐新表', () => {
  const root = mkdtempSync(join(tmpdir(), 'cart-migrate-'))
  const path = join(root, 'mall.sqlite')
  try {
    const first = new Database(path)
    first.run("INSERT INTO users(id,account,password,nickname) VALUES('buyer','buyer','password','buyer')")
    first.close()
    const legacy = new DatabaseSync(path)
    removeAfterSaleSchema(legacy)
    legacy.exec('DROP TRIGGER product_revision_sku_update; DROP TRIGGER product_revision_sku_insert; DROP TRIGGER product_revision_fields; DROP INDEX product_enabled_spec; DROP TABLE product_changes; DROP TABLE product_images; ALTER TABLE skus DROP COLUMN enabled; ALTER TABLE products DROP COLUMN revision; ALTER TABLE products DROP COLUMN status; DROP TABLE cart_requests; PRAGMA user_version=8')
    legacy.close()
    const migrated = new Database(path)
    assert.equal(migrated.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 16)
    assert.equal(migrated.one<{ account: string }>('SELECT account FROM users WHERE id=?', 'buyer')!.account, 'buyer')
    assert.equal(migrated.one<{ count: number }>('SELECT COUNT(*) count FROM cart_requests')!.count, 0)
    migrated.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('009: 迁移失败整体回滚，旧库版本和哨兵保留', () => {
  const root = mkdtempSync(join(tmpdir(), 'cart-migrate-'))
  const path = join(root, 'mall.sqlite')
  try {
    new Database(path).close()
    const legacy = new DatabaseSync(path)
    removeAfterSaleSchema(legacy)
    legacy.exec("DROP TRIGGER product_revision_sku_update; DROP TRIGGER product_revision_sku_insert; DROP TRIGGER product_revision_fields; DROP INDEX product_enabled_spec; DROP TABLE product_changes; DROP TABLE product_images; ALTER TABLE skus DROP COLUMN enabled; ALTER TABLE products DROP COLUMN revision; ALTER TABLE products DROP COLUMN status; DROP TABLE cart_requests; PRAGMA user_version=8; CREATE TABLE cart_requests(sentinel TEXT); INSERT INTO cart_requests VALUES('保留')")
    legacy.close()
    assert.throws(() => new Database(path))
    const check = new DatabaseSync(path)
    assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 8)
    assert.equal(check.prepare('SELECT sentinel FROM cart_requests').get()!.sentinel, '保留')
    check.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('009: 建表及版本写入后故障也回滚整次迁移', context => {
  const root = mkdtempSync(join(tmpdir(), 'cart-rollback-'))
  const path = join(root, 'mall.sqlite')
  try {
    new Database(path).close()
    const legacy = new DatabaseSync(path)
    removeAfterSaleSchema(legacy)
    legacy.exec("DROP TRIGGER product_revision_sku_update; DROP TRIGGER product_revision_sku_insert; DROP TRIGGER product_revision_fields; DROP INDEX product_enabled_spec; DROP TABLE product_changes; DROP TABLE product_images; ALTER TABLE skus DROP COLUMN enabled; ALTER TABLE products DROP COLUMN revision; ALTER TABLE products DROP COLUMN status; DROP TABLE cart_requests; PRAGMA user_version=8; INSERT INTO users(id,account,password,nickname) VALUES('buyer','buyer','unused','买家')")
    legacy.close()
    const exec = DatabaseSync.prototype.exec
    context.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
      exec.call(this, sql)
      if (sql.includes('CREATE TABLE cart_requests')) throw new Error('injected after DDL')
    })
    assert.throws(() => new Database(path), /injected after DDL/)
    context.mock.restoreAll()
    const check = new DatabaseSync(path)
    assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 8)
    assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='cart_requests'").get(), undefined)
    assert.equal(check.prepare('SELECT account FROM users').get()!.account, 'buyer')
    check.close()
    const restored = new Database(path)
    assert.equal(restored.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 16)
    restored.close()
  } finally { context.mock.restoreAll(); rmSync(root, { recursive: true, force: true }) }
})

test('B-14: 30 秒任务按注入时钟清理 24 小时前回执', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] })
  let now = Date.UTC(2026, 10, 6)
  const f = await buildTestApp({ databasePath: ':memory:', publicUrl: 'http://fixture', uploadsPath: './unused',
    mockPayments: true, clock: { now: () => now } })
  try {
    const buyer = f.testData.account({ account: 'cleanup_buyer', password: 'password' })
    const user = f.accounts.authenticate('Bearer ' + buyer.token)
    f.testData.product({ name: '苹果', skus: [{ id: 'cleanup-apple', spec: '红', priceCents: 100, stock: 5 }] })
    const first = randomUUID(), second = randomUUID()
    f.catalog.addCart(user, 'cleanup-apple', 1, first)
    now += 24 * 60 * 60_000
    context.mock.timers.tick(30_000)
    assert.equal(f.db.one<{ count: number }>('SELECT COUNT(*) count FROM cart_requests')!.count, 1)
    now++
    f.catalog.addCart(user, 'cleanup-apple', 1, second)
    context.mock.timers.tick(30_000)
    assert.deepEqual(f.db.all<{ request_key: string }>('SELECT request_key FROM cart_requests ORDER BY created').map(row => row.request_key), [second])
    assert.equal(f.catalog.addCart(user, 'cleanup-apple', 1, first).count, 3)
  } finally { await f.app.close() }
})

for (const version of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  test(`009: manifest ${version} 仍可验证恢复，启动升级到10并统计请求表`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'cart-backup-'))
    mkdirSync(join(root, 'live'))
    const path = join(root, 'live', 'mall.sqlite')
    try {
      const raw = new DatabaseSync(path)
      raw.exec(readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'))
      raw.exec(`CREATE TABLE categories(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT REFERENCES categories(id),source_key TEXT UNIQUE NOT NULL);
        CREATE TABLE product_categories(product_id TEXT PRIMARY KEY REFERENCES products(id),category_id TEXT NOT NULL REFERENCES categories(id));
        PRAGMA user_version=2; INSERT INTO users(id,account,password,nickname) VALUES('buyer','buyer','unused','买家');`)
      for (const [target, file] of [[3, '003-inventory.sql'], [4, '004-stock-adjustment.sql'], [6, '006-address-autosave.sql'],
        [7, '007-payments.sql'], [8, '008-order-cancellation.sql'], [9, '009-cart-requests.sql'], [10, '010-product-management.sql']] as const) {
        if (target <= version) raw.exec(readFileSync(new URL('../src/migrations/' + file, import.meta.url), 'utf8'))
      }
      raw.exec(`PRAGMA user_version=${version}`)
      if (version >= 9) raw.prepare('INSERT INTO cart_requests VALUES(?,?,?,?,?)').run('buyer', 'key', '{}', '{}', 123)
      raw.close()
      const backup = await createBackup({ databasePath: path, uploadsPath: join(root, 'live', 'uploads'), destination: join(root, 'snapshot') })
      assert.equal(backup.manifest.schemaVersion, version)
      assert.equal((await verifyBackup(backup.root)).manifest.schemaVersion, version)
      assert.equal(backup.counts.cart_requests, version >= 9 ? 1 : undefined)
      const restored = await restoreBackup({ backupPath: backup.root, destination: join(root, 'restored') })
      const upgraded = new Database(join(restored.root, 'mall.sqlite'))
      assert.equal(upgraded.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 16)
      assert.equal(upgraded.one<{ count: number }>('SELECT COUNT(*) count FROM cart_requests')!.count, version >= 9 ? 1 : 0)
      assert.equal(upgraded.one<{ account: string }>('SELECT account FROM users')!.account, 'buyer')
      upgraded.close()
      const reopened = new Database(join(restored.root, 'mall.sqlite'))
      assert.equal(reopened.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 16)
      assert.equal(reopened.one<{ account: string }>('SELECT account FROM users')!.account, 'buyer')
      assert.equal(reopened.one<{ count: number }>('SELECT COUNT(*) count FROM cart_requests')!.count, version >= 9 ? 1 : 0)
      reopened.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
