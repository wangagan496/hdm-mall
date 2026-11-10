import { removeAfterSaleSchema } from './helpers/legacy-v11.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createBackup, verifyBackup, restoreBackup } from '../src/backup.ts'
import { buildApp } from '../src/app.ts'
import { Database } from '../src/database.ts'
import { buildTestApp } from './helpers/fixtures.ts'

const amountCents = 2475
const deadlineMs = 72 * 3600_000

async function fixture(databasePath = ':memory:') {
  let now = Date.UTC(2026, 10, 6, 8)
  const clock = { now: () => now }
  const ctx = await buildTestApp({ databasePath, uploadsPath: './unused', publicUrl: 'http://localhost', mockPayments: true, clock })
  const suffix = randomUUID().slice(0, 8)
  const buyer = ctx.testData.account({ account: 'buyer_' + suffix, password: 'test-password-123' })
  const merchant = ctx.testData.account({ account: 'seller_' + suffix, password: 'test-password-123', role: 'merchant' })
  const payer = ctx.testData.account({ account: 'payer_' + suffix, password: 'test-password-123' })
  const address = ctx.testData.address({ userId: buyer.id, receiver: '买家', contact: '13800000000', address: '测试地址' })
  const product = ctx.testData.product({ name: '取消测试' + suffix, category: '取消测试', skus: [{ spec: '标准', priceCents: amountCents, stock: 20 }] })
  const sku = product.skus[0]!
  const call = async (method: string, url: string, token = buyer.token, payload?: object) => {
    const response = await ctx.app.inject({ method: method as never, url, headers: token ? { authorization: 'Bearer ' + token } : {}, payload })
    return { status: response.statusCode, body: response.json() }
  }
  const create = async (paid = true) => {
    const response = await call('POST', '/member/order', buyer.token, { addressId: address.id, requestKey: randomUUID(), expectedAmountCents: amountCents, goods: [{ skuId: sku.id, count: 1 }] })
    assert.equal(response.status, 200)
    const id = response.body.result.id as string
    if (paid) assert.equal((await call('POST', '/member/order/' + id + '/mock-pay', buyer.token, { amountCents })).status, 200)
    return id
  }
  const request = (id: string, requestKey = randomUUID(), token = buyer.token) => call('POST', '/member/order/' + id + '/cancel-requests', token, { requestKey })
  const resolve = (id: string, cancelRequestId: string, decision = 'approve', reason?: string, requestKey = randomUUID()) => call('POST', '/merchant/orders/' + id + '/cancel-requests/' + cancelRequestId + '/resolve', merchant.token, { requestKey, decision, ...(reason === undefined ? {} : { reason }) })
  const withdraw = (id: string, cancelRequestId: string, requestKey = randomUUID()) => call('POST', '/member/order/' + id + '/cancel-requests/' + cancelRequestId + '/withdraw', buyer.token, { requestKey })
  const order = (id: string) => ctx.db.one<{ state: number; shipped_at: number | null }>('SELECT state,shipped_at FROM orders WHERE id=?', id)!
  const stock = () => ctx.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', sku.id)!.stock
  const renew = () => ctx.db.run('UPDATE sessions SET expires=?', clock.now() + 24 * 3600_000)
  return { ctx, buyer, merchant, payer, sku, clock, call, create, request, resolve, withdraw, order, stock, renew, advance: (delta: number) => { now += delta } }
}

test('B-80 RED1：空库迁移至8且取消两表为空', () => {
  const db = new Database(':memory:')
  try {
    assert.equal(db.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 14)
    assert.equal(db.one<{ count: number }>('SELECT COUNT(*) AS count FROM order_cancel_requests')!.count, 0)
    assert.equal(db.one<{ count: number }>('SELECT COUNT(*) AS count FROM order_cancel_actions')!.count, 0)
  } finally { db.close() }
})

test('B-62 B-73 B-78 RED2：仅下单人申请且同号幂等，不退款不释放', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const requestKey = randomUUID()
    assert.equal((await f.request(id, randomUUID(), f.payer.token)).status, 403)
    const response = await f.request(id, requestKey)
    assert.equal(response.status, 200)
    assert.equal(response.body.result.appliedState, 'pending')
    assert.deepEqual((await f.request(id, requestKey)).body.result, response.body.result)
    assert.equal((await f.request(id)).body.reason, 'CANCEL_REQUEST_PENDING')
    assert.equal(f.order(id).state, 2)
    assert.equal(f.stock(), 19)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM refunds')!.count, 0)
    const row = f.ctx.db.one<{ deadline_at: number; created: number; requested_by: string }>('SELECT * FROM order_cancel_requests WHERE order_id=?', id)!
    assert.equal(row.deadline_at - row.created, deadlineMs)
    assert.equal(row.requested_by, f.buyer.id)
  } finally { await f.ctx.app.close() }
})

test('B-74 B-77 B-78 RED3：撤回后可反复申请，旧号重放不影响新申请', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const originalKey = randomUUID()
    const original = (await f.request(id, originalKey)).body.result
    const withdrawalKey = randomUUID()
    const first = await f.withdraw(id, original.cancelRequestId, withdrawalKey)
    assert.equal(first.status, 200)
    assert.equal(first.body.result.appliedState, 'withdrawn')
    f.advance(1)
    const second = (await f.request(id)).body.result
    assert.notEqual(second.cancelRequestId, original.cancelRequestId)
    assert.deepEqual((await f.request(id, originalKey)).body.result, original)
    assert.deepEqual((await f.withdraw(id, original.cancelRequestId, withdrawalKey)).body.result, first.body.result)
    assert.equal((await f.withdraw(id, original.cancelRequestId)).status, 409)
    for (let iteration = 0; iteration < 3; iteration++) {
      const pending = f.ctx.db.one<{ id: string }>("SELECT id FROM order_cancel_requests WHERE state='pending'")!
      assert.equal((await f.withdraw(id, pending.id)).status, 200)
      assert.equal((await f.request(id)).status, 200)
    }
    assert.equal(f.stock(), 19)
    assert.equal(f.order(id).state, 2)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM refunds')!.count, 0)
    assert.equal(f.ctx.db.one<{ sequence: number }>("SELECT sequence FROM order_cancel_requests WHERE state='pending'")!.sequence, 5)
  } finally { await f.ctx.app.close() }
})

