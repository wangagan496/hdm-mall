import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTestApp } from './helpers/fixtures.ts'
import { createBackup, verifyBackup, restoreBackup } from '../src/backup.ts'
import { DatabaseSync } from 'node:sqlite'
import { Database } from '../src/database.ts'
import { removePromotionShippingSchema } from './helpers/legacy-v15.ts'

const DAY = 86400000
async function fixture(kind = 'return-no-reason', family = false) {
  const root = await mkdtemp(join(tmpdir(), 'shipping-comp-'))
  let now = Date.now()
  const databasePath = join(root, 'data', 'mall.sqlite'), uploadsPath = join(root, 'uploads')
  const ctx = await buildTestApp({ databasePath, uploadsPath, mockPayments: true, publicUrl: 'http://localhost', clock: { now: () => now } })
  const password = randomBytes(24).toString('hex')
  const buyer = ctx.testData.account({ account: 'shipping_buyer', password })
  const merchant = ctx.testData.account({ account: 'shipping_seller', password, role: 'merchant' })
  const friend = ctx.testData.account({ account: 'shipping_friend', password })
  ctx.db.run('UPDATE sessions SET expires=?', now + 30 * DAY)
  const address = ctx.testData.address({ userId: buyer.id, receiver: 'Buyer', contact: '13800000000', address: '测试地址' })
  const product = ctx.testData.product({ name: '运费测试商品', skus: [{ spec: '标准', priceCents: 100, stock: 100 }] })
  const sku = product.skus[0]!
  const call = async (method: string, url: string, payload?: object, token = buyer.token) => {
    const response = await ctx.app.inject({ method: method as never, url, headers: { authorization: 'Bearer ' + token }, payload })
    return { status: response.statusCode, body: response.json() }
  }
  const created = await call('POST', '/member/order', { requestKey: randomUUID(), addressId: address.id, goods: [{ skuId: sku.id, count: 1 }], expectedAmountCents: 100 })
  assert.equal(created.status, 200)
  const orderId = created.body.result.id
  if (family) {
    ctx.testData.relation({ ownerId: buyer.id, friendId: friend.id })
    assert.equal((await call('PUT', `/member/order/${orderId}/payer`, { friendId: friend.id })).status, 200)
  }
  assert.equal((await call('POST', `/member/order/${orderId}/mock-pay`, { amountCents: 100 }, family ? friend.token : buyer.token)).status, 200)
  assert.equal((await call('POST', `/merchant/orders/${orderId}/ship`, {carrier:'顺丰',trackingNo:'SF12345678'}, merchant.token)).status, 200)
  const requested = await call('POST', `/member/order/${orderId}/after-sales`, { requestKey: randomUUID(), kind, description: '收到商品后发现问题', items: [{ skuId: sku.id, count: 1 }] })
  assert.equal(requested.status, 200)
  const saleId = requested.body.result.afterSaleId
  const act = (action: string, data: object = {}, key = randomUUID(), targetSaleId = saleId) => call('POST', `/${['ship-back', 'withdraw'].includes(action) ? 'member' : 'merchant'}/after-sales/${targetSaleId}/${action}`, { requestKey: key, ...data }, ['ship-back', 'withdraw'].includes(action) ? buyer.token : merchant.token)
  const upload = async (applicationKey: string, bytes = Buffer.from([255, 216, 255, 224, 0, 16, 255, 217]), token = buyer.token, targetOrderId = orderId) => {
    const boundary = 'shipping-test-boundary'
    const fields = { orderId: targetOrderId, applicationKey, requestKey: randomUUID() }
    const header = Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('')
    const response = await ctx.app.inject({ method: 'POST', url: '/member/after-sales/images', headers: { authorization: 'Bearer ' + token, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(header + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="waybill.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) })
    return { status: response.statusCode, body: response.json() }
  }
  const approve = () => act('approve', { returnAddress: { receiver: '售后收件人', contact: '13800000000', address: '测试退货地址' } })
  const detail = async (targetOrderId = orderId) => (await call('GET', `/member/order/${targetOrderId}`)).body.result
  return { ctx, call, act, upload, approve, detail, buyer, merchant, friend, sku, orderId, saleId, databasePath, uploadsPath, root, advance: (value: number) => { now += value },
    close: async () => { await ctx.app.close(); await rm(root, { recursive: true, force: true }) } }
}

for (const kind of ['return-no-reason', 'return-quality']) {
  test(`A1 ${kind}寄回运费和必填截图，默认全额补偿独立退款并审计`, async () => {
    const f = await fixture(kind)
    try {
      assert.equal((await f.approve()).status, 200)
      assert.equal((await f.act('ship-back', { carrier: 'SF', trackingNo: 'SF12345678' })).status, 400)
      const key = randomUUID()
      const uploaded = await f.upload(key)
      assert.equal(uploaded.status, 200)
      const imageId = uploaded.body.result.imageId
      const shipping = { carrier: 'SF', trackingNo: 'SF12345678', shippingAmountCents: 10000, shippingImageId: imageId }
      assert.equal((await f.act('ship-back', { ...shipping, shippingAmountCents: 0 }, key)).status, 400)
      assert.equal((await f.act('ship-back', { ...shipping, shippingAmountCents: 10001 }, key)).status, 400)
      assert.equal((await f.act('ship-back', shipping, key)).status, 200)
      const inspectKey = randomUUID()
      assert.equal((await f.act('inspect', { items: [{ skuId: f.sku.id, restockCount: 1 }] }, inspectKey)).status, 200)
      assert.equal((await f.act('inspect', { items: [{ skuId: f.sku.id, restockCount: 1 }] }, inspectKey)).status, 200)
      const detail = await f.detail()
      assert.equal(detail.refunds.length, 2)
      const shippingRefund = detail.refunds.find((refund: { reason: string }) => refund.reason === 'shipping')
      assert.equal(shippingRefund.amount, 100)
      assert.equal(shippingRefund.state, '已退款')
      assert.equal(shippingRefund.payerAccount, 'shipping_buyer')
      assert.equal(detail.afterSales[0].shippingCompensationCents, 10000)
      const audit = await f.call('GET', '/merchant/audit-log?action=aftersale.shipping_comp', undefined, f.merchant.token)
      assert.equal(audit.body.result.counts, 1)
      assert.equal(audit.body.result.items[0].summary.before, 10000)
      assert.equal(audit.body.result.items[0].summary.after, 10000)
    } finally { await f.close() }
  })
}

test('A1 少件仅退款无需寄回及运费', async () => {
  const f = await fixture('refund-missing')
  try {
    assert.equal((await f.act('approve')).status, 200)
    const detail = await f.detail()
    assert.equal(detail.refunds.length, 1)
    assert.equal(detail.refunds[0].reason, 'after-sale')
    assert.equal(detail.afterSales[0].shippingCompensationCents, null)
  } finally { await f.close() }
})

test('A1 商家下调须5到200字原因，买家可见且不能提高金额', async () => {
  const f = await fixture()
  try {
    await f.approve()
    const key = randomUUID(), imageId = (await f.upload(key)).body.result.imageId
    assert.equal((await f.act('ship-back', { carrier: 'SF', trackingNo: 'SF12345678', shippingAmountCents: 1000, shippingImageId: imageId }, key)).status, 200)
    const items = [{ skuId: f.sku.id, restockCount: 0 }]
    assert.equal((await f.act('inspect', { items, shippingCompensationCents: 500 })).status, 400)
    assert.equal((await f.act('inspect', { items, shippingCompensationCents: 1001 })).status, 400)
    assert.equal((await f.act('inspect', { items, shippingCompensationCents: 500, shippingAdjustmentReason: '短原因' })).status, 400)
    assert.equal((await f.act('inspect', { items, shippingCompensationCents: 500, shippingAdjustmentReason: '运单显示实付五元' })).status, 200)
    const sale = (await f.detail()).afterSales[0]
    assert.equal(sale.shippingCompensationCents, 500)
    assert.equal(sale.shippingAdjustmentReason, '运单显示实付五元')
  } finally { await f.close() }
})

test('A1 十天自动退款按买家运费补偿，下限1分与图片权限有效', async () => {
  const f = await fixture()
  try {
    await f.approve()
    const key = randomUUID(), uploaded = await f.upload(key)
    assert.equal(uploaded.status, 200)
    const imageId = uploaded.body.result.imageId
    assert.equal((await f.act('ship-back', { carrier: 'SF', trackingNo: 'SF12345678', shippingAmountCents: 1, shippingImageId: imageId }, key)).status, 200)
    f.advance(10 * DAY)
    assert.deepEqual((await f.ctx.afterSales.processDue()).failed, [])
    const detail = await f.detail()
    assert.equal(detail.afterSales[0].shippingCompensationCents, 1)
    assert.equal(detail.refunds.find((refund: { reason: string }) => refund.reason === 'shipping').amount, 0.01)
  } finally { await f.close() }
})

test('A1 v16运费退款超过货款，图片与独立退款备份校验及恢复有效', async () => {
  const f = await fixture()
  try {
    await f.approve()
    const key = randomUUID(), imageId = (await f.upload(key)).body.result.imageId
    assert.equal((await f.act('ship-back', { carrier: 'SF', trackingNo: 'SF12345678', shippingAmountCents: 10000, shippingImageId: imageId }, key)).status, 200)
    assert.equal((await f.act('inspect', { items: [{ skuId: f.sku.id, restockCount: 1 }] })).status, 200)
    const destination = join(f.root, 'backup')
    const backup = await createBackup({ databasePath: f.databasePath, uploadsPath: f.uploadsPath, destination })
    assert.equal(backup.manifest.schemaVersion, 19)
    assert.deepEqual(backup.manifest.issues, [])
    await verifyBackup(destination)
    const restored = await restoreBackup({ backupPath: destination, destination: join(f.root, 'restored') })
    assert.equal(restored.report.sessionPolicy, 'all-sessions-revoked')
    f.ctx.db.run("UPDATE after_sales SET shipping_compensation=9999,shipping_adjustment_reason='用于篡改校验的原因' WHERE id=?", f.saleId)
    await assert.rejects(createBackup({ databasePath: f.databasePath, uploadsPath: f.uploadsPath, destination: join(f.root, 'tampered') }), /运费退款不一致/)
  } finally { await f.close() }
})

test('A2 多件限额分摊备份按购买件数校验，恢复后金额不变且拒绝篡改', async () => {
  const f = await fixture()
  try {
    f.ctx.db.run('UPDATE promotions SET threshold=102,discount=20 WHERE id=1')
    const product = f.ctx.testData.product({ name: '多件限额备份商品', skus: [
      { spec: '一元商品', priceCents: 100, stock: 10 }, { spec: '一分商品', priceCents: 1, stock: 10 }
    ] })
    const address = f.ctx.testData.address({ userId: f.buyer.id, receiver: 'Buyer', contact: '13800000000', address: '测试地址' })
    const created = await f.call('POST', '/member/order', { requestKey: randomUUID(), addressId: address.id,
      goods: [{ skuId: product.skus[0]!.id, count: 1 }, { skuId: product.skus[1]!.id, count: 2 }], expectedAmountCents: 82 })
    assert.equal(created.status, 200)
    const orderId = created.body.result.id
    assert.deepEqual((await f.detail(orderId)).skus.map((item: { discountShareCents: number }) => item.discountShareCents), [20, 0])
    const destination = join(f.root, 'quantity-backup')
    const backup = await createBackup({ databasePath: f.databasePath, uploadsPath: f.uploadsPath, destination })
    assert.deepEqual(backup.manifest.issues, [])
    const restoredPath = join(f.root, 'quantity-restored')
    await restoreBackup({ backupPath: destination, destination: restoredPath })
    const restored = new DatabaseSync(join(restoredPath, 'mall.sqlite'))
    try {
      assert.equal(restored.prepare('SELECT amount FROM orders WHERE id=?').get(orderId)!.amount, 82)
      assert.deepEqual(restored.prepare('SELECT discount_share FROM order_items WHERE order_id=? ORDER BY rowid').all(orderId).map(item => item.discount_share), [20, 0])
    } finally { restored.close() }
    f.ctx.db.run('UPDATE order_items SET discount_share=CASE sku_id WHEN ? THEN 19 ELSE 1 END WHERE order_id=?', product.skus[0]!.id, orderId)
    await assert.rejects(createBackup({ databasePath: f.databasePath, uploadsPath: f.uploadsPath, destination: join(f.root, 'quantity-tampered') }), /订单满减分摊不一致/)
  } finally { await f.close() }
})

test('A1 代付运费退给原付款账户，运单仅本人和商家可读', async () => {
  const f = await fixture('return-quality', true)
  try {
    await f.approve()
    const key = randomUUID(), uploaded = await f.upload(key), imageId = uploaded.body.result.imageId
    assert.equal(uploaded.status, 200)
    assert.equal((await f.call('GET', uploaded.body.result.path, undefined, f.friend.token)).status, 403)
    assert.equal((await f.upload(key)).status, 400)
    assert.equal((await f.act('ship-back', { carrier: 'SF', trackingNo: 'SF12345678', shippingAmountCents: 1500, shippingImageId: imageId }, randomUUID())).status, 400)
    assert.equal((await f.act('ship-back', { carrier: 'SF', trackingNo: 'SF12345678', shippingAmountCents: 1500, shippingImageId: imageId }, key)).status, 200)
    for (const token of [f.buyer.token, f.merchant.token]) {
      const response = await f.ctx.app.inject({ method: 'GET', url: uploaded.body.result.path, headers: { authorization: 'Bearer ' + token } })
      assert.equal(response.statusCode, 200)
    }
    assert.equal((await f.act('inspect', { items: [{ skuId: f.sku.id, restockCount: 1 }] })).status, 200)
    const detail = await f.detail()
    assert.deepEqual(detail.refunds.map((refund: { payerAccount: string }) => refund.payerAccount), ['shipping_friend', 'shipping_friend'])
    assert.equal(detail.refunds.find((refund: { reason: string }) => refund.reason === 'shipping').amount, 15)
  } finally { await f.close() }
})

test('A1 申请期届满但已同意且寄回期内仍能上传运单', async () => {
  const f = await fixture('return-quality')
  try {
    f.ctx.db.run('UPDATE orders SET received_at=? WHERE id=?', Date.now() - 15 * DAY, f.orderId)
    await f.approve()
    assert.equal((await f.upload(randomUUID())).status, 200)
    f.advance(7 * DAY + 1)
    assert.equal((await f.upload(randomUUID())).status, 409)
  } finally { await f.close() }
})

test('A2 v15历史订单和售后迁移016后金额不变，重复打开不重复迁移', async () => {
  const f = await fixture('refund-missing')
  try {
    assert.equal((await f.act('approve')).status, 200)
    const before = await f.detail()
    await f.ctx.app.close()
    const legacy = new DatabaseSync(f.databasePath)
    try {
      removePromotionShippingSchema(legacy)
      assert.match(String(legacy.prepare("SELECT sql FROM sqlite_master WHERE name='after_sales'").get()!.sql), /amount>0/)
    } finally { legacy.close() }
    const oldBackup = await createBackup({ databasePath: f.databasePath, uploadsPath: f.uploadsPath, destination: join(f.root, 'legacy-backup') })
    assert.equal(oldBackup.manifest.schemaVersion, 15)
    for (let iteration = 0; iteration < 2; iteration++) {
      const db = new Database(f.databasePath)
      try {
        assert.equal(db.one<{user_version: number}>('PRAGMA user_version')!.user_version, 19)
        assert.deepEqual(db.all('PRAGMA foreign_key_check'), [])
        assert.equal(db.one<{amount: number}>('SELECT amount FROM orders WHERE id=?', f.orderId)!.amount, Math.round(before.payMoney * 100))
        assert.equal(db.one<{state: string}>('SELECT state FROM after_sales WHERE id=?', f.saleId)!.state, 'refunded')
        assert.equal(db.one<{count: number}>('SELECT COUNT(*) count FROM refunds')!.count, 1)
        assert.equal(db.one<{count: number}>('SELECT COUNT(*) count FROM promotions')!.count, 1)
      } finally { db.close() }
    }
    const backup = await createBackup({ databasePath: f.databasePath, uploadsPath: f.uploadsPath, destination: join(f.root, 'migrated-backup') })
    assert.deepEqual(backup.manifest.issues, [])
  } finally { await f.close() }
})

test('A2 零元货款退货无需货款退款渠道，运费仍单独补偿', async () => {
  const f = await fixture()
  try {
    f.ctx.db.run('UPDATE promotions SET threshold=2,discount=1 WHERE id=1')
    const product = f.ctx.testData.product({ name: '零元退款商品', skus: [
      { spec: '一分甲', priceCents: 1, stock: 10 }, { spec: '一分乙', priceCents: 1, stock: 10 }
    ] })
    const created = await f.call('POST', '/member/order', { requestKey: randomUUID(), addressId: f.ctx.testData.address({
      userId: f.buyer.id, receiver: 'Buyer', contact: '13800000000', address: '测试地址'
    }).id, goods: product.skus.map(sku => ({ skuId: sku.id, count: 1 })), expectedAmountCents: 1 })
    assert.equal(created.status, 200)
    const zeroOrderId = created.body.result.id
    assert.equal((await f.call('POST', `/member/order/${zeroOrderId}/mock-pay`, { amountCents: 1 })).status, 200)
    assert.equal((await f.call('POST', `/merchant/orders/${zeroOrderId}/ship`, {carrier:'顺丰',trackingNo:'SF12345678'}, f.merchant.token)).status, 200)
    const requested = await f.call('POST', `/member/order/${zeroOrderId}/after-sales`, { requestKey: randomUUID(), kind: 'return-no-reason',
      items: [{ skuId: product.skus[0]!.id, count: 1 }] })
    assert.equal(requested.status, 200, '实付0分商品仍可申请退货')
    const zeroSaleId = requested.body.result.afterSaleId
    assert.equal((await f.detail(zeroOrderId)).afterSales[0].amountCents, 0)
    assert.equal((await f.act('approve', { returnAddress: { receiver: '售后收件人', contact: '13800000000', address: '测试退货地址' } }, randomUUID(), zeroSaleId)).status, 200)
    const shipKey = randomUUID(), imageId = (await f.upload(shipKey, undefined, f.buyer.token, zeroOrderId)).body.result.imageId
    assert.equal((await f.act('ship-back', { carrier: 'SF', trackingNo: 'SF12345678', shippingAmountCents: 100, shippingImageId: imageId }, shipKey, zeroSaleId)).status, 200)
    assert.equal((await f.act('inspect', { items: [{ skuId: product.skus[0]!.id, restockCount: 1 }] }, randomUUID(), zeroSaleId)).status, 200)
    const detail = await f.detail(zeroOrderId), sale = detail.afterSales[0]
    assert.equal(sale.amountCents, 0)
    assert.equal(sale.state, 'completed')
    assert.equal(sale.amountMessage, '货款 0 元，无需退款')
    assert.equal(sale.refundId, null)
    assert.equal(sale.shippingRefundState, 'succeeded')
    assert.equal(detail.refunds.filter((refund: { reason: string }) => refund.reason === 'after-sale').length, 0)
    assert.equal(detail.refunds.find((refund: { reason: string }) => refund.reason === 'shipping').amount, 1)
    const destination = join(f.root, 'zero-principal-backup')
    const backup = await createBackup({ databasePath: f.databasePath, uploadsPath: f.uploadsPath, destination })
    assert.deepEqual(backup.manifest.issues, [])
    await verifyBackup(destination)
  } finally { await f.close() }
})
