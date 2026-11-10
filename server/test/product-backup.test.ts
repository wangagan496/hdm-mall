import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTestApp } from './helpers/fixtures.ts'
import { createBackup, restoreBackup } from '../src/backup.ts'

test('v10 备份包含登记图、现封面和历史订单图，换域名恢复不改订单快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-product-backup-'))
  const databasePath = join(root, 'live', 'mall.sqlite'), uploadsPath = join(root, 'live', 'uploads')
  const f = await buildTestApp({ databasePath, uploadsPath, publicUrl: 'http://old.example', mockPayments: true })
  try {
    await mkdir(uploadsPath, { recursive: true })
    const bytes = Buffer.from([255, 216, 255, 217])
    const paths = Array.from({ length: 3 }, () => '/uploads/' + randomUUID() + '.jpg')
    for (const path of paths) await writeFile(join(uploadsPath, path.slice(9)), bytes)
    const merchant = f.accounts.register('backup_merchant', 'test-password-123', 'merchant')
    f.accounts.register('backup_customer', 'test-password-123', 'buyer')
    const buyer = f.accounts.authenticate('Bearer ' + f.accounts.login('backup_customer', 'test-password-123').token)
    f.testData.product({ id: 'backup-item', name: '历史商品', category: '测试分类', skus: [{ id: 'backup-sku', spec: '标准', priceCents: 2000, stock: 10 }] })
    for (const path of paths.slice(0, 2)) f.db.run('INSERT INTO product_images VALUES(?,?,?,?,?,?,?)', randomUUID(), merchant.id, randomUUID(), createHash('sha256').update(bytes).digest('hex'), path, 'backup-item', 1)
    f.db.run('UPDATE products SET picture=? WHERE id=?', paths[0]!, 'backup-item')
    const address = f.testData.address({ userId: buyer.id, receiver: '买家', contact: '13800000000', address: '测试地址' })
    const order = f.orders.create(buyer, { requestKey: randomUUID(), addressId: address.id, expectedAmountCents: 2000, goods: [{ skuId: 'backup-sku', count: 1 }] })
    f.db.run('UPDATE order_items SET picture=? WHERE order_id=?', 'http://old.example' + paths[2], order.id)
    const backup = await createBackup({ databasePath, uploadsPath, destination: join(root, 'backup') })
    assert.equal(backup.manifest.schemaVersion, 13)
    assert.equal(backup.counts.product_images, 2)
    assert.deepEqual(backup.manifest.issues, [])
    assert.equal(backup.manifest.files.length, 4)
    const restored = await restoreBackup({ backupPath: backup.root, destination: join(root, 'restore') })
    const next = await buildTestApp({ databasePath: join(restored.root, 'mall.sqlite'), uploadsPath: join(restored.root, 'uploads'), publicUrl: 'https://new.example', mockPayments: true })
    try {
      assert.equal(next.orders.detail(buyer, order.id).skus[0]!.image, 'https://new.example' + paths[2])
      assert.equal(next.db.one<{ picture: string }>('SELECT picture FROM order_items WHERE order_id=?', order.id)!.picture, 'http://old.example' + paths[2])
    } finally { await next.app.close() }
    await rm(join(uploadsPath, paths[0]!.slice(9)))
    await rm(join(uploadsPath, paths[2]!.slice(9)))
    await writeFile(join(uploadsPath, paths[1]!.slice(9)), Buffer.from('tampered'))
    f.db.run('UPDATE product_images SET product_id=NULL WHERE path=?', paths[0]!)
    const broken = await createBackup({ databasePath, uploadsPath, destination: join(root, 'broken') })
    const types = broken.manifest.issues.map(issue => issue.type)
    for (const type of ['missing-product-image', 'missing-order-image', 'product-image-mismatch', 'product-image-hash-mismatch']) assert.ok(types.includes(type as typeof types[number]), type)
    await assert.rejects(restoreBackup({ backupPath: broken.root, destination: join(root, 'rejected') }), /不一致/)
  } finally { await f.app.close(); await rm(root, { recursive: true, force: true }) }
})