test('B-62 B-64 B-79 RED4：商家同意原子取消、单次释放和原支付退款通知', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const request = (await f.request(id)).body.result
    const requestKey = randomUUID()
    const result = await f.resolve(id, request.cancelRequestId, 'approve', undefined, requestKey)
    assert.equal(result.status, 200)
    assert.equal(result.body.result.appliedState, 'approved')
    assert.equal(f.order(id).state, 6)
    assert.equal(f.order(id).shipped_at, null)
    assert.equal(f.stock(), 20)
    const refund = f.ctx.db.one<{ id: string; reason: string; amount: number; state: string }>('SELECT * FROM refunds')!
    assert.equal(refund.reason, 'cancelled')
    assert.equal(refund.amount, 2475)
    assert.equal(result.body.result.refundId, refund.id)
    assert.deepEqual((await f.resolve(id, request.cancelRequestId, 'approve', undefined, requestKey)).body.result, result.body.result)
    assert.equal((await f.resolve(id, request.cancelRequestId)).status, 409)
    assert.equal(f.ctx.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM inventory_movements WHERE kind='cancel'")!.count, 1)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM payment_notices')!.count, 1)
    await f.ctx.payments.reconcile()
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM refunds')!.state, 'succeeded')
    assert.equal((await f.call('GET', '/merchant/orders/page', f.merchant.token)).body.result.counts, 0)
  } finally { await f.ctx.app.close() }
})

test('B-75 B-63 RED5：拒绝须填原因并原子发货，同号异参冲突', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const requestId = (await f.request(id)).body.result.cancelRequestId
    assert.equal((await f.resolve(id, requestId, 'reject-and-ship', '   ')).body.reason, 'CANCEL_REASON_REQUIRED')
    assert.equal((await f.resolve(id, requestId, 'reject-and-ship', '字'.repeat(201))).body.reason, 'CANCEL_REASON_TOO_LONG')
    assert.equal(f.order(id).state, 2)
    const requestKey = randomUUID()
    const response = await f.resolve(id, requestId, 'reject-and-ship', ' 已打包 ', requestKey)
    assert.equal(response.status, 200)
    assert.equal(response.body.result.appliedState, 'rejected-shipped')
    assert.equal(f.order(id).state, 3)
    assert.equal(f.order(id).shipped_at, f.clock.now())
    assert.equal(f.stock(), 19)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM refunds')!.count, 0)
    assert.equal(f.ctx.db.one<{ reject_reason: string }>('SELECT reject_reason FROM order_cancel_requests')!.reject_reason, '已打包')
    assert.deepEqual((await f.resolve(id, requestId, 'reject-and-ship', '已打包', requestKey)).body.result, response.body.result)
    assert.equal((await f.resolve(id, requestId, 'reject-and-ship', '已交物流', requestKey)).body.reason, 'CANCEL_REQUEST_KEY_CONFLICT')
    assert.equal((await f.request(id)).body.msg, '已发货，请联系售后')
    assert.equal((await f.resolve(id, requestId)).status, 409)
  } finally { await f.ctx.app.close() }
})

test('B-63 B-77 RED6：普通发货与申请两种落库顺序及已取消提示', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const requestId = (await f.request(id)).body.result.cancelRequestId
    assert.equal((await f.call('POST', '/merchant/orders/' + id + '/ship', f.merchant.token)).body.msg, '买家已申请取消，请先处理取消申请')
    assert.equal(f.order(id).state, 2)
    await f.resolve(id, requestId)
    assert.equal((await f.call('POST', '/merchant/orders/' + id + '/ship', f.merchant.token)).body.msg, '买家已取消，不能发货')
    const shipped = await f.create()
    assert.equal((await f.call('POST', '/merchant/orders/' + shipped + '/ship', f.merchant.token)).status, 200)
    assert.equal((await f.request(shipped)).body.msg, '已发货，请联系售后')
    assert.equal(f.order(shipped).state, 3)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM refunds')!.count, 1)
  } finally { await f.ctx.app.close() }
})

test('B-76 B-63 RED7：72小时硬截止，迟到撤回先自动同意且事务不回滚', async () => {
  const f = await fixture()
  try {
    const before = await f.create()
    const beforeRequest = (await f.request(before)).body.result.cancelRequestId
    const equal = await f.create()
    const equalRequest = (await f.request(equal)).body.result.cancelRequestId
    const after = await f.create()
    const afterRequest = (await f.request(after)).body.result.cancelRequestId
    f.advance(deadlineMs - 1)
    f.renew()
    assert.equal((await f.withdraw(before, beforeRequest)).status, 200)
    f.advance(1)
    const atDeadline = await f.withdraw(equal, equalRequest)
    assert.equal(atDeadline.status, 409)
    assert.equal(atDeadline.body.reason, 'CANCEL_REQUEST_EXPIRED')
    assert.equal(f.order(equal).state, 6)
    f.advance(1)
    assert.equal((await f.resolve(after, afterRequest, 'reject-and-ship', '已打包')).body.reason, 'CANCEL_REQUEST_EXPIRED')
    assert.equal(f.order(after).state, 6)
    assert.equal(f.order(after).shipped_at, null)
    assert.equal(f.stock(), 19)
    assert.equal(f.ctx.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM order_cancel_actions WHERE action='auto-approve'")!.count, 2)
  } finally { await f.ctx.app.close() }
})

test('B-78 B-79 RED8：共用恢复接口只读当前操作者回执且不清提醒', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const buyerKey = randomUUID()
    const requested = (await f.request(id, buyerKey)).body.result
    const merchantKey = randomUUID()
    const approved = (await f.resolve(id, requested.cancelRequestId, 'approve', undefined, merchantKey)).body.result
    const path = '/order-cancel-actions/by-request/'
    assert.equal((await f.call('GET', path + buyerKey)).status, 200)
    assert.deepEqual((await f.call('GET', path + buyerKey)).body.result, requested)
    assert.deepEqual((await f.call('GET', path + merchantKey, f.merchant.token)).body.result, approved)
    assert.equal((await f.call('GET', path + buyerKey, f.merchant.token)).status, 404)
    assert.equal((await f.call('GET', path + merchantKey)).status, 404)
    assert.equal((await f.call('GET', path + randomUUID())).status, 404)
    assert.equal((await f.call('GET', path + buyerKey, '')).status, 401)
    assert.equal((await f.call('GET', '/member/order/attention')).body.result.count, 1)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM order_cancel_actions')!.count, 2)
    assert.equal((await f.call('GET', '/member/order/' + id + '/cancel-actions/by-request/' + buyerKey)).status, 404)
  } finally { await f.ctx.app.close() }
})

