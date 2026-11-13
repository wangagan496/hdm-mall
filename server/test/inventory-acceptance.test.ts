import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildTestApp } from './helpers/fixtures.ts'
import { withReturnShipping } from './helpers/return-shipping.ts'
import { buildApp } from '../src/app.ts'
import { createBackup, restoreBackup } from '../src/backup.ts'
import { inspectAfterSales } from '../src/after-sale-backup.ts'
import { inventoryPage } from '../src/inventory.ts'
import { removeServiceSchema } from './helpers/legacy-v16.ts'
import type { User } from '../src/accounts.ts'

const DAY = 86400000
const address = { receiver: '库存验收', contact: '13800000000', address: '库存验收测试仓库' }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'inventory-acceptance-'))
  const databasePath = join(root, 'data', 'mall.sqlite'), uploadsPath = join(root, 'uploads')
  let now = Date.UTC(2026, 10, 13, 1)
  const ctx = await buildTestApp({ databasePath, uploadsPath, publicUrl: 'http://localhost', mockPayments: true, clock: { now: () => now } })
  const password = randomBytes(24).toString('hex')
  const buyer = ctx.testData.account({ account: 'inventory_buyer', password })
  const merchant = ctx.testData.account({ account: 'inventory_merchant', password, role: 'merchant' })
  const delivery = ctx.testData.address({ userId: buyer.id, ...address })
  const product = ctx.testData.product({ name: '库存验收商品', category: '库存验收', skus: [{ spec: '标准', priceCents: 1000, stock: 100 }, { spec: '加大', priceCents: 2000, stock: 100 }] })
  const sku = product.skus[0]!, second = product.skus[1]!
  let waiting: { paths: string[]; entered: number; release: () => void; promise: Promise<void> } | undefined
  ctx.app.addHook('onRequest', async req => {
    if (waiting?.paths.includes(req.url)) {
      const gate = waiting
      gate.entered++
      if (gate.entered === 2) gate.release()
      await gate.promise
    }
  })
  // Test-only local route lets the timer scan compete at the same HTTP boundary as shipment.
  ctx.app.post('/_inventory-test/scan', () => ctx.orders.processDueCancelRequests())
  const call = async (method: string, url: string, payload?: object, token = buyer.token) => {
    const response = await ctx.app.inject({ method: method as never, url, headers: { authorization: 'Bearer ' + token },
      payload: withReturnShipping(ctx, uploadsPath, url, payload, token) })
    return { status: response.statusCode, body: response.json() }
  }
  const create = async (paid = true, shipped = true, multi = false) => {
    const total = multi ? 7000 : 3000
    const goods = [{ skuId: sku.id, count: 3 }, ...(multi ? [{ skuId: second.id, count: 2 }] : [])]
    const response = await call('POST', '/member/order', { addressId: delivery.id, requestKey: randomUUID(), expectedAmountCents: total, goods })
    assert.equal(response.status, 200)
    const id = response.body.result.id as string
    if (paid) assert.equal((await call('POST', `/member/order/${id}/mock-pay`, { amountCents: total })).status, 200)
    if (shipped && paid) assert.equal((await call('POST', `/merchant/orders/${id}/ship`, {}, merchant.token)).status, 200)
    return id
  }
  const action = (id: string, action: string, extra: object = {}, requestKey = randomUUID()) => call('POST',
    `/${action === 'ship-back' ? 'member' : 'merchant'}/after-sales/${id}/${action}`, { requestKey, ...extra }, action === 'ship-back' ? buyer.token : merchant.token)
  const sale = async (order: string, kind = 'return-quality', multi = false) => {
    const response = await call('POST', `/member/order/${order}/after-sales`, { requestKey: randomUUID(), kind, description: '商品存在问题需要退回',
      items: [{ skuId: sku.id, count: 2 }, ...(multi ? [{ skuId: second.id, count: 2 }] : [])] })
    assert.equal(response.status, 200)
    return response.body.result.afterSaleId as string
  }
  const returned = async (multi = false) => {
    const order = await create(true, true, multi), id = await sale(order, 'return-quality', multi)
    assert.equal((await action(id, 'approve', { returnAddress: address })).status, 200)
    assert.equal((await action(id, 'ship-back', { carrier: '顺丰', trackingNo: 'SF123456789' })).status, 200)
    return { order, id }
  }
  const inventory = async () => (await call('GET', `/merchant/inventory?skuId=${sku.id}`, undefined, merchant.token)).body.result.items[0]
  const snapshot = () => ({ stocks: ctx.db.all('SELECT id,stock FROM skus ORDER BY id'), movements: ctx.db.all('SELECT * FROM inventory_movements ORDER BY id') })
  const stock = () => ctx.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', sku.id)!.stock
  const balanced = () => assert.deepEqual(ctx.db.all('SELECT s.id FROM skus s WHERE stock<>(SELECT SUM(delta) FROM inventory_movements WHERE sku_id=s.id)'), [])
  const race = async (requests: { url: string; body: object }[]) => {
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 })
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    waiting = { paths: requests.map(r => r.url), entered: 0, release, promise }
    let timedOut = false
    const deadline = setTimeout(() => { timedOut = true; release() }, 5000)
    try {
      const responses = await Promise.all(requests.map(async r => {
        const response = await fetch(base + r.url, { method: 'POST', headers: { authorization: 'Bearer ' + merchant.token, 'content-type': 'application/json' }, body: JSON.stringify(r.body) })
        return { status: response.status, body: await response.json() }
      }))
      assert.equal(waiting.entered, 2, 'both HTTP requests must enter the gate before release')
      assert.equal(timedOut, false, 'both HTTP requests must arrive before the gate deadline')
      return responses
    } finally { clearTimeout(deadline); waiting = undefined }
  }
  const advance = (ms: number) => { now += ms; ctx.db.run('UPDATE sessions SET expires=?', now + DAY) }
  return { ctx, buyer, merchant, sku, second, root, databasePath, uploadsPath, call, create, sale, action, returned, inventory, snapshot, stock, balanced, race, advance, now: () => now,
    close: async () => { await ctx.app.close(); await rm(root, { recursive: true, force: true }) } }
}

