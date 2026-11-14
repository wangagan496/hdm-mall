import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { serviceFixture } from './helpers/service-fixture.ts'
import { createBackup, restoreBackup, verifyBackup } from '../src/backup.ts'
import { Database } from '../src/database.ts'
import { removeServiceSchema } from './helpers/legacy-v16.ts'

test('B17 开票、隐藏评价和留言照片随v17备份校验恢复，恢复撤销旧会话', async () => {
  const f = await serviceFixture(true)
  try {
    const orderId = (await f.create({ titleType: 'individual', title: '个人', email: 'backup@example.test' })).body.result.id
    await f.complete(orderId)
    assert.equal((await f.call('POST', `/merchant/orders/${orderId}/invoice/issued`, { requestKey: randomUUID() }, f.merchant.token)).status, 200)
    assert.equal((await f.call('PUT', `/member/order/${orderId}/evaluation`, { score: 4, content: '包装需要改善' })).status, 200)
    assert.equal((await f.call('POST', `/merchant/reviews/${orderId}/hide`, { reason: '无关内容' }, f.merchant.token)).status, 200)
    const image = (await f.upload('/member/service/images', { requestKey: randomUUID() })).body.result.path
    assert.equal((await f.call('POST', '/member/service/messages', { requestKey: randomUUID(), content: '请看照片', orderId, images: [image] })).status, 200)
    const backup = await createBackup({ databasePath: join(f.root, 'data', 'mall.sqlite'), uploadsPath: join(f.root, 'uploads'), destination: join(f.root, 'backup') })
    assert.equal(backup.manifest.schemaVersion, 19)
    assert.deepEqual(backup.manifest.issues, [])
    assert.equal(backup.counts.invoices, 1)
    assert.equal(backup.counts.review_moderation, 1)
    assert.equal(backup.counts.service_messages, 1)
    assert.equal(backup.manifest.files.some(file => file.path === image.slice(1)), true)
    assert.equal((await verifyBackup(backup.root)).counts.service_images, 1)
    const restored = await restoreBackup({ backupPath: backup.root, destination: join(f.root, 'restored') })
    assert.equal(restored.report.counts.service_messages, 1)
    assert.equal(restored.report.counts.sessions, 0)
    const db = new DatabaseSync(join(restored.root, 'mall.sqlite'), { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT status FROM invoices').get()!.status, 'issued')
      assert.equal(db.prepare('SELECT reason FROM review_moderation').get()!.reason, '无关内容')
      assert.equal(db.prepare('SELECT content FROM service_messages').get()!.content, '请看照片')
    } finally { db.close() }
  } finally { await f.close() }
})

test('B17 真实v16备份仍能恢复，迁移017保留旧订单且重复打开不重复迁移', async () => {
  const f = await serviceFixture(true)
  try {
    const id = (await f.create()).body.result.id
    await f.complete(id)
    await f.ctx.app.close()
    const path = join(f.root, 'data', 'mall.sqlite')
    const legacy = new DatabaseSync(path)
    try { removeServiceSchema(legacy); legacy.exec('PRAGMA user_version=16') } finally { legacy.close() }
    const backup = await createBackup({ databasePath: path, uploadsPath: join(f.root, 'uploads'), destination: join(f.root, 'legacy-backup') })
    assert.equal(backup.manifest.schemaVersion, 16)
    const restored = await restoreBackup({ backupPath: backup.root, destination: join(f.root, 'legacy-restored') })
    for (let attempt = 0; attempt < 2; attempt++) {
      const db = new Database(join(restored.root, 'mall.sqlite'))
      try {
        assert.equal(db.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 19)
        assert.equal(db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', id)!.state, 4)
        assert.equal(db.one<{ n: number }>('SELECT COUNT(*) n FROM invoices')!.n, 0)
        assert.deepEqual(db.all('PRAGMA foreign_key_check'), [])
      } finally { db.close() }
    }
  } finally { await f.close() }
})

test('B17 留言订单跨买家及留言内容篡改均不能通过备份校验', async () => {
  const f = await serviceFixture(true)
  try {
    const orderId = (await f.create()).body.result.id
    const sent = await f.call('POST', '/member/service/messages', { requestKey: randomUUID(), content: '原留言', orderId })
    assert.equal(sent.status, 200)
    f.ctx.db.run('UPDATE service_messages SET content=? WHERE id=?', '篡改留言', sent.body.result.id)
    await assert.rejects(createBackup({ databasePath: join(f.root, 'data', 'mall.sqlite'), uploadsPath: join(f.root, 'uploads'), destination: join(f.root, 'bad-content') }), /留言幂等回执无效/)
    f.ctx.db.run('UPDATE service_messages SET content=? WHERE id=?', '原留言', sent.body.result.id)
    f.ctx.db.run('UPDATE orders SET owner_id=? WHERE id=?', f.other.id, orderId)
    await assert.rejects(createBackup({ databasePath: join(f.root, 'data', 'mall.sqlite'), uploadsPath: join(f.root, 'uploads'), destination: join(f.root, 'bad-owner') }), /留言操作人或关联订单无效/)
  } finally { await f.close() }
})
