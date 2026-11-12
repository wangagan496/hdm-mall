import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Database } from '../src/database.ts'
import { buildTestApp } from './helpers/fixtures.ts'
import { adjustStock } from '../src/inventory.ts'
import { createBackup, restoreBackup } from '../src/backup.ts'

const priceCents = 2531, initialStock = 20
const productInput = { id: 'adjust-product', name: '独立测试商品', category: '测试分类',
  skus: [{ id: 'adjust-product-a', spec: '标准', priceCents, stock: initialStock },
    { id: 'adjust-product-b', spec: '加大', priceCents: priceCents + 517, stock: 10 }] }

async function fixture() {
  const f = await buildTestApp({ databasePath: ':memory:', uploadsPath: './unused', publicUrl: 'http://127.0.0.1:3000', mockPayments: true })
  f.testData.product(productInput)
  for (const account of ['merchant_one', 'merchant_two', 'normal_buyer']) f.accounts.register(account, 'test-password-123', account === 'normal_buyer' ? 'buyer' : 'merchant')
  const merchant = f.accounts.login('merchant_one', 'test-password-123')
  const other = f.accounts.login('merchant_two', 'test-password-123')
  const buyer = f.accounts.login('normal_buyer', 'test-password-123')
  const payload = (delta = 3, expectedStock = initialStock) => ({ requestKey: randomUUID(), delta, expectedStock, reason: '仓库盘点补充库存' })
  const put = (data: object, token = merchant.token, sku = 'adjust-product-a') => f.app.inject({ method: 'PUT', url: `/merchant/inventory/${sku}/adjustments`, headers: { authorization: `Bearer ${token}` }, payload: data })
  const stock = () => f.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', 'adjust-product-a')!.stock
  const rows = () => f.db.all("SELECT * FROM inventory_movements WHERE kind='adjust'")
  return { ...f, merchant, other, buyer, payload, put, stock, rows }
}

test('库存调整记录原因及操作者，重复请求返回原凭据且不能更改原内容', async () => {
  const f = await fixture()
  try {
    const data = f.payload(), first = await f.put(data)
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().result.balance, initialStock + 3)
    assert.equal(f.stock(), initialStock + 3)
    assert.equal((await f.put(f.payload(-2, initialStock + 3))).statusCode, 200)
    assert.deepEqual((await f.put(data)).json(), first.json())
    assert.equal(f.stock(), initialStock + 1); assert.equal(f.rows().length, 2)
    for (const changed of [{ ...data, reason: '另一次不同原因' }, { ...data, delta: 4 }, { ...data, expectedStock: initialStock + 1 }]) {
      assert.equal((await f.put(changed)).statusCode, 409)
    }
    assert.equal((await f.put(data, f.merchant.token, 'adjust-product-b')).statusCode, 409)
    const row = f.db.one<{ actor_id: string; reason: string }>("SELECT * FROM inventory_movements WHERE kind='adjust' ORDER BY id")!
    assert.equal(row.actor_id, f.merchant.id); assert.equal(row.reason, data.reason)
    const result = await f.app.inject({ url: `/merchant/inventory/adjustments/${data.requestKey}`, headers: { authorization: `Bearer ${f.merchant.token}` } })
    assert.deepEqual(result.json(), first.json())
    assert.equal((await f.app.inject({ url: `/merchant/inventory/adjustments/${data.requestKey}`, headers: { authorization: `Bearer ${f.other.token}` } })).statusCode, 404)
  } finally { await f.app.close() }
})

test('买家和匿名不能调库存，非法数量原因、库存不足、过时库存及流水差异被拒绝', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.put(f.payload(), f.buyer.token)).statusCode, 403)
    assert.equal((await f.put(f.payload(), '')).statusCode, 401)
    for (const changed of [{ delta: 0 }, { delta: 0.5 }, { delta: 1000001 }, { expectedStock: -1 }, { reason: '太短' }, { requestKey: 'invalid' }]) {
      assert.equal((await f.put({ ...f.payload(), ...changed })).statusCode, 400)
    }
    assert.equal((await f.put(f.payload(-initialStock - 1))).statusCode, 409)
    assert.equal((await f.put(f.payload(3, initialStock - 1))).statusCode, 409)
    assert.equal(f.stock(), initialStock); assert.equal(f.rows().length, 0)
    f.db.run('UPDATE skus SET stock=? WHERE id=?', initialStock - 1, 'adjust-product-a')
    assert.equal((await f.put(f.payload(1, initialStock - 1))).statusCode, 409)
    assert.equal(f.rows().length, 0)
  } finally { await f.app.close() }
})

test('重复请求幂等：旧库存连续提交只成功一个，相同编号只增加一次', async () => {
  const f = await fixture()
  try {
    const results = await Promise.all([f.put(f.payload()), f.put(f.payload())])
    assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409])
    const data = f.payload(2, initialStock + 3)
    const repeated = await Promise.all([f.put(data), f.put(data)])
    assert.ok(repeated.every(r => r.statusCode === 200))
    assert.deepEqual(repeated[0]!.json(), repeated[1]!.json())
    assert.equal(f.stock(), initialStock + 5); assert.equal(f.rows().length, 2)
  } finally { await f.app.close() }
})