test('INV-01 待付款取消与过期扫描各释放一次，库存流水差额为零', async () => {
  const f = await fixture()
  try {
    for (const expire of [false, true]) {
      const id = await f.create(false)
      if (expire) { f.advance(DAY); f.ctx.orders.expire(); f.ctx.orders.expire() }
      else { assert.equal((await f.call('PUT', `/member/order/${id}/cancel`, {})).status, 200); await f.call('PUT', `/member/order/${id}/cancel`, {}) }
      assert.equal(f.ctx.db.one<{ n: number }>("SELECT COUNT(*) n FROM inventory_movements WHERE business_key=?", `release:${id}:${f.sku.id}`)!.n, 1)
      assert.equal(f.stock(), 100); f.balanced()
    }
  } finally { await f.close() }
})

test('INV-02 取消待处理和同意后均禁止发货，仅同意时释放库存', async () => {
  const f = await fixture()
  try {
    const id = await f.create(true, false)
    const request = (await f.call('POST', `/member/order/${id}/cancel-requests`, { requestKey: randomUUID() })).body.result
    assert.equal((await f.call('POST', `/merchant/orders/${id}/ship`, {}, f.merchant.token)).status, 409)
    assert.equal(f.stock(), 97)
    assert.equal((await f.call('POST', `/merchant/orders/${id}/cancel-requests/${request.cancelRequestId}/resolve`, { requestKey: randomUUID(), decision: 'approve' }, f.merchant.token)).status, 200)
    assert.equal((await f.call('POST', `/merchant/orders/${id}/ship`, {}, f.merchant.token)).status, 409)
    assert.equal(f.stock(), 100); f.balanced()
  } finally { await f.close() }
})

for (const decision of ['ship', 'reject-and-ship']) test(`INV-03 同意取消与${decision}两个HTTP请求同时进入，仅一个成功且库存一致`, async () => {
  const f = await fixture()
  try {
    const id = await f.create(true, false)
    const request = (await f.call('POST', `/member/order/${id}/cancel-requests`, { requestKey: randomUUID() })).body.result
    const resolveUrl = `/merchant/orders/${id}/cancel-requests/${request.cancelRequestId}/resolve`
    const responses = await f.race([{ url: resolveUrl, body: { requestKey: randomUUID(), decision: 'approve' } },
      { url: decision === 'ship' ? `/merchant/orders/${id}/ship` : resolveUrl, body: decision === 'ship' ? {} : { requestKey: randomUUID(), decision, reason: '已经备好货立即发货' } }])
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409])
    const state = f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', id)!.state
    const releases = f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM inventory_movements WHERE business_key=?', `release:${id}:${f.sku.id}`)!.n
    assert.ok([3, 6].includes(state)); assert.equal(releases, state === 6 ? 1 : 0)
    assert.equal(f.stock(), state === 6 ? 100 : 97); f.balanced()
  } finally { await f.close() }
})

