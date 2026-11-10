import { removeAfterSaleSchema } from './helpers/legacy-v11.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Database } from '../src/database.ts'

test('已有 v10 商品和回执迁移到 v11，库存不再影响版本，重复打开不丢数据', () => {
  const root = mkdtempSync(join(tmpdir(), 'product-revision-'))
  const path = join(root, 'mall.sqlite')
  try {
    const first = new Database(path); first.close()
    const raw = new DatabaseSync(path)
    const migration = readFileSync(new URL('../src/migrations/010-product-management.sql', import.meta.url), 'utf8')
    const originalTrigger = migration.slice(migration.indexOf('CREATE TRIGGER product_revision_sku_update'), migration.indexOf('CREATE TRIGGER product_revision_sku_insert'))
    removeAfterSaleSchema(raw)
    raw.exec('DROP TRIGGER product_revision_sku_update;' + originalTrigger + 'PRAGMA user_version=10;')
    raw.exec("INSERT INTO products(id,name,category,picture,description) VALUES('p','保留商品','分类','/assets/product.svg','说明'); INSERT INTO skus(id,product_id,spec,price,stock) VALUES('s','p','标准',100,10);")
    raw.exec("INSERT INTO users(id,account,password,nickname) VALUES('m','m','unused','商家'); INSERT INTO product_changes VALUES('m','key','create','p','{}','{}',1);")
    const before = raw.prepare("SELECT revision FROM products WHERE id='p'").get()!.revision
    raw.close()
    for (let attempt = 0; attempt < 2; attempt++) {
      const db = new Database(path)
      try {
        assert.equal(db.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 13)
        db.run("UPDATE skus SET stock=stock-1 WHERE id='s'")
        assert.equal(db.one<{ revision: number }>("SELECT revision FROM products WHERE id='p'")!.revision, before)
        assert.equal(db.one<{ name: string }>("SELECT name FROM products WHERE id='p'")!.name, '保留商品')
        assert.equal(db.one<{ created: number }>("SELECT created FROM product_changes WHERE request_key='key'")!.created, 1)
      } finally { db.close() }
    }
    const db = new Database(path)
    try { db.run("UPDATE skus SET price=200 WHERE id='s'"); assert.equal(db.one<{ revision: number }>("SELECT revision FROM products WHERE id='p'")!.revision, Number(before) + 1) }
    finally { db.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