test('B-65 B-73 B-75 RED9：订单和商家投影、代付确认金额去向与能力隔离', async () => {
  const f = await fixture()
  try {
    const id = await f.create(false)
    f.ctx.testData.relation({ ownerId: f.buyer.id, friendId: f.payer.id })
    assert.equal((await f.call('PUT', '/member/order/' + id + '/payer', f.buyer.token, { friendId: f.payer.id })).status, 200)
    assert.equal((await f.call('POST', '/member/order/' + id + '/mock-pay', f.payer.token, { amountCents })).status, 200)
    const buyer = (await f.call('GET', '/member/order/' + id)).body.result
    assert.equal(buyer.canRequestCancel, true)
    assert.equal(buyer.canCancel, false)
    assert.equal(buyer.cancelConfirmation.amountCents, 2475)
    assert.equal(buyer.cancelConfirmation.message, '取消申请提交后，商家同意即不再发货，¥24.75将原路退回亲友 ' + f.payer.account + ' 的付款账户。确定申请取消吗？')
    const requestId = (await f.request(id)).body.result.cancelRequestId
    const pending = (await f.call('GET', '/member/order/' + id)).body.result
    assert.equal(pending.cancelRequest.state, 'pending')
    assert.equal(pending.canRequestCancel, false)
    assert.equal(pending.canWithdrawCancel, true)
    assert.equal(pending.cancelRequestNotice.includes('取消申请审核中'), true)
    assert.equal((await f.call('GET', '/member/order?orderState=2')).body.result.counts, 1)
    const family = (await f.call('GET', '/member/order/' + id, f.payer.token)).body.result
    assert.equal(family.canWithdrawCancel, false)
    assert.equal(family.canRequestCancel, false)
    assert.equal(family.address, undefined)
    const merchant = (await f.call('GET', '/merchant/orders/page', f.merchant.token)).body.result
    assert.equal(merchant.counts, 1)
    assert.equal(merchant.items[0].canResolveCancel, true)
    assert.equal(merchant.items[0].canShip, false)
    assert.equal(merchant.items[0].cancelRequestNotice.includes('买家申请取消'), true)
    await f.resolve(id, requestId, 'reject-and-ship', '已交物流')
    const rejected = (await f.call('GET', '/member/order/' + id)).body.result
    assert.equal(rejected.cancelRequest.rejectReason, '已交物流')
    assert.equal(rejected.cancelRequestNotice.includes('如有问题请联系客服'), true)
    assert.equal(rejected.canRequestCancel, false)
  } finally { await f.ctx.app.close() }
})