test('INV-04 自动同意扫描与HTTP发货同时竞争，到点取消仅释放一次', async () => {
  const f = await fixture()
  try {
    const id = await f.create(true, false)
    await f.call('POST', `/member/order/${id}/cancel-requests`, { requestKey: randomUUID() })
    f.advance(3 * DAY)
    const responses = await f.race([{ url: '/_inventory-test/scan', body: {} }, { url: `/merchant/orders/${id}/ship`, body: {} }])
    assert.equal(responses[0]!.status, 200); assert.equal(responses[1]!.status, 409)
    await f.ctx.orders.processDueCancelRequests()
    assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', id)!.state, 6)
    assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM inventory_movements WHERE business_key=?', `release:${id}:${f.sku.id}`)!.n, 1)
    assert.equal(f.stock(), 100); f.balanced()
  } finally { await f.close() }
})

test('INV-05 少件仅退款及重复同意不改变库存，退款和提醒仅一次', async () => {
  const f = await fixture()
  try {
    const id = await f.sale(await f.create(), 'refund-missing'), before = f.snapshot(), key = randomUUID()
    assert.equal((await f.action(id, 'approve', {}, key)).status, 200)
    assert.equal((await f.action(id, 'approve', {}, key)).status, 200)
    assert.equal((await f.action(id, 'approve')).status, 409)
    assert.deepEqual(f.snapshot(), before)
    assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM refunds WHERE after_sale_id=?', id)!.n, 1)
    assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM payment_notices')!.n, 1)
  } finally { await f.close() }
})

test('INV-06 同意退货与七天未寄回关闭均不退款不入库', async () => {
  const f = await fixture()
  try {
    const id = await f.sale(await f.create()), before = f.snapshot()
    await f.action(id, 'approve', { returnAddress: address })
    for (const days of [0, 7]) {
      f.advance(days * DAY); await f.ctx.afterSales.processDue()
      assert.deepEqual(f.snapshot(), before)
      assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM refunds')!.n, 0)
    }
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM after_sales WHERE id=?', id)!.state, 'closed')
  } finally { await f.close() }
})

test('INV-07 十天自动退款后仍按SKU列出待验收，补验收只入库不再退款', async () => {
  const f = await fixture()
  try {
    const { id } = await f.returned(), before = f.snapshot()
    assert.equal((await f.inventory()).pendingInspectionCount, 2)
    f.advance(10 * DAY); await f.ctx.afterSales.processDue()
    assert.deepEqual(f.snapshot(), before)
    const page = (await f.call('GET', '/merchant/after-sales?state=returned', undefined, f.merchant.token)).body.result
    assert.equal(page.stateCounts.returned, 1); assert.equal(page.items[0].id, id); assert.equal(page.items[0].inspectionPending, true)
    assert.equal(page.items[0].state, 'refunded')
    const refunds = f.ctx.db.all('SELECT * FROM refunds ORDER BY id')
    let refundCalls = 0
    f.ctx.payments.channel!.refund = () => { refundCalls++; return 'success' }
    f.ctx.payments.channel!.shippingRefund = () => { refundCalls++; return 'success' }
    const payload = { items: [{ skuId: f.sku.id, restockCount: 1 }] }, key = randomUUID()
    assert.equal((await f.call('POST', `/merchant/after-sales/${id}/inspect`, { requestKey: randomUUID(), ...payload })).status, 403)
    assert.equal((await f.action(id, 'inspect', { ...payload, shippingCompensationCents: 0 })).status, 409)
    const first = await f.action(id, 'inspect', payload, key)
    assert.equal(first.status, 200); assert.equal(first.body.result.appliedState, 'refunded')
    assert.equal((await f.action(id, 'inspect', payload, key)).status, 200)
    assert.equal((await f.action(id, 'inspect', payload)).status, 409)
    assert.equal(refundCalls, 0); assert.deepEqual(f.ctx.db.all('SELECT * FROM refunds ORDER BY id'), refunds)
    const inventory = await f.inventory()
    assert.equal(inventory.stock, 98); assert.equal(inventory.pendingInspectionCount, 0); assert.equal(inventory.rejectedReturnCount, 1)
    assert.equal(inventory.returnRecords[0].afterSaleId, id); f.balanced()
  } finally { await f.close() }
})

