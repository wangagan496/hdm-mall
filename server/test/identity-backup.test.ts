import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { appendAudit } from '../src/audit.ts'
import { createBackup, restoreBackup, verifyBackup } from '../src/backup.ts'
import { Database } from '../src/database.ts'
import { IDENTITY_ENTRIES } from '../src/identity-context/entries.ts'
import { removeIdentitySchema } from './helpers/legacy-v19.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

test('阶段1B 旧备份恢复后保留历史操作身份，迁移的新买家授予与双身份配置随备份恢复', async () => {
  const f = await serviceFixture(true)
  try {
    const order = await f.create()
    assert.equal(order.status, 200)
    const orderId = order.body.result.id
    await f.complete(orderId)
    const requested = await f.call('POST', `/member/order/${orderId}/after-sales`, {
      requestKey: randomUUID(), kind: 'return-no-reason', description: '需要退回未使用的商品',
      items: [{ skuId: f.product.skus[0]!.id, count: 1 }]
    })
    assert.equal(requested.status, 200)
    const saleId = requested.body.result.afterSaleId
    assert.equal((await f.call('POST', `/merchant/after-sales/${saleId}/reject`, {
      requestKey: randomUUID(), reason: '申请理由需进一步核对'
    }, f.merchant.token)).status, 200)
    const cancellable = await f.create()
    assert.equal(cancellable.status, 200)
    const cancelOrderId = cancellable.body.result.id
    assert.equal((await f.call('POST', `/member/order/${cancelOrderId}/mock-pay`, { amountCents: 1000 })).status, 200)
    const cancellation = await f.call('POST', `/member/order/${cancelOrderId}/cancel-requests`, { requestKey: randomUUID() })
    assert.equal(cancellation.status, 200)
    assert.equal((await f.call('POST', `/merchant/orders/${cancelOrderId}/cancel-requests/${cancellation.body.result.cancelRequestId}/resolve`, {
      requestKey: randomUUID(), decision: 'approve'
    }, f.merchant.token)).status, 200)
    const historicalAudit = f.ctx.db.all('SELECT * FROM audit_log ORDER BY id')
    await f.ctx.app.close()

    const originalPath = join(f.root, 'data', 'mall.sqlite')
    const uploadsPath = join(f.root, 'uploads')
    const raw = new DatabaseSync(originalPath)
    try { removeIdentitySchema(raw) } finally { raw.close() }
    const old = await createBackup({ databasePath: originalPath, uploadsPath, destination: join(f.root, 'before-020') })
    assert.equal(old.manifest.schemaVersion, 19)
    assert.deepEqual(old.manifest.issues, [])

    const migratedAt = Date.UTC(2026, 10, 11) + 1000
    const clock = { now: () => migratedAt }
    const live = new Database(originalPath, clock)
    try {
      assert.equal(live.one<{ identity: string }>('SELECT identity FROM sessions WHERE user_id=?', f.merchant.id)!.identity, 'merchant')
      assert.equal(live.one<{ identity: string }>('SELECT identity FROM sessions WHERE user_id=?', f.buyer.id)!.identity, 'buyer')
    } finally { live.close() }

    const fromOld = await restoreBackup({ backupPath: old.root, destination: join(f.root, 'old-restored') })
    const migratedPath = join(fromOld.root, 'mall.sqlite')
    const db = new Database(migratedPath, clock)
    try {
      assert.deepEqual(db.all('SELECT * FROM audit_log ORDER BY id'), historicalAudit)
      assert.deepEqual(db.all<Record<string, unknown>>(`SELECT identity,source,granted_at FROM user_identities WHERE user_id=?
        ORDER BY granted_at`, f.merchant.id).map(r => ({ ...r })), [
        { identity: 'merchant', source: 'migration-original', granted_at: 0 },
        { identity: 'buyer', source: 'migration-extra', granted_at: migratedAt }
      ])
      assert.deepEqual(db.all<{ identity: string }>('SELECT identity FROM user_identities WHERE user_id=?', f.buyer.id).map(r => r.identity), ['buyer'])
      assert.equal(db.one<{ n: number }>('SELECT COUNT(*) n FROM sessions')!.n, 0)
      assert.deepEqual(db.all<{ acting_identity: string }>('SELECT acting_identity FROM after_sale_actions ORDER BY rowid').map(r => r.acting_identity), ['buyer', 'merchant'])
      assert.deepEqual(db.all<{ acting_identity: string }>('SELECT acting_identity FROM order_cancel_actions ORDER BY rowid').map(r => r.acting_identity), ['buyer', 'merchant'])
      assert.throws(() => db.run("UPDATE users SET role='buyer' WHERE id=?", f.merchant.id), /read.only|cannot be changed/)
      for (const identity of ['buyer', 'merchant'] as const) {
        const entry = IDENTITY_ENTRIES[identity].find(e => !e.locked)!
        db.run('INSERT INTO identity_layouts(user_id,identity,layout,revision,updated) VALUES(?,?,?,?,?)',
          f.merchant.id, identity, JSON.stringify([entry.id]), 1, migratedAt)
      }
      appendAudit(db, { created: migratedAt, actor: { id: f.merchant.id, identity: 'merchant' }, action: 'identity.switch',
        targetType: 'account', targetId: f.merchant.id, summary: { before: 'merchant', after: 'buyer' } })
      db.run("UPDATE user_identities SET revoked_at=? WHERE user_id=? AND identity='buyer'", migratedAt + 1, f.merchant.id)
      assert.deepEqual(db.all('PRAGMA foreign_key_check'), [])
    } finally { db.close() }

    const snapshot = await createBackup({ databasePath: migratedPath, uploadsPath, destination: join(f.root, 'after-020') })
    assert.equal(snapshot.manifest.schemaVersion, 23)
    assert.deepEqual(snapshot.manifest.issues, [])
    assert.equal((await verifyBackup(snapshot.root)).counts.identity_layouts, 2)
    const restored = await restoreBackup({ backupPath: snapshot.root, destination: join(f.root, 'new-restored') })
    const restoredDb = new Database(join(restored.root, 'mall.sqlite'), clock)
    try {
      assert.equal(restored.report.counts.identity_layouts, 2)
      assert.deepEqual(restoredDb.all("SELECT * FROM audit_log WHERE action<>'identity.switch' ORDER BY id"), historicalAudit)
      assert.equal(restoredDb.one<{ actor_kind: string }>("SELECT actor_kind FROM audit_log WHERE action='identity.switch'")!.actor_kind, 'merchant')
      restoredDb.run("UPDATE after_sale_actions SET acting_identity='buyer' WHERE actor_id=?", f.merchant.id)
    } finally { restoredDb.close() }
    const tampered = await createBackup({ databasePath: join(restored.root, 'mall.sqlite'), uploadsPath, destination: join(f.root, 'tampered') })
    assert.deepEqual(tampered.manifest.issues, [{ type: 'after-sale-mismatch', orderId }])
    const auditDb = new Database(migratedPath, clock)
    try {
      appendAudit(auditDb, { created: migratedAt - 1, actor: { id: f.merchant.id, identity: 'merchant' }, action: 'identity.switch',
        targetType: 'account', targetId: f.merchant.id, summary: { before: 'merchant', after: 'buyer' } })
    } finally { auditDb.close() }
    await assert.rejects(createBackup({ databasePath: migratedPath, uploadsPath, destination: join(f.root, 'invalid-grant-time') }), /身份切换审计无效/)
  } finally { await f.close() }
})