test('B-80 RED10：版本8备份统计、合法取消不误报并恢复到期申请', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-cancel-backup-'))
  const path = join(root, 'live', 'mall.sqlite')
  const f = await fixture(path)
  try {
    const approvedId = await f.create()
    const requestId = (await f.request(approvedId)).body.result.cancelRequestId
    await f.resolve(approvedId, requestId)
    const pendingId = await f.create()
    await f.request(pendingId)
    const backup = await createBackup({ databasePath: path, uploadsPath: join(root, 'live', 'uploads'), destination: join(root, 'snapshot') })
    assert.equal(backup.manifest.schemaVersion, 14)
    assert.deepEqual(backup.manifest.issues, [])
    assert.equal(backup.counts.order_cancel_requests, 2)
    assert.equal(backup.counts.order_cancel_actions, 3)
    assert.equal(backup.counts.payment_notices, 1)
    assert.equal(backup.counts.payment_review_resolutions, 0)
    assert.deepEqual((await verifyBackup(backup.root)).counts, backup.counts)
    const restored = await restoreBackup({ backupPath: backup.root, destination: join(root, 'restored') })
    f.advance(deadlineMs)
    const next = await buildApp({ databasePath: join(restored.root, 'mall.sqlite'), uploadsPath: join(restored.root, 'uploads'), publicUrl: 'http://localhost', mockPayments: true, clock: f.clock })
    try {
      assert.equal(next.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', pendingId)!.state, 6)
      assert.equal(next.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM refunds')!.count, 2)
      assert.deepEqual(await next.orders.processDueCancelRequests(), { processed: 0, failed: [] })
      assert.equal(next.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM inventory_movements WHERE kind IN ('cancel','expire')")!.count, 2)
      assert.equal(next.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM sessions')!.count, 0)
    } finally { await next.app.close() }
  } finally { await f.ctx.app.close(); await rm(root, { recursive: true, force: true }) }
})

test('B-80 RED11：备份不放行申请与订单状态或操作者错配', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-cancel-invalid-'))
  const path = join(root, 'live', 'mall.sqlite')
  const f = await fixture(path)
  try {
    const id = await f.create()
    await f.request(id)
    f.ctx.db.run('UPDATE orders SET state=3,shipped_at=? WHERE id=?', f.clock.now(), id)
    const broken = await createBackup({ databasePath: path, uploadsPath: join(root, 'uploads'), destination: join(root, 'broken-state') })
    assert.ok(broken.manifest.issues.some(issue => issue.type === 'cancel-request-mismatch' && issue.orderId === id))
    await assert.rejects(restoreBackup({ backupPath: broken.root, destination: join(root, 'rejected') }), /不一致/)
    f.ctx.db.run('UPDATE orders SET state=2,shipped_at=NULL WHERE id=?', id)
    f.ctx.db.run('UPDATE order_cancel_actions SET actor_id=?', f.payer.id)
    const actor = await createBackup({ databasePath: path, uploadsPath: join(root, 'uploads'), destination: join(root, 'broken-actor') })
    assert.ok(actor.manifest.issues.some(issue => issue.type === 'cancel-request-mismatch' && issue.orderId === id))
  } finally { await f.ctx.app.close(); await rm(root, { recursive: true, force: true }) }
})

test('B-80：真实版本7数据升级12，退款新增售后关联且旧数据和引用保留，重启不重复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-cancel-migration-'))
  const path = join(root, 'live', 'mall.sqlite')
  const f = await fixture(path)
  try {
    await f.create()
    const cancelled = await f.create(false)
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'close-paid' } })
    await f.call('POST', '/member/order/' + cancelled + '/payments', f.buyer.token, { amountCents })
    await f.call('PUT', '/member/order/' + cancelled + '/cancel')
    const refund = f.ctx.db.one<{ id: string }>('SELECT id FROM refunds')!
    f.ctx.db.run('INSERT INTO refund_retry_actions(refund_id,merchant_id,request_key,created) VALUES(?,?,?,?)', refund.id, f.merchant.id, randomUUID(), f.clock.now())
  } finally { await f.ctx.app.close() }
  try {
    const raw = new DatabaseSync(path)
    removeAfterSaleSchema(raw)
    raw.exec('DROP TRIGGER product_revision_sku_update; DROP TRIGGER product_revision_sku_insert; DROP TRIGGER product_revision_fields; DROP INDEX product_enabled_spec; DROP TABLE product_changes; DROP TABLE product_images; ALTER TABLE skus DROP COLUMN enabled; ALTER TABLE products DROP COLUMN revision; ALTER TABLE products DROP COLUMN status; DROP TABLE cart_requests; DROP TABLE order_cancel_actions; DROP TABLE order_cancel_requests; PRAGMA user_version=7')
    const preserved = ['payments', 'refunds', 'payment_notices', 'refund_retry_actions', 'payment_review_resolutions']
    const before = Object.fromEntries(preserved.map(table => [table, raw.prepare('SELECT * FROM ' + table + ' ORDER BY id').all()]))
    const schemas = raw.prepare("SELECT name,sql FROM sqlite_master WHERE name IN ('payment_notices','refund_retry_actions') ORDER BY name").all()
    raw.close()
    const oldBackup = await createBackup({ databasePath: path, uploadsPath: join(root, 'live', 'uploads'), destination: join(root, 'v7') })
    assert.equal(oldBackup.manifest.schemaVersion, 7)
    for (let startup = 0; startup < 2; startup++) {
      const migrated = new Database(path)
      try {
        assert.equal(migrated.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 14)
        for (const table of preserved) assert.deepEqual(migrated.all('SELECT * FROM ' + table + ' ORDER BY id'), table === 'refunds' ? before[table]!.map(row=>Object.assign(Object.create(null),row,{after_sale_id:null,completed_at:null})) : before[table])
        assert.deepEqual(migrated.all("SELECT name,sql FROM sqlite_master WHERE name IN ('payment_notices','refund_retry_actions') ORDER BY name"), schemas)
        assert.equal(migrated.one<{ count: number }>('SELECT COUNT(*) AS count FROM order_cancel_requests')!.count, 0)
        assert.deepEqual(migrated.all('PRAGMA foreign_key_check'), [])
      } finally { migrated.close() }
    }
    const oldRestore = await restoreBackup({ backupPath: oldBackup.root, destination: join(root, 'old-restored') })
    const upgraded = new Database(join(oldRestore.root, 'mall.sqlite'))
    try { assert.equal(upgraded.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 14) } finally { upgraded.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('B-80：008中途失败回滚已建表索引及版本，修复后可重试', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-cancel-rollback-'))
  const path = join(root, 'mall.sqlite')
  try {
    new Database(path).close()
    const raw = new DatabaseSync(path)
    removeAfterSaleSchema(raw)
    raw.exec("DROP TRIGGER product_revision_sku_update; DROP TRIGGER product_revision_sku_insert; DROP TRIGGER product_revision_fields; DROP INDEX product_enabled_spec; DROP TABLE product_changes; DROP TABLE product_images; ALTER TABLE skus DROP COLUMN enabled; ALTER TABLE products DROP COLUMN revision; ALTER TABLE products DROP COLUMN status; DROP TABLE cart_requests; DROP TABLE order_cancel_actions; DROP TABLE order_cancel_requests; PRAGMA user_version=7; CREATE TABLE order_cancel_actions(sentinel TEXT); INSERT INTO order_cancel_actions VALUES('保留')")
    raw.close()
    assert.throws(() => new Database(path), /already exists/)
    const inspected = new DatabaseSync(path)
    try {
      assert.equal(inspected.prepare('PRAGMA user_version').get()!.user_version, 7)
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('order_cancel_requests','order_cancel_one_pending','order_cancel_due')").get()!.count, 0)
      assert.equal(inspected.prepare('SELECT sentinel FROM order_cancel_actions').get()!.sentinel, '保留')
      inspected.exec('DROP TABLE order_cancel_actions')
    } finally { inspected.close() }
    const recovered = new Database(path)
    try { assert.equal(recovered.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 14) } finally { recovered.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('B-73 B-74：取消表拒绝双pending、非法终态和无操作者撤回', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const requestId = (await f.request(id)).body.result.cancelRequestId
    const row = f.ctx.db.one<{ payment_id: string }>('SELECT payment_id FROM order_cancel_requests WHERE id=?', requestId)!
    assert.throws(() => f.ctx.db.run("INSERT INTO order_cancel_requests(id,order_id,sequence,requested_by,payment_id,state,created,deadline_at) VALUES(?,?,?,?,?,'pending',?,?)", randomUUID(), id, 2, f.buyer.id, row.payment_id, f.clock.now(), f.clock.now() + deadlineMs), /UNIQUE/)
    assert.throws(() => f.ctx.db.run("UPDATE order_cancel_requests SET state='approved' WHERE id=?", requestId), /CHECK/)
    assert.throws(() => f.ctx.db.run("UPDATE order_cancel_requests SET state='withdrawn',resolved_at=?,resolved_by=NULL WHERE id=?", f.clock.now(), requestId), /CHECK/)
  } finally { await f.ctx.app.close() }
})

test('B-63：撤回、同意、拒绝发货按两种提交顺序裁决且不复活旧申请', async () => {
  const f = await fixture()
  try {
    for (const pair of [['withdraw', 'approve'], ['withdraw', 'reject-and-ship'], ['approve', 'reject-and-ship']]) {
      for (const sequence of [pair, [...pair].reverse()]) {
        const id = await f.create()
        const requestId = (await f.request(id)).body.result.cancelRequestId
        const act = (action: string) => action === 'withdraw' ? f.withdraw(id, requestId) : f.resolve(id, requestId, action, action === 'reject-and-ship' ? '已打包' : undefined)
        assert.equal((await act(sequence[0]!)).status, 200)
        assert.equal((await act(sequence[1]!)).status, 409)
        const expected = sequence[0] === 'approve' ? 6 : sequence[0] === 'reject-and-ship' ? 3 : 2
        assert.equal(f.order(id).state, expected)
        assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.order_id=?', id)!.count, expected === 6 ? 1 : 0)
        if (expected === 2) {
          const next = (await f.request(id)).body.result.cancelRequestId
          assert.notEqual(next, requestId)
          assert.equal((await f.resolve(id, requestId)).body.reason, 'CANCEL_REQUEST_WITHDRAWN')
          assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM order_cancel_requests WHERE id=?', next)!.state, 'pending')
        }
      }
    }
  } finally { await f.ctx.app.close() }
})

test('B-76：注入时钟驱动截止前1毫秒、到点、后1毫秒扫描且不重复释放', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    await f.request(id)
    f.advance(deadlineMs - 1)
    assert.deepEqual(await f.ctx.orders.processDueCancelRequests(), { processed: 0, failed: [] })
    assert.equal(f.order(id).state, 2)
    f.advance(1)
    assert.deepEqual(await f.ctx.orders.processDueCancelRequests(), { processed: 1, failed: [] })
    f.advance(1)
    assert.deepEqual(await f.ctx.orders.processDueCancelRequests(), { processed: 0, failed: [] })
    assert.equal(f.order(id).state, 6)
    assert.equal(f.stock(), 20)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM refunds')!.count, 1)
    assert.equal(f.ctx.db.one<{ actor_id: string | null }>("SELECT actor_id FROM order_cancel_actions WHERE action='auto-approve'")!.actor_id, null)
  } finally { await f.ctx.app.close() }
})

test('B-76：原30秒timer驱动自动同意，无需真实等待', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] })
  const f = await fixture()
  try {
    const id = await f.create()
    await f.request(id)
    f.advance(deadlineMs)
    context.mock.timers.tick(30_000)
    assert.equal(f.order(id).state, 6)
    await f.ctx.payments.reconcile()
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM refunds')!.state, 'succeeded')
    context.mock.timers.tick(30_000)
    await f.ctx.payments.reconcile()
    assert.equal(f.stock(), 20)
  } finally { await f.ctx.app.close(); context.mock.timers.reset() }
})