for (const count of [0, 1, 2]) test(`INV-08 退回两件合格${count}件，按SKU单独记录不合格且可追溯售后`, async () => {
  const f = await fixture()
  try {
    const { id, order } = await f.returned()
    assert.equal((await f.action(id, 'inspect', { items: [{ skuId: f.sku.id, restockCount: count }] })).status, 200)
    const row = await f.inventory()
    assert.equal(row.stock, 97 + count); assert.equal(row.pendingInspectionCount, 0); assert.equal(row.rejectedReturnCount, 2 - count)
    if (count < 2) { assert.equal(row.returnRecords[0].afterSaleId, id); assert.equal(row.returnRecords[0].orderId, order); assert.equal(row.returnRecords[0].rejectedCount, 2 - count) }
    const sale = (await f.call('GET', '/merchant/after-sales?state=all', undefined, f.merchant.token)).body.result.items[0]
    assert.equal(sale.inspectionPending, false); assert.equal(sale.items[0].rejectedCount, 2 - count)
    assert.equal((await f.action(id, 'inspect', { items: [{ skuId: f.sku.id, restockCount: 2 }] })).status, 409)
    f.balanced()
  } finally { await f.close() }
})

test('INV-08 无理由验收拒绝退款记录全量不合格，买家无权读商家库存', async () => {
  const f = await fixture()
  try {
    const id = await f.sale(await f.create(), 'return-no-reason')
    await f.action(id, 'approve', { returnAddress: address }); await f.action(id, 'ship-back', { carrier: '顺丰', trackingNo: 'SF12345678' })
    await f.action(id, 'refund-reject', { reason: '商品已经损坏无法再次出售' })
    const row = await f.inventory()
    assert.equal(row.pendingInspectionCount, 0); assert.equal(row.rejectedReturnCount, 2); assert.equal(row.stock, 97)
    assert.equal((await f.call('GET', '/merchant/inventory')).status, 403)
  } finally { await f.close() }
})

for (const sameKey of [true, false]) test(`INV-09 两个验收HTTP请求同时进入（${sameKey ? '同key' : '不同key'}），每SKU仅一次入库`, async () => {
  const f = await fixture()
  try {
    const { id } = await f.returned(true), key = randomUUID()
    const items = [{ skuId: f.sku.id, restockCount: 1 }, { skuId: f.second.id, restockCount: 2 }]
    const url = `/merchant/after-sales/${id}/inspect`
    const responses = await f.race([{ url, body: { requestKey: key, items } }, { url, body: { requestKey: sameKey ? key : randomUUID(), items } }])
    assert.deepEqual(responses.map(r => r.status).sort(), sameKey ? [200, 200] : [200, 409])
    assert.equal((await f.action(id, 'inspect', { items })).status, 409)
    assert.equal(f.ctx.db.one<{ n: number }>("SELECT COUNT(*) n FROM inventory_movements WHERE kind='return'")!.n, 2)
    assert.equal(f.ctx.db.one<{ n: number }>("SELECT COUNT(*) n FROM after_sale_actions WHERE action='inspect'")!.n, 1)
    assert.equal(f.stock(), 98); f.balanced()
  } finally { await f.close() }
})

test('INV-10 退款超时迟到成功与重复扫描保留原退款号，库存流水不变化', async t => {
  const f = await fixture()
  try {
    const id = await f.sale(await f.create(), 'refund-missing'), before = f.snapshot()
    const channel = f.ctx.payments.channel!, original = channel.refund.bind(channel)
    let late!: () => void
    const ids: string[] = []
    channel.refund = (refundId, paymentId, amount) => {
      ids.push(refundId)
      if (ids.length === 1) return new Promise(resolve => { late = () => resolve(original(refundId, paymentId, amount)) })
      return original(refundId, paymentId, amount)
    }
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const request = f.action(id, 'approve')
    for (let i = 0; i < 100 && !late; i++) await new Promise<void>(resolve => setImmediate(resolve))
    assert.ok(late); t.mock.timers.tick(15000); assert.equal((await request).status, 200)
    late(); f.advance(60000)
    await Promise.all([f.ctx.payments.reconcile(), f.ctx.payments.reconcile()]); await f.ctx.payments.reconcile()
    assert.deepEqual(ids, [ids[0], ids[0]])
    assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM refunds')!.n, 1)
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM refunds')!.state, 'succeeded')
    assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM payment_notices')!.n, 1)
    assert.deepEqual(f.snapshot(), before)
  } finally { await f.close() }
})

