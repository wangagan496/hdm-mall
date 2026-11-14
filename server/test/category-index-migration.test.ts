import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Database } from '../src/database.ts'
import { Catalog } from '../src/catalog.ts'
import { createBackup, verifyBackup, restoreBackup } from '../src/backup.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

test('E19 v18备份升级保留历史商品订单与分类摘要，索引随备份恢复且重开不重复迁移', async () => {
  const f = await serviceFixture(true)
  try {
    const orderId = (await f.create()).body.result.id
    const expected = f.ctx.catalog.categorySummary()
    const products = f.ctx.db.all('SELECT * FROM products ORDER BY id')
    const skus = f.ctx.db.all('SELECT * FROM skus ORDER BY id')
    const orders = f.ctx.db.all('SELECT * FROM orders ORDER BY id')
    const path = join(f.root, 'data', 'mall.sqlite')
    await f.ctx.app.close()
    const raw = new DatabaseSync(path)
    try { raw.exec('DROP INDEX IF EXISTS skus_product_availability; DROP INDEX IF EXISTS categories_parent; PRAGMA user_version=18') } finally { raw.close() }
    const legacy = await createBackup({ databasePath: path, uploadsPath: join(f.root, 'uploads'), destination: join(f.root, 'v18') })
    assert.equal(legacy.manifest.schemaVersion, 18)
    await verifyBackup(legacy.root)
    const restored = await restoreBackup({ backupPath: legacy.root, destination: join(f.root, 'restored-v18') })
    const upgradedPath = join(restored.root, 'mall.sqlite')
    let schemaVersion: number | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const db = new Database(upgradedPath)
      try {
        assert.equal(db.one<{user_version: number}>('PRAGMA user_version')!.user_version, 19)
        assert.deepEqual(db.all('SELECT * FROM products ORDER BY id'), products)
        assert.deepEqual(db.all('SELECT * FROM skus ORDER BY id'), skus)
        assert.deepEqual(db.all('SELECT * FROM orders ORDER BY id'), orders)
        assert.ok(db.one('SELECT id FROM orders WHERE id=?', orderId))
        assert.deepEqual(new Catalog(db, 'http://localhost').categorySummary(), expected)
        for (const [name, columns] of [['skus_product_availability', ['product_id','enabled','stock','price']], ['categories_parent', ['parent_id']]] as const) {
          assert.deepEqual(db.all<{name: string}>(`PRAGMA index_info(${name})`).map(row => row.name), columns)
        }
        const current = db.one<{schema_version: number}>('PRAGMA schema_version')!.schema_version
        if (schemaVersion !== undefined) assert.equal(current, schemaVersion)
        schemaVersion = current
        assert.deepEqual(db.all('PRAGMA foreign_key_check'), [])
      } finally { db.close() }
    }
    const current = await createBackup({ databasePath: upgradedPath, uploadsPath: join(f.root, 'uploads'), destination: join(f.root, 'v19') })
    assert.equal(current.manifest.schemaVersion, 19)
    assert.equal((await verifyBackup(current.root)).counts.orders, 1)
    const next = await restoreBackup({ backupPath: current.root, destination: join(f.root, 'restored-v19') })
    const db = new Database(join(next.root, 'mall.sqlite'))
    try { assert.deepEqual(new Catalog(db, 'http://localhost').categorySummary(), expected); assert.equal(db.all("SELECT name FROM sqlite_master WHERE name IN ('skus_product_availability','categories_parent')").length, 2) }
    finally { db.close() }
  } finally { await f.close() }
})