test('B-63 B-76 B-77：到点普通发货先自动取消，人工同意不能抢过硬截止', async () => {
  const f = await fixture()
  try {
    const ids = [await f.create(), await f.create(), await f.create()]
    const requests: string[] = []
    for (const id of ids) requests.push((await f.request(id)).body.result.cancelRequestId)
    f.advance(deadlineMs - 1)
    f.renew()
    assert.equal((await f.resolve(ids[0]!, requests[0]!)).status, 200)
    f.advance(1)
    const due = (await f.call('GET', '/member/order/' + ids[1])).body.result
    assert.equal(due.canWithdrawCancel, false)
    assert.equal(due.cancelRequestNotice, '已到自动处理时间，正在处理')
    assert.equal((await f.call('POST', '/merchant/orders/' + ids[1] + '/ship', f.merchant.token)).body.msg, '买家已取消，不能发货')
    assert.equal((await f.resolve(ids[2]!, requests[2]!)).body.reason, 'CANCEL_REQUEST_EXPIRED')
    assert.deepEqual(await f.ctx.orders.processDueCancelRequests(), { processed: 0, failed: [] })
    assert.equal(f.stock(), 20)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM refunds')!.count, 3)
  } finally { await f.ctx.app.close() }
})

test('B-64：取消退款失败沿原号自动重试，不恢复订单或重复提醒', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const paymentId = f.ctx.db.one<{ id: string }>('SELECT id FROM payments WHERE order_id=?', id)!.id
    f.ctx.testData.payments({ paymentId, preset: { outcome: 'success', refundFailures: 1 } })
    const requestId = (await f.request(id)).body.result.cancelRequestId
    const refundId = (await f.resolve(id, requestId)).body.result.refundId
    await f.ctx.payments.reconcile()
    const pending = (await f.call('GET', '/member/order')).body.result.items[0]
    assert.equal(pending.refunds[0].state, '退款失败重试中')
    assert.equal(pending.paymentNotice.includes('退款处理中，系统会自动重试，无需操作。'), true)
    f.advance(59_999)
    await f.ctx.payments.reconcile()
    assert.equal(f.ctx.db.one<{ attempts: number }>('SELECT attempts FROM refunds')!.attempts, 1)
    f.advance(1)
    await f.ctx.payments.reconcile()
    const final = f.ctx.db.one<{ id: string; attempts: number; state: string }>('SELECT id,attempts,state FROM refunds')!
    assert.equal(final.id, refundId)
    assert.equal(final.attempts, 2)
    assert.equal(final.state, 'succeeded')
    assert.equal(f.order(id).state, 6)
    assert.equal(f.stock(), 20)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM payment_notices')!.count, 1)
  } finally { await f.ctx.app.close() }
})

test('B-64 B-65 B-79：亲友退款24小时转人工、原号商家重试与各自红点', async () => {
  const f = await fixture()
  try {
    const id = await f.create(false)
    f.ctx.testData.relation({ ownerId: f.buyer.id, friendId: f.payer.id })
    await f.call('PUT', '/member/order/' + id + '/payer', f.buyer.token, { friendId: f.payer.id })
    const payment = await f.call('POST', '/member/order/' + id + '/mock-pay', f.payer.token, { amountCents })
    const paymentId = payment.body.result.paymentId
    f.ctx.testData.payments({ paymentId, preset: { outcome: 'success', refundFailures: 100 } })
    const requestId = (await f.request(id)).body.result.cancelRequestId
    assert.equal((await f.call('POST', '/member/order/' + id + '/cancel-requests/' + requestId + '/withdraw', f.payer.token, { requestKey: randomUUID() })).status, 403)
    f.ctx.db.run('DELETE FROM relations')
    const refundId = (await f.resolve(id, requestId)).body.result.refundId
    assert.equal(f.ctx.db.one<{ payer_id: string }>('SELECT p.payer_id FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE r.id=?', refundId)!.payer_id, f.payer.id)
    for (const token of [f.buyer.token, f.payer.token]) assert.equal((await f.call('GET', '/member/order/attention', token)).body.result.count, 1)
    await f.call('GET', '/member/order/' + id)
    assert.equal((await f.call('GET', '/member/order/attention')).body.result.count, 0)
    assert.equal((await f.call('GET', '/member/order/attention', f.payer.token)).body.result.count, 1)
    await f.call('GET', '/member/order/' + id, f.payer.token)
    await f.ctx.payments.reconcile()
    f.advance(24 * 3600_000)
    f.renew()
    await f.ctx.payments.reconcile()
    const manual = f.ctx.db.one<{ review_at: number; next_attempt_at: number | null; attempts: number }>('SELECT * FROM refunds')!
    assert.equal(manual.review_at, f.clock.now())
    assert.equal(manual.next_attempt_at, null)
    assert.equal((await f.call('GET', '/merchant/payments/review', f.merchant.token)).body.result.items[0].kind, 'refund')
    for (const token of [f.buyer.token, f.payer.token]) assert.equal((await f.call('GET', '/member/order/attention', token)).body.result.count, 1)
    f.advance(3600_000)
    await f.ctx.payments.reconcile()
    assert.equal(f.ctx.db.one<{ attempts: number }>('SELECT attempts FROM refunds')!.attempts, manual.attempts)
    f.ctx.testData.payments({ paymentId, preset: { outcome: 'success', refundFailures: 0 } })
    const requestKey = randomUUID()
    for (let retry = 0; retry < 2; retry++) assert.equal((await f.call('POST', '/merchant/refunds/' + refundId + '/retry', f.merchant.token, { requestKey })).status, 200)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM refund_retry_actions')!.count, 1)
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM refunds')!.state, 'succeeded')
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM payment_notices')!.count, 4)
    const family = (await f.call('GET', '/member/family-orders/page', f.payer.token)).body.result.items[0]
    assert.equal(family.refunds[0].reason, 'cancelled')
    assert.equal(family.paymentNotice.includes('已原路退回付款账户。'), true)
    assert.equal(f.stock(), 20)
  } finally { await f.ctx.app.close() }
})