test('INV-11 过期关闭后的支付迟到成功及重复通知不重复释放库存', async () => {
  const f = await fixture()
  try {
    const id = await f.create(false)
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    const started = await f.call('POST', `/member/order/${id}/payments`, { requestKey: randomUUID(), amountCents: 3000 })
    assert.equal(started.status, 200)
    const paymentId = started.body.result.paymentId as string
    f.advance(DAY)
    f.ctx.testData.payments({ paymentId, preset: { outcome: 'fail' } }); await f.ctx.payments.reconcile()
    assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', id)!.state, 6)
    const before = f.snapshot()
    f.ctx.testData.payments({ paymentId, preset: { outcome: 'success', paidAt: f.now() } })
    const callback = f.ctx.payments.signedCallback(paymentId, { state: 'success', paidAt: f.now() })
    const { signature, ...payload } = callback
    for (let i = 0; i < 2; i++) await f.ctx.payments.callbackPayload(payload, signature)
    assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM refunds')!.n, 1)
    assert.deepEqual(f.snapshot(), before); assert.equal(f.stock(), 100); f.balanced()
  } finally { await f.close() }
})

test('INV-12 备份恢复和schema17重开保留待验收及不合格，补验收只入库一次', async () => {
  const f = await fixture()
  try {
    const pending = await f.returned(), partial = await f.returned(), rejected = await f.returned()
    await f.action(partial.id, 'inspect', { items: [{ skuId: f.sku.id, restockCount: 1 }] })
    await f.action(rejected.id, 'inspect', { items: [{ skuId: f.sku.id, restockCount: 0 }] })
    f.advance(10 * DAY); await f.ctx.afterSales.processDue()
    const late = await f.returned()
    f.advance(10 * DAY); await f.ctx.afterSales.processDue()
    assert.equal((await f.action(late.id, 'inspect', { items: [{ skuId: f.sku.id, restockCount: 1 }] })).status, 200)
    const expected = f.snapshot(), expectedInventory = await f.inventory()
    const backup = await createBackup({ databasePath: f.databasePath, uploadsPath: f.uploadsPath, destination: join(f.root, 'backup') })
    assert.equal(backup.manifest.schemaVersion, 17); assert.deepEqual(backup.manifest.issues, [])
    const restored = await restoreBackup({ backupPath: backup.root, destination: join(f.root, 'restored') })
    const legacy = new DatabaseSync(join(restored.root, 'mall.sqlite'))
    removeServiceSchema(legacy); legacy.exec('PRAGMA user_version=16'); legacy.close()
    for (let i = 0; i < 2; i++) {
      const next = await buildTestApp({ databasePath: join(restored.root, 'mall.sqlite'), uploadsPath: join(restored.root, 'uploads'), publicUrl: 'http://localhost', mockPayments: true, clock: { now: f.now } })
      try {
        assert.deepEqual(next.db.all('SELECT id,stock FROM skus ORDER BY id'), expected.stocks)
        assert.deepEqual(next.db.all('SELECT * FROM inventory_movements ORDER BY id'), expected.movements)
        assert.equal(next.db.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 17)
        const user = next.db.one<User>('SELECT id,account,role FROM users WHERE id=?', f.merchant.id)!
        const row = inventoryPage(next.db, user, { page: 1, pageSize: 20, skuId: f.sku.id }).items[0]
        assert.deepEqual(JSON.parse(JSON.stringify(row)), expectedInventory)
        assert.equal(row!.returnRecords.some(r => r.afterSaleId === pending.id && r.pendingInspectionCount === 2), true)
      } finally { await next.app.close() }
    }
    const raw = new DatabaseSync(join(restored.root, 'mall.sqlite'))
    try { assert.deepEqual(inspectAfterSales(raw), []) } finally { raw.close() }
  } finally { await f.close() }
})