test('调整流水写失败时库存回滚，同一编号可在修复后重试', async () => {
  const f = await fixture()
  try {
    const data = f.payload(), run = f.db.run.bind(f.db)
    f.db.run = (sql, ...params) => { if (sql.includes("VALUES(?,?,'adjust'")) throw new Error('injected adjustment failure'); return run(sql, ...params) }
    assert.equal((await f.put(data)).statusCode, 500)
    f.db.run = run
    assert.equal(f.stock(), initialStock); assert.equal(f.rows().length, 0)
    assert.equal((await f.put(data)).statusCode, 200)
    assert.equal(f.stock(), initialStock + 3); assert.equal(f.rows().length, 1)
  } finally { await f.app.close() }
})

async function createV3(path: string) {
  const db = new DatabaseSync(path)
  try {
    db.exec(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'))
    db.exec(`CREATE TABLE categories(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT REFERENCES categories(id),source_key TEXT UNIQUE NOT NULL);
      CREATE TABLE product_categories(product_id TEXT PRIMARY KEY REFERENCES products(id),category_id TEXT NOT NULL REFERENCES categories(id));
      INSERT INTO users VALUES('merchant','merchant','unused','商家','merchant','{}');
      INSERT INTO products VALUES('product','商品','测试','/assets/product.svg','测试');
      INSERT INTO skus VALUES('sku','product','规格',2531,20);`)
    db.exec(await readFile(new URL('../src/migrations/003-inventory.sql', import.meta.url), 'utf8'))
  } finally { db.close() }
}

test('v3 备份恢复后升级当前版本保留原流水，新增调整和备份一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-adjust-migrate-'))
  const path = join(root, 'v3.sqlite')
  const parent = await mkdtemp(join(tmpdir(), 'hdm-adjust-artifact-'))
  try {
    await createV3(path)
    const backup = await createBackup({ databasePath: path, uploadsPath: join(root, 'uploads'), destination: join(parent, 'v3') })
    assert.equal(backup.manifest.schemaVersion, 3)
    const restored = await restoreBackup({ backupPath: backup.root, destination: join(parent, 'restored') })
    const databasePath = join(restored.root, 'mall.sqlite'), db = new Database(databasePath)
    try {
      assert.equal(db.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 17)
      assert.equal(db.one<{ delta: number }>('SELECT delta FROM inventory_movements WHERE id=1')!.delta, 20)
      const user = { id: 'merchant', account: 'merchant', nickname: '商家', role: 'merchant' as const, profile: '{}' }
      const receipt = adjustStock(db, user, 'sku', { requestKey: randomUUID(), delta: 2, expectedStock: 20, reason: '实际盘点增加库存' })
      assert.ok(receipt.id > 1); assert.equal(receipt.balance, 22)
      assert.throws(() => db.run('DELETE FROM inventory_movements WHERE id=1'), /append-only/)
    } finally { db.close() }
    const upgraded = await createBackup({ databasePath, uploadsPath: join(restored.root, 'uploads'), destination: join(parent, 'v4') })
    assert.equal(upgraded.manifest.schemaVersion, 17)
    assert.equal(upgraded.counts.inventory_movements, 2)
    const recovered = await restoreBackup({ backupPath: upgraded.root, destination: join(parent, 'restored-v4') })
    const check = new Database(join(recovered.root, 'mall.sqlite'))
    try {
      assert.equal(check.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', 'sku')!.stock, 22)
      assert.deepEqual({ ...check.one<Record<string, string | number>>("SELECT actor_id,delta,balance,reason FROM inventory_movements WHERE kind='adjust'") },
        { actor_id: 'merchant', delta: 2, balance: 22, reason: '实际盘点增加库存' })
      assert.equal(check.one<{ total: number }>('SELECT SUM(delta) AS total FROM inventory_movements')!.total, 22)
    } finally { check.close() }
  } finally { await rm(root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }) }
})

test('v4 迁移遇到不合规旧流水时回滚，原表版本和数据保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-adjust-rollback-')), path = join(root, 'v3.sqlite')
  try {
    await createV3(path)
    const malformed = new DatabaseSync(path)
    try {
      malformed.exec('PRAGMA ignore_check_constraints=ON')
      malformed.exec("INSERT INTO inventory_movements(sku_id,kind,delta,balance,business_key,created) VALUES('sku','invalid',0,20,'bad',0)")
    } finally { malformed.close() }
    assert.throws(() => new Database(path), /CHECK/)
    const check = new DatabaseSync(path)
    try {
      assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 3)
      assert.equal(check.prepare('SELECT COUNT(*) AS count FROM inventory_movements').get()!.count, 2)
      assert.equal(check.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='inventory_movements_v3'").get()!.count, 0)
      assert.throws(() => check.exec('DELETE FROM inventory_movements WHERE id=1'), /append-only/)
    } finally { check.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