test('B-81：待付款/确认中旧取消保持不变，成功先落库须重新明确申请', async () => {
  const f = await fixture()
  try {
    const unpaid = await f.create(false)
    assert.equal((await f.request(unpaid)).body.reason, 'CANCEL_NOT_AVAILABLE')
    assert.equal((await f.call('PUT', '/member/order/' + unpaid + '/cancel')).status, 200)
    const confirming = await f.create(false)
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    const payment = await f.call('POST', '/member/order/' + confirming + '/payments', f.buyer.token, { amountCents })
    assert.equal((await f.request(confirming)).body.reason, 'CANCEL_NOT_AVAILABLE')
    assert.equal((await f.call('PUT', '/member/order/' + confirming + '/cancel')).status, 200)
    f.ctx.testData.payments({ paymentId: payment.body.result.paymentId, preset: { outcome: 'success' } })
    await f.call('POST', '/payments/callback', '', f.ctx.payments.signedCallback(payment.body.result.paymentId, { state: 'success' }))
    assert.equal(f.order(confirming).state, 6)
    const paidFirst = await f.create(false)
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    const second = await f.call('POST', '/member/order/' + paidFirst + '/payments', f.buyer.token, { amountCents })
    f.ctx.testData.payments({ paymentId: second.body.result.paymentId, preset: { outcome: 'success' } })
    await f.call('POST', '/payments/callback', '', f.ctx.payments.signedCallback(second.body.result.paymentId, { state: 'success' }))
    assert.equal((await f.call('PUT', '/member/order/' + paidFirst + '/cancel')).status, 409)
    assert.equal(f.order(paidFirst).state, 2)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM order_cancel_requests')!.count, 0)
    assert.equal((await f.request(paidFirst)).status, 200)
    assert.equal(f.stock(), 19)
  } finally { await f.ctx.app.close() }
})

test('B-65 B-79 B-81 B-82：多笔付款不换锁定支付，受限亲友不获取消信息', async () => {
  const f = await fixture()
  try {
    const id = await f.create(false)
    f.ctx.testData.relation({ ownerId: f.buyer.id, friendId: f.payer.id })
    await f.call('PUT', '/member/order/' + id + '/payer', f.buyer.token, { friendId: f.payer.id })
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'fail' } })
    const first = await f.call('POST', '/member/order/' + id + '/payments', f.payer.token, { amountCents })
    await f.call('PUT', '/member/order/' + id + '/payer', f.buyer.token, { friendId: null })
    const valid = await f.call('POST', '/member/order/' + id + '/mock-pay', f.buyer.token, { amountCents })
    const requestId = (await f.request(id)).body.result.cancelRequestId
    const limited = (await f.call('GET', '/member/order/' + id, f.payer.token)).body.result
    assert.deepEqual(limited.skus, [])
    assert.equal(limited.cancelRequest, null)
    assert.equal(limited.cancelConfirmation, null)
    assert.equal(limited.cancelRequestNotice, '')
    for (const field of ['canRequestCancel', 'canWithdrawCancel', 'canResolveCancel', 'canShip']) assert.equal(limited[field], false)
    f.ctx.testData.payments({ paymentId: first.body.result.paymentId, preset: { outcome: 'success' } })
    await f.call('POST', '/payments/callback', '', f.ctx.payments.signedCallback(first.body.result.paymentId, { state: 'success' }))
    await f.call('POST', '/payments/callback', '', f.ctx.payments.signedCallback(valid.body.result.paymentId, { state: 'success' }))
    assert.equal(f.ctx.db.one<{ payment_id: string }>('SELECT payment_id FROM order_cancel_requests')!.payment_id, valid.body.result.paymentId)
    const refundId = (await f.resolve(id, requestId)).body.result.refundId
    assert.equal(f.ctx.db.one<{ payment_id: string }>('SELECT payment_id FROM refunds WHERE id=?', refundId)!.payment_id, valid.body.result.paymentId)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM refunds')!.count, 2)
    assert.equal((await f.call('GET', '/member/order/' + id, f.payer.token)).body.result.refunds.length, 1)
    assert.equal((await f.call('GET', '/member/order/' + id)).body.result.refunds.length, 2)
  } finally { await f.ctx.app.close() }
})

test('B-82：库存、退款、通知、回执任一写入失败整单回滚，同号可重试', async () => {
  const f = await fixture()
  try {
    for (const table of ['inventory_movements', 'refunds', 'payment_notices', 'order_cancel_actions']) {
      const id = await f.create()
      const requestId = (await f.request(id)).body.result.cancelRequestId
      const requestKey = randomUUID()
      const beforeStock = f.stock()
      const beforeRefunds = f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM refunds')!.count
      f.ctx.db.run('CREATE TRIGGER cancellation_failure BEFORE INSERT ON ' + table + " BEGIN SELECT RAISE(ABORT,'injected cancellation failure'); END")
      assert.equal((await f.resolve(id, requestId, 'approve', undefined, requestKey)).status, 500)
      assert.equal(f.order(id).state, 2)
      assert.equal(f.stock(), beforeStock)
      assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM order_cancel_requests WHERE id=?', requestId)!.state, 'pending')
      assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM refunds')!.count, beforeRefunds)
      assert.equal((await f.call('GET', '/order-cancel-actions/by-request/' + requestKey, f.merchant.token)).status, 404)
      f.ctx.db.run('DROP TRIGGER cancellation_failure')
      assert.equal((await f.resolve(id, requestId, 'approve', undefined, requestKey)).status, 200)
      assert.equal(f.stock(), 20)
    }
  } finally { await f.ctx.app.close() }
})