test('INV-07 补验收期间退款仍在重试，回执失败整笔入库回滚且换key不重复', async () => {
  const f = await fixture()
  try {
    const { id, order } = await f.returned()
    f.ctx.testData.payments({ paymentId: f.ctx.payments.effectivePaymentId(order)!, preset: { outcome: 'success', refundFailures: 100 } })
    f.advance(10 * DAY); await f.ctx.afterSales.processDue()
    const before = f.snapshot(), refunds = f.ctx.db.all('SELECT * FROM refunds ORDER BY id')
    const key = randomUUID(), payload = { items: [{ skuId: f.sku.id, restockCount: 1 }] }
    f.ctx.db.run("CREATE TRIGGER fail_inspection_receipt BEFORE INSERT ON after_sale_actions WHEN NEW.action='inspect' BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END")
    assert.equal((await f.action(id, 'inspect', payload, key)).status, 500)
    assert.deepEqual(f.snapshot(), before)
    assert.equal((await f.inventory()).pendingInspectionCount, 2)
    f.ctx.db.run('DROP TRIGGER fail_inspection_receipt')
    assert.equal((await f.action(id, 'inspect', payload, key)).status, 200)
    assert.equal((await f.action(id, 'inspect', payload)).status, 409)
    assert.deepEqual(f.ctx.db.all('SELECT * FROM refunds ORDER BY id'), refunds)
    assert.equal(f.stock(), 98); f.balanced()
    const backup = await createBackup({ databasePath: f.databasePath, uploadsPath: f.uploadsPath, destination: join(f.root, 'backup') })
    assert.deepEqual(backup.manifest.issues, [])
  } finally { await f.close() }
})

test('INV-10 重启扫描启动售后退款并沿原号重试，库存流水不改变', async () => {
  const f = await fixture()
  let next: Awaited<ReturnType<typeof buildApp>> | undefined
  try {
    const order = await f.create(), id = await f.sale(order, 'refund-missing'), before = f.snapshot()
    const channel = f.ctx.payments.channel!
    f.ctx.testData.payments({ paymentId: f.ctx.payments.effectivePaymentId(order)!, preset: { outcome: 'success', refundFailures: 1 } })
    f.advance(2 * DAY); await f.ctx.app.close()
    next = await buildTestApp({ databasePath: f.databasePath, uploadsPath: f.uploadsPath, publicUrl: 'http://localhost', mockPayments: true, paymentChannel: channel, clock: { now: f.now } })
    const refund = next.db.one<{ id: string; state: string }>('SELECT id,state FROM refunds WHERE after_sale_id=?', id)!
    assert.equal(refund.state, 'failed')
    // The clock advances without touching the closed original connection.
    await next.payments.reconcile(f.now() + 60000)
    await next.payments.reconcile(f.now() + 60000)
    assert.deepEqual(next.db.all<{ id: string; state: string }>('SELECT id,state FROM refunds'), [{ id: refund.id, state: 'succeeded' }].map(r => Object.assign(Object.create(null), r)))
    assert.deepEqual(next.db.all('SELECT id,stock FROM skus ORDER BY id'), before.stocks)
    assert.deepEqual(next.db.all('SELECT * FROM inventory_movements ORDER BY id'), before.movements)
  } finally { if (next) await next.app.close(); await f.close() }
})

test('INV-12 备份校验拒绝第二次验收回执和伪造的入库数量', async () => {
  const f = await fixture()
  try {
    const { id, order } = await f.returned()
    await f.action(id, 'inspect', { items: [{ skuId: f.sku.id, restockCount: 1 }] })
    const backup = await createBackup({ databasePath: f.databasePath, uploadsPath: f.uploadsPath, destination: join(f.root, 'backup') })
    const raw = new DatabaseSync(join(backup.root, 'mall.sqlite'))
    try {
      assert.deepEqual(inspectAfterSales(raw), [])
      raw.exec('BEGIN')
      raw.prepare('UPDATE after_sale_items SET restock_count=0 WHERE after_sale_id=?').run(id)
      assert.deepEqual(inspectAfterSales(raw), [order])
      raw.exec('ROLLBACK')
      const old = raw.prepare("SELECT * FROM after_sale_actions WHERE after_sale_id=? AND action='inspect'").get(id)!
      const key = randomUUID(), receiptId = randomUUID()
      const body = JSON.parse(String(old.request_body)), result = JSON.parse(String(old.result))
      body.requestKey = key; result.id = receiptId
      raw.prepare('INSERT INTO after_sale_actions(id,after_sale_id,actor_id,action,request_key,request_body,result,created) VALUES(?,?,?,?,?,?,?,?)')
        .run(receiptId, id, old.actor_id!, 'inspect', key, JSON.stringify(body), JSON.stringify(result), old.created!)
      assert.deepEqual(inspectAfterSales(raw), [order])
    } finally { raw.close() }
  } finally { await f.close() }
})