test('B-76 B-82：异常到期申请整体回滚，不阻塞其他申请，修复后重试一次', async () => {
  const f = await fixture()
  try {
    const blockedId = await f.create()
    const blocked = (await f.request(blockedId)).body.result.cancelRequestId
    const validId = await f.create()
    await f.request(validId)
    const payment = f.ctx.db.one<{ payment_id: string }>('SELECT payment_id FROM order_cancel_requests WHERE id=?', blocked)!.payment_id
    f.ctx.db.run("CREATE TRIGGER cancel_auto_failure BEFORE INSERT ON refunds WHEN NEW.payment_id='" + payment + "' BEGIN SELECT RAISE(ABORT,'injected'); END")
    f.advance(deadlineMs)
    const result = await f.ctx.orders.processDueCancelRequests()
    assert.equal(result.processed, 1)
    assert.deepEqual(result.failed, [blocked])
    assert.equal(f.order(blockedId).state, 2)
    assert.equal(f.order(validId).state, 6)
    assert.equal(f.stock(), 19)
    f.ctx.db.run('DROP TRIGGER cancel_auto_failure')
    assert.deepEqual(await f.ctx.orders.processDueCancelRequests(), { processed: 1, failed: [] })
    assert.equal(f.stock(), 20)
  } finally { await f.ctx.app.close() }
})

test('B-62 B-65 B-73 B-78：接口参数、权限、跨订单请求号和不存在错误契约', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const requestKey = randomUUID()
    for (const payload of [{ requestKey: 'bad' }, { requestKey, amountCents: 1 }, { requestKey, payerId: f.payer.id }]) {
      assert.equal((await f.call('POST', '/member/order/' + id + '/cancel-requests', f.buyer.token, payload)).status, 400)
    }
    assert.equal((await f.request(id, requestKey, '')).status, 401)
    const requestId = (await f.request(id, requestKey)).body.result.cancelRequestId
    const target = '/merchant/orders/' + id + '/cancel-requests/' + requestId + '/resolve'
    assert.equal((await f.call('POST', target, f.buyer.token, { requestKey: randomUUID(), decision: 'approve' })).body.reason, 'MERCHANT_REQUIRED')
    assert.equal((await f.call('POST', target, f.merchant.token, { requestKey: randomUUID(), decision: 'reject' })).status, 400)
    assert.equal((await f.call('POST', target, f.merchant.token, { requestKey: randomUUID(), decision: 'approve', reason: '夹带' })).status, 400)
    const other = await f.create()
    assert.equal((await f.request(other, requestKey)).body.reason, 'CANCEL_REQUEST_KEY_CONFLICT')
    assert.equal((await f.resolve(other, requestId)).body.reason, 'CANCEL_REQUEST_NOT_FOUND')
    assert.equal((await f.request(randomUUID())).body.reason, 'ORDER_NOT_FOUND')
    assert.equal((await f.withdraw(id, randomUUID())).body.reason, 'CANCEL_REQUEST_NOT_FOUND')
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM order_cancel_requests')!.count, 1)
    assert.equal(f.stock(), 18)
  } finally { await f.ctx.app.close() }
})

test('B-82：同意提交后渠道异常仍保持取消，后续沿同一退款号恢复', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const requestId = (await f.request(id)).body.result.cancelRequestId
    const channel = f.ctx.payments.channel!
    const originalRefund = channel.refund.bind(channel)
    channel.refund = () => { throw new Error('外部退款渠道暂不可用') }
    assert.equal((await f.resolve(id, requestId)).status,200)
    const approved = f.ctx.db.one<{refundId:string}>('SELECT refund_id AS refundId FROM order_cancel_requests WHERE id=?',requestId)!
    const deferred = f.ctx.db.one<{id:string;state:string;attempts:number;next_attempt_at:number}>('SELECT * FROM refunds')!
    assert.equal(deferred.id,approved.refundId)
    assert.equal(deferred.state,'pending')
    assert.equal(deferred.attempts,1)
    assert.ok(deferred.next_attempt_at>f.clock.now())
    assert.equal(f.order(id).state, 6)
    assert.equal(f.stock(), 20)
    channel.refund = originalRefund
    f.advance(60_000)
    await f.ctx.payments.reconcile()
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM refunds')!.state, 'succeeded')
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM refunds')!.count, 1)
  } finally { await f.ctx.app.close() }
})

test('B-82：已付款取消退款渠道超时后接口返回且订单显示退款中', async t => {
  const f = await fixture()
  try {
    const realSetTimeout = globalThis.setTimeout.bind(globalThis)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const id = await f.create()
    const requestId = (await f.request(id)).body.result.cancelRequestId
    let called = false
    f.ctx.payments.channel!.refund = () => { called = true; return new Promise(() => {}) }
    const action = f.resolve(id, requestId)
    for (let i = 0; i < 100 && !called; i++) await new Promise<void>(resolve => setImmediate(resolve))
    assert.ok(called, '取消操作没有调用退款渠道')
    t.mock.timers.tick(15_000)
    await new Promise<void>(resolve => setImmediate(resolve))
    const result = await Promise.race([action, new Promise<null>(resolve => realSetTimeout(() => resolve(null), 1_000))])
    assert.ok(result, '取消接口因退款渠道无响应而挂起')
    assert.equal(result.status, 200)
    const refund = f.ctx.db.one<{ id: string; state: string; attempts: number; next_attempt_at: number }>('SELECT * FROM refunds')!
    assert.equal(refund.state, 'pending')
    assert.equal(refund.attempts, 1)
    assert.ok(refund.next_attempt_at > f.clock.now())
    const detail = (await f.call('GET', `/member/order/${id}`)).body.result
    assert.equal(detail.refunds[0].state, '退款中')
  } finally { await f.ctx.app.close() }
})

test('B-78 B-82：提交后进程重启仍能查原回执，重放不创建第二申请或退款', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-cancel-restart-'))
  const path = join(root, 'mall.sqlite')
  const f = await fixture(path)
  const requestKey = randomUUID()
  let id = ''
  let receipt: unknown
  try {
    id = await f.create()
    const response = await f.request(id, requestKey)
    receipt = response.body.result
    await f.resolve(id, response.body.result.cancelRequestId)
  } finally { await f.ctx.app.close() }
  try {
    const next = await buildApp({ databasePath: path, uploadsPath: join(root, 'uploads'), publicUrl: 'http://localhost', mockPayments: true, clock: f.clock })
    try {
      const headers = { authorization: 'Bearer ' + f.buyer.token }
      const restored = await next.app.inject({ method: 'GET', url: '/order-cancel-actions/by-request/' + requestKey, headers })
      assert.equal(restored.statusCode, 200)
      assert.deepEqual(restored.json().result, receipt)
      const replay = await next.app.inject({ method: 'POST', url: '/member/order/' + id + '/cancel-requests', headers, payload: { requestKey } })
      assert.deepEqual(replay.json().result, receipt)
      assert.equal(next.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', id)!.state, 6)
      assert.equal(next.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM order_cancel_requests')!.count, 1)
      assert.equal(next.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM refunds')!.count, 1)
    } finally { await next.app.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('B-80：已取消退款必须匹配原支付、全额且原因cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-cancel-refund-proof-'))
  const path = join(root, 'live', 'mall.sqlite')
  const f = await fixture(path)
  try {
    const id = await f.create()
    const requestId = (await f.request(id)).body.result.cancelRequestId
    await f.resolve(id, requestId)
    const paymentId = f.ctx.db.one<{ payment_id: string }>('SELECT payment_id FROM refunds')!.payment_id
    const other = await f.create()
    const otherPayment = f.ctx.db.one<{ id: string }>('SELECT id FROM payments WHERE order_id=?', other)!.id
    const corruptions = ["UPDATE refunds SET reason='duplicate'", 'UPDATE refunds SET amount=2474', "UPDATE refunds SET payment_id='" + otherPayment + "'"]
    // Model an externally corrupted backup after bypassing the new write guard.
    assert.throws(() => f.ctx.db.run(corruptions[0]!), /immutable/)
    f.ctx.db.run('DROP TRIGGER refunds_identity_update')
    for (const [index, sql] of corruptions.entries()) {
      f.ctx.db.run("UPDATE refunds SET reason='cancelled',amount=2475,payment_id=?", paymentId)
      f.ctx.db.run(sql)
      const snapshot = await createBackup({ databasePath: path, uploadsPath: join(root, 'uploads'), destination: join(root, 'corrupt-' + index) })
      assert.ok(snapshot.manifest.issues.some(issue => issue.type === 'payment-mismatch' && issue.orderId === id))
      assert.ok(snapshot.manifest.issues.some(issue => issue.type === 'cancel-request-mismatch' && issue.orderId === id))
    }
  } finally { await f.ctx.app.close(); await rm(root, { recursive: true, force: true }) }
})

test('B-62 B-63 B-82：无有效支付不能申请或处理，拒绝发货审计失败也回滚', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    f.ctx.db.run('UPDATE payments SET amount=2474 WHERE order_id=?', id)
    assert.equal((await f.request(id)).body.reason, 'CANCEL_PAYMENT_INVALID')
    assert.equal((await f.call('GET', '/member/order/' + id)).body.result.canRequestCancel, false)
    f.ctx.db.run('UPDATE payments SET amount=2475 WHERE order_id=?', id)
    const requestId = (await f.request(id)).body.result.cancelRequestId
    f.ctx.db.run('UPDATE payments SET amount=2474 WHERE order_id=?', id)
    assert.equal((await f.resolve(id, requestId)).body.reason, 'CANCEL_PAYMENT_INVALID')
    assert.equal((await f.resolve(id, requestId, 'reject-and-ship', '已打包')).body.reason, 'CANCEL_PAYMENT_INVALID')
    assert.equal(f.stock(), 19)
    f.ctx.db.run('UPDATE payments SET amount=2475 WHERE order_id=?', id)
    f.ctx.db.run("CREATE TRIGGER reject_audit_failure BEFORE INSERT ON order_cancel_actions BEGIN SELECT RAISE(ABORT,'injected'); END")
    assert.equal((await f.resolve(id, requestId, 'reject-and-ship', '已打包')).status, 500)
    assert.equal(f.order(id).state, 2)
    assert.equal(f.order(id).shipped_at, null)
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM order_cancel_requests')!.state, 'pending')
    f.ctx.db.run('DROP TRIGGER reject_audit_failure')
    assert.equal((await f.resolve(id, requestId, 'reject-and-ship', '已打包')).status, 200)
  } finally { await f.ctx.app.close() }
})

test('B-80：损坏唯一索引导致双pending时备份仍报告申请不一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-cancel-duplicate-'))
  const path = join(root, 'live', 'mall.sqlite')
  const f = await fixture(path)
  try {
    const id = await f.create()
    await f.request(id)
    const secondId = randomUUID()
    const actionId = randomUUID()
    f.ctx.db.run('DROP INDEX order_cancel_one_pending')
    f.ctx.db.run('INSERT INTO order_cancel_requests(id,order_id,sequence,requested_by,payment_id,state,created,deadline_at) SELECT ?,order_id,2,requested_by,payment_id,state,created,deadline_at FROM order_cancel_requests WHERE order_id=?', secondId, id)
    f.ctx.db.run('INSERT INTO order_cancel_actions(id,order_id,cancel_request_id,actor_id,action,request_key,request_body,result,created) VALUES(?,?,?,?,?,?,?,?,?)', actionId, id, secondId, f.buyer.id, 'request', randomUUID(), JSON.stringify({ orderId: id, action: 'request' }), JSON.stringify({ id: actionId, orderId: id, cancelRequestId: secondId, action: 'request', appliedState: 'pending', appliedAt: f.clock.now(), refundId: null }), f.clock.now())
    const snapshot = await createBackup({ databasePath: path, uploadsPath: join(root, 'uploads'), destination: join(root, 'duplicate') })
    assert.ok(snapshot.manifest.issues.some(issue => issue.type === 'cancel-request-mismatch' && issue.orderId === id))
  } finally { await f.ctx.app.close(); await rm(root, { recursive: true, force: true }) }
})