test('INV-12 入库与验收回执跨毫秒写入仍可完整备份', async () => {
  const f = await fixture()
  try {
    const { id } = await f.returned()
    let ticks = 0
    f.ctx.clock.now = () => f.now() + ticks++
    assert.equal((await f.action(id, 'inspect', { items: [{ skuId: f.sku.id, restockCount: 1 }] })).status, 200)
    const movement = f.ctx.db.one<{ created: number }>("SELECT created FROM inventory_movements WHERE kind='return'")!
    const receipt = f.ctx.db.one<{ created: number }>("SELECT created FROM after_sale_actions WHERE action='inspect'")!
    assert.ok(receipt.created > movement.created)
    const backup = await createBackup({ databasePath: f.databasePath, uploadsPath: f.uploadsPath, destination: join(f.root, 'backup') })
    assert.deepEqual(backup.manifest.issues, [])
  } finally { await f.close() }
})

test('INV-R2 库存记录提供买家和申请时间及售后次数，保持商家权限', async () => {
  const f = await fixture()
  try {
    const first = await f.returned()
    await f.action(first.id, 'inspect', { items: [{ skuId: f.sku.id, restockCount: 1 }] })
    f.advance(1000)
    const second = await f.call('POST', `/member/order/${first.order}/after-sales`, { requestKey: randomUUID(), kind: 'return-quality', description: '剩余一件也存在质量问题', items: [{ skuId: f.sku.id, count: 1 }] })
    assert.equal(second.status, 200)
    const id = second.body.result.afterSaleId
    await f.action(id, 'approve', { returnAddress: address })
    await f.action(id, 'ship-back', { carrier: '顺丰', trackingNo: 'SF123456789' })
    const result = await f.inventory()
    const record = result.returnRecords.find((r: { afterSaleId: string }) => r.afterSaleId === id)
    assert.equal(record.buyerAccount, 'inventory_buyer')
    assert.equal(record.sequence, 2)
    assert.equal(record.createdAt, f.now())
    assert.equal((await f.call('GET', `/merchant/inventory?skuId=${f.sku.id}`)).status, 403)
  } finally { await f.close() }
})

test('INV-R2 待验收全部返回，不合格仅最近三条且汇总包含全部历史', async () => {
  const f = await fixture()
  try {
    const rejected: string[] = [], pending: string[] = []
    for (let index = 0; index < 9; index++) {
      f.advance(1000)
      const sale = await f.returned()
      if (index % 2 === 0) {
        await f.action(sale.id, 'inspect', { items: [{ skuId: f.sku.id, restockCount: 0 }] })
        rejected.push(sale.id)
      } else pending.push(sale.id)
    }
    const all = f.ctx.db.all.bind(f.ctx.db)
    let materialized = 0
    f.ctx.db.all = ((...args: Parameters<typeof f.ctx.db.all>) => {
      const rows = all(...args)
      if (args[0].includes('after_sale_items i')) materialized += rows.length
      return rows
    }) as typeof f.ctx.db.all
    const result = await f.inventory()
    assert.equal(result.pendingInspectionCount, 8)
    assert.equal(result.rejectedReturnCount, 10)
    assert.equal(result.hiddenRejectedRecordCount, 2)
    assert.equal(result.returnRecords.length, 7)
    assert.deepEqual(result.returnRecords.filter((r: { pendingInspectionCount: number }) => r.pendingInspectionCount > 0).map((r: { afterSaleId: string }) => r.afterSaleId), pending.toReversed())
    assert.deepEqual(result.returnRecords.filter((r: { rejectedCount: number }) => r.rejectedCount > 0).map((r: { afterSaleId: string }) => r.afterSaleId), rejected.toReversed().slice(0, 3))
    assert.equal(materialized, 7, 'database must return only pending rows and the latest three rejected records, not all historical rows')
    f.balanced()
  } finally { await f.close() }
})

test('INV-R2 无退货隔离数量时汇总和隐藏记录数均为零', async () => {
  const f = await fixture()
  try {
    const result = await f.inventory()
    assert.equal(result.pendingInspectionCount, 0)
    assert.equal(result.rejectedReturnCount, 0)
    assert.equal(result.hiddenRejectedRecordCount, 0)
    assert.deepEqual(result.returnRecords, [])
  } finally { await f.close() }
})
