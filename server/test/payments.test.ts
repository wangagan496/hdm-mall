import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildTestApp } from './helpers/fixtures.ts'
import { buildApp } from '../src/app.ts'
import { Database } from '../src/database.ts'
import { createBackup, verifyBackup } from '../src/backup.ts'
import { MockPaymentChannel, type PaymentChannel } from '../src/payment-channel.ts'

const amountCents = 2475
const password = 'test-password-123'

function channelSpy() {
  const calls = { create: 0, query: 0, close: 0, refund: 0 }
  const channel: PaymentChannel = {
    create: () => { calls.create++; return { accepted: true } },
    query: () => { calls.query++; return { state: 'unknown' } },
    close: () => { calls.close++; return { state: 'closed' } },
    refund: () => { calls.refund++; return 'success' }
  }
  return { channel, calls }
}

async function fixture(paymentChannel?: PaymentChannel) {
  let now = Date.UTC(2026, 10, 5, 8)
  const clock = { now: () => now }
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
  const ctx = await buildTestApp({ databasePath: ':memory:', uploadsPath: './unused',
    publicUrl: 'http://127.0.0.1:3000', mockPayments: true, clock, ...(paymentChannel ? { paymentChannel } : {}) })
  const buyer = ctx.testData.account({ account: `buyer_${suffix}`, password })
  const merchant = ctx.testData.account({ account: `seller_${suffix}`, password, role: 'merchant' })
  const payer = ctx.testData.account({ account: `payer_${suffix}`, password })
  const address = ctx.testData.address({ userId: buyer.id, receiver: '买家', contact: '13800000000', address: '测试地址' })
  const product = ctx.testData.product({ name: `支付测试商品${suffix}`, category: '支付测试', skus: [
    { spec: '标准', priceCents: amountCents, stock: 7 }
  ] })
  const sku = product.skus[0]!
  const call = async (method: string, url: string, token = '', payload?: object) => {
    const response = await ctx.app.inject({ method: method as never, url,
      headers: token ? { authorization: `Bearer ${token}` } : {}, payload })
    return { status: response.statusCode, body: response.json() }
  }
  const createOrder = async () => {
    const response = await call('POST', '/member/order', buyer.token, {
      addressId: address.id, requestKey: randomUUID(), expectedAmountCents: amountCents, goods: [{ skuId: sku.id, count: 1 }]
    })
    assert.equal(response.status, 200)
    return response.body.result.id as string
  }
  return { ctx, clock, advance: (milliseconds: number) => { now += milliseconds }, buyer, merchant, payer, address, product, sku, call, createOrder }
}

test('订单提醒汇总只统计当前用户未读订单，查看详情后清除且匿名请求为 401', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    await invitePayer(f, orderId)
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'fail' } })
    const first = await f.call('POST', `/member/order/${orderId}/payments`, f.payer.token, { amountCents })
    await f.call('PUT', `/member/order/${orderId}/payer`, f.buyer.token, { friendId: null })
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'success' } })
    await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    f.ctx.testData.payments({ paymentId: first.body.result.paymentId, preset: { outcome: 'success' } })
    await f.call('POST', '/payments/callback', '', f.ctx.payments.signedCallback(first.body.result.paymentId, { state: 'success' }))

    assert.equal((await f.call('GET', '/member/order/attention')).status, 401)
    assert.deepEqual((await f.call('GET', '/member/order/attention', f.buyer.token)).body.result, { count: 1 })
    assert.deepEqual((await f.call('GET', '/member/order/attention', f.payer.token)).body.result, { count: 1 })
    const stranger = f.ctx.testData.account({ account: `attention_${randomUUID().replaceAll('-', '').slice(0, 8)}`, password })
    assert.deepEqual((await f.call('GET', '/member/order/attention', stranger.token)).body.result, { count: 0 })
    await f.call('GET', `/member/order/${orderId}`, f.buyer.token)
    assert.deepEqual((await f.call('GET', '/member/order/attention', f.buyer.token)).body.result, { count: 0 })
    assert.deepEqual((await f.call('GET', '/member/order/attention', f.payer.token)).body.result, { count: 1 })
    await f.call('GET', `/member/order/${orderId}`, f.payer.token)
    assert.deepEqual((await f.call('GET', '/member/order/attention', f.payer.token)).body.result, { count: 0 })
  } finally { await f.ctx.app.close() }
})

test('已取消代付订单保留买家和实际发起支付的亲友列表入口，各自查看后清除退款提醒', async () => {
  const f = await fixture()
  try {
    const paidOrderId = await f.createOrder()
    await invitePayer(f, paidOrderId)
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'close-paid' } })
    assert.equal((await f.call('POST', `/member/order/${paidOrderId}/payments`, f.payer.token, { amountCents })).status, 200)
    assert.equal((await f.call('PUT', `/member/order/${paidOrderId}/cancel`, f.buyer.token)).status, 200)
    const invitedOrderId = await f.createOrder()
    await f.call('PUT', `/member/order/${invitedOrderId}/payer`, f.buyer.token, { friendId: f.payer.id })
    await f.call('PUT', `/member/order/${invitedOrderId}/cancel`, f.buyer.token)
    const failedOrderId = await f.createOrder()
    await f.call('PUT', `/member/order/${failedOrderId}/payer`, f.buyer.token, { friendId: f.payer.id })
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'fail' } })
    await f.call('POST', `/member/order/${failedOrderId}/payments`, f.payer.token, { amountCents })
    await f.call('PUT', `/member/order/${failedOrderId}/cancel`, f.buyer.token)
    const buyerList = (await f.call('GET', '/member/order?orderState=0&pageSize=10', f.buyer.token)).body.result
    assert.equal(buyerList.counts, 3)
    assert.ok(buyerList.items.some((order: { id: string }) => order.id === paidOrderId))
    for (const path of ['/member/family-orders', '/member/family-orders/page']) {
      const result = (await f.call('GET', path, f.payer.token)).body.result
      const items = Array.isArray(result) ? result : result.items
      assert.deepEqual(items.map((order: { id: string }) => order.id).sort(), [paidOrderId, failedOrderId].sort())
      const paid = items.find((order: { id: string }) => order.id === paidOrderId)
      assert.equal(paid.orderState, 6); assert.equal(paid.needsAttention, true)
      assert.equal(paid.refunds.length, 1); assert.equal(paid.refunds[0].payerAccount, f.payer.account)
      assert.equal(paid.address, undefined)
      if (!Array.isArray(result)) { assert.equal(result.counts, 2); assert.equal(result.pages, 1) }
    }
    for (const token of [f.buyer.token, f.payer.token]) {
      assert.deepEqual((await f.call('GET', '/member/order/attention', token)).body.result, { count: 1 })
    }
    await f.call('GET', `/member/order/${paidOrderId}`, f.buyer.token)
    assert.deepEqual((await f.call('GET', '/member/order/attention', f.buyer.token)).body.result, { count: 0 })
    assert.deepEqual((await f.call('GET', '/member/order/attention', f.payer.token)).body.result, { count: 1 })
    await f.call('GET', `/member/order/${paidOrderId}`, f.payer.token)
    assert.deepEqual((await f.call('GET', '/member/order/attention', f.payer.token)).body.result, { count: 0 })
    const refreshed = (await f.call('GET', '/member/family-orders/page', f.payer.token)).body.result
    assert.equal(refreshed.items.find((order: { id: string }) => order.id === paidOrderId).needsAttention, false)
  } finally { await f.ctx.app.close() }
})

test('B-42：确认中支付禁止重付并继续占用库存', async () => {
  const f = await fixture()
  try {
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    const orderId = await f.createOrder()
    const started = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    assert.equal(started.status, 200)
    const duplicate = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    assert.equal(duplicate.status, 409)
    const detail = await f.call('GET', `/member/order/${orderId}`, f.buyer.token)
    assert.equal(detail.body.result.paymentState, 'confirming')
    assert.equal(detail.body.result.canPay, false)
    assert.equal(detail.body.result.countdown, 0)
    assert.equal(f.ctx.catalog.sku(f.sku.id).stock, 6)
  } finally { await f.ctx.app.close() }
})

test('B-40：默认模拟渠道成功回调创建且仅保留一笔有效支付', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    const started = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    assert.equal(started.status, 200)
    const detail = await f.call('GET', `/member/order/${orderId}`, f.buyer.token)
    assert.equal(detail.body.result.orderState, 2)
    assert.equal(detail.body.result.paymentState, 'paid')
    assert.equal(f.ctx.db.all('SELECT id FROM payments WHERE order_id=? AND state=\'succeeded\'', orderId).length, 1)
  } finally { await f.ctx.app.close() }
})

test('B-44：签名错误的支付回调不改变订单状态', async () => {
  const f = await fixture()
  try {
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    const orderId = await f.createOrder()
    const started = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    const callback = f.ctx.payments.signedCallback(started.body.result.paymentId, { state: 'success', paidAt: f.clock.now() })
    callback.signature = '0'.repeat(64)
    const response = await f.call('POST', '/payments/callback', '', callback)
    assert.equal(response.status, 401)
    assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 1)
  } finally { await f.ctx.app.close() }
})

test('无有效支付的订单不进入商家待发货列表且不能发货', async () => {
  const f = await fixture()
  try {
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    const orderId = await f.createOrder()
    await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    const sellerOrders = await f.call('GET', '/merchant/orders', f.merchant.token)
    assert.equal(sellerOrders.body.result.some((order: { id: string }) => order.id === orderId), false)
    f.ctx.db.run('UPDATE orders SET state=2 WHERE id=?', orderId)
    assert.equal((await f.call('POST', `/merchant/orders/${orderId}/ship`, f.merchant.token)).status, 409)
    assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 2)

    const refundedOrder = await f.createOrder()
    const paid = await f.call('POST', `/member/order/${refundedOrder}/mock-pay`, f.buyer.token, { amountCents })
    f.ctx.db.run("INSERT INTO refunds(id,payment_id,amount,reason,state,attempts,next_attempt_at,created) VALUES(?,?,?,'late','pending',0,?,?)",
      randomUUID(), paid.body.result.paymentId, amountCents, f.clock.now(), f.clock.now())
    assert.equal((await f.call('POST', `/merchant/orders/${refundedOrder}/ship`, f.merchant.token)).status, 409)
    assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', refundedOrder)!.state, 2)
  } finally { await f.ctx.app.close() }
})

test('迁移 007 将版本 6 历史已付款订单补成有效支付且重复启动不重复补单', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-payment-migration-'))
  const path = join(root, 'v6.sqlite')
  const raw = new DatabaseSync(path)
  try {
    raw.exec(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'))
    raw.exec(`CREATE TABLE categories(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT REFERENCES categories(id),source_key TEXT UNIQUE NOT NULL);
      CREATE TABLE product_categories(product_id TEXT PRIMARY KEY REFERENCES products(id),category_id TEXT NOT NULL REFERENCES categories(id));
      CREATE INDEX product_categories_category ON product_categories(category_id);
      CREATE INDEX orders_owner_state_created ON orders(owner_id,state,created DESC,id);
      PRAGMA user_version=2;`)
    raw.exec(await readFile(new URL('../src/migrations/003-inventory.sql', import.meta.url), 'utf8'))
    raw.exec(await readFile(new URL('../src/migrations/004-stock-adjustment.sql', import.meta.url), 'utf8'))
    raw.exec(await readFile(new URL('../src/migrations/006-address-autosave.sql', import.meta.url), 'utf8'))
    raw.exec('PRAGMA user_version=6')
    raw.exec(`INSERT INTO users(id,account,password,nickname) VALUES('buyer','legacy_buyer','x','买家');
      INSERT INTO products(id,name,category,picture,description) VALUES('legacy-product','旧商品','测试','/assets/product.svg','旧商品');
      INSERT INTO skus(id,product_id,spec,price,stock) VALUES('legacy-sku','legacy-product','标准',2475,3);
      INSERT INTO orders(id,owner_id,state,amount,address,request_key,request_body,created,expires,paid_by,paid_at)
        VALUES('paid-order','buyer',2,2475,'{}','paid-key','{}',1000,901000,'buyer',2000);
      INSERT INTO orders(id,owner_id,state,amount,address,request_key,request_body,created,expires)
        VALUES('unpaid-order','buyer',1,2475,'{}','unpaid-key','{}',3000,903000);`)
  } finally { raw.close() }
  let migrated: Database | undefined
  try {
    migrated = new Database(path)
    assert.equal(migrated.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 14)
    assert.deepEqual(migrated.all<{ order_id: string; payer_id: string; amount: number; state: string; created: number; channel_paid_at: number }>(
      'SELECT order_id,payer_id,amount,state,created,channel_paid_at FROM payments').map(row => ({ ...row })), [
      { order_id: 'paid-order', payer_id: 'buyer', amount: 2475, state: 'succeeded', created: 2000, channel_paid_at: 2000 }
    ])
    const refundColumns = migrated.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>('PRAGMA table_info(refunds)')
    assert.ok(refundColumns.some(column => column.name === 'created' && column.type === 'INTEGER' && column.notnull === 1 && column.dflt_value === null))
    assert.ok(migrated.all<{ name: string }>('PRAGMA table_info(refunds)').some(column => column.name === 'review_at'))
    assert.ok(migrated.one("SELECT name FROM sqlite_master WHERE type='table' AND name='refund_retry_actions'"))
    assert.ok(migrated.one("SELECT name FROM sqlite_master WHERE type='index' AND name='refund_retry_actions_refund'"))
    migrated.close(); migrated = undefined
    migrated = new Database(path)
    assert.equal(migrated.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 14)
    assert.equal(migrated.all('SELECT id FROM payments').length, 1)
    migrated.close(); migrated = undefined
  } finally { migrated?.close(); await rm(root, { recursive: true, force: true }) }
})

async function invitePayer(f: Awaited<ReturnType<typeof fixture>>, orderId: string) {
  f.ctx.testData.relation({ ownerId: f.buyer.id, friendId: f.payer.id })
  const response = await f.call('PUT', `/member/order/${orderId}/payer`, f.buyer.token, { friendId: f.payer.id })
  assert.equal(response.status, 200)
}

test('B-42：本人和亲友付款都不能重复支付，确认中库存保持占用', async () => {
  for (const family of [false, true]) {
    const f = await fixture()
    try {
      const orderId = await f.createOrder()
      if (family) await invitePayer(f, orderId)
      f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
      const token = family ? f.payer.token : f.buyer.token
      assert.equal((await f.call('POST', `/member/order/${orderId}/payments`, token, { amountCents })).status, 200)
      assert.equal((await f.call('POST', `/member/order/${orderId}/payments`, token, { amountCents })).status, 409)
      assert.equal(f.ctx.catalog.sku(f.sku.id).stock, 6)
    } finally { await f.ctx.app.close() }
  }
})

test('B-43：本人和亲友支付都忽略已成功支付单的重复及乱序回调', async () => {
  for (const family of [false, true]) {
    const f = await fixture()
    try {
      const orderId = await f.createOrder()
      if (family) await invitePayer(f, orderId)
      const token = family ? f.payer.token : f.buyer.token
      const started = await f.call('POST', `/member/order/${orderId}/payments`, token, { amountCents })
      const success = f.ctx.payments.signedCallback(started.body.result.paymentId, { state: 'success', paidAt: f.clock.now() })
      const duplicate = await f.call('POST', '/payments/callback', '', success)
      assert.equal(duplicate.status, 200)
      const stale = f.ctx.payments.signedCallback(started.body.result.paymentId, { state: 'fail' })
      assert.equal((await f.call('POST', '/payments/callback', '', stale)).status, 200)
      assert.equal(f.ctx.db.one<{ callback_state: string }>('SELECT callback_state FROM payments WHERE id=?', started.body.result.paymentId)!.callback_state, 'success')
      assert.equal(f.ctx.db.all("SELECT id FROM refunds WHERE payment_id=?", started.body.result.paymentId).length, 0)
    } finally { await f.ctx.app.close() }
  }
})

test('B-44：本人和亲友支付都拒绝签名错误、金额不符和订单不符的回调', async () => {
  for (const family of [false, true]) {
    const f = await fixture()
    try {
      const orderId = await f.createOrder()
      if (family) await invitePayer(f, orderId)
      f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
      const token = family ? f.payer.token : f.buyer.token
      const started = await f.call('POST', `/member/order/${orderId}/payments`, token, { amountCents })
      const paymentId = started.body.result.paymentId as string
      const invalidSignature = f.ctx.payments.signedCallback(paymentId, { state: 'success' })
      invalidSignature.signature = '0'.repeat(64)
      assert.equal((await f.call('POST', '/payments/callback', '', invalidSignature)).status, 401)
      const wrongAmount = f.ctx.payments.signedCallback(paymentId, { state: 'success', amount: amountCents + 1 })
      assert.equal((await f.call('POST', '/payments/callback', '', wrongAmount)).status, 400)
      const wrongOrder = f.ctx.payments.signedCallback(paymentId, { state: 'success', orderId: randomUUID() })
      assert.equal((await f.call('POST', '/payments/callback', '', wrongOrder)).status, 400)
      assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 1)
    } finally { await f.ctx.app.close() }
  }
})

test('B-47：本人和亲友的宽限期后成功各自退款且只查看自己的付款明细', async () => {
  for (const family of [false, true]) {
    const f = await fixture()
    try {
      const orderId = await f.createOrder()
      if (family) await invitePayer(f, orderId)
      f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'success', paidAt: f.clock.now() + 10 * 60_000 + 1 } })
      const token = family ? f.payer.token : f.buyer.token
      const started = await f.call('POST', `/member/order/${orderId}/payments`, token, { amountCents })
      const row = f.ctx.db.one<{ payer_id: string; amount: number; reason: string }>('SELECT p.payer_id,r.amount,r.reason FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.order_id=?', orderId)!
      assert.equal(row.payer_id, family ? f.payer.id : f.buyer.id)
      assert.equal(row.amount, amountCents)
      assert.equal(row.reason, 'late')
      assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 6)
      const visible = await f.call('GET', `/member/order/${orderId}`, token)
      assert.equal(visible.status, 200)
      assert.equal(visible.body.result.refunds.length, 1)
      assert.equal(visible.body.result.refunds[0].amount, amountCents / 100)
      assert.equal(visible.body.result.refunds[0].payerAccount, family ? f.payer.account : f.buyer.account)
      assert.equal(visible.body.result.refunds[0].paidAt, f.clock.now() + 10 * 60_000 + 1)
      assert.equal(visible.body.result.refunds[0].state, '已退款')
      if (family) {
        assert.equal(visible.body.result.address, undefined)
        assert.deepEqual(visible.body.result.skus, [])
        assert.equal((await f.call('GET', `/member/order/${orderId}`, f.payer.token)).status, 200)
        assert.equal((await f.call('GET', `/member/order/${orderId}`, f.merchant.token)).status, 403)
        const stranger = f.ctx.testData.account({ account: `stranger_${randomUUID().replaceAll('-', '').slice(0, 8)}`, password })
        assert.equal((await f.call('GET', `/member/order/${orderId}`, stranger.token)).status, 403)
      }
      const repeated = await f.call('POST', '/payments/callback', '', f.ctx.payments.signedCallback(started.body.result.paymentId, { state: 'success' }))
      assert.equal(repeated.status, 200)
      assert.equal(f.ctx.db.all('SELECT id FROM refunds WHERE payment_id IN (SELECT id FROM payments WHERE order_id=?)', orderId).length, 1)
    } finally { await f.ctx.app.close() }
  }
})

test('付款亲友的退款提醒按用户分别清除，仍可见自身退款但无权查看地址商品', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    await invitePayer(f, orderId)
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'fail' } })
    const first = await f.call('POST', `/member/order/${orderId}/payments`, f.payer.token, { amountCents })
    await f.call('PUT', `/member/order/${orderId}/payer`, f.buyer.token, { friendId: null })
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'success' } })
    await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    f.ctx.testData.payments({ paymentId: first.body.result.paymentId, preset: { outcome: 'success' } })
    await f.call('POST', '/payments/callback', '', f.ctx.payments.signedCallback(first.body.result.paymentId, { state: 'success' }))

    const buyerUnread = await f.call('GET', '/member/order?orderState=2', f.buyer.token)
    const payerUnread = await f.call('GET', '/member/family-orders/page', f.payer.token)
    assert.equal(buyerUnread.body.result.items[0].needsAttention, true)
    assert.equal(payerUnread.body.result.items[0].needsAttention, true)

    const payerOrder = await f.call('GET', `/member/order/${orderId}`, f.payer.token)
    assert.equal(payerOrder.status, 200)
    assert.equal(payerOrder.body.result.skus.length, 0)
    assert.equal(payerOrder.body.result.address, undefined)
    assert.equal(payerOrder.body.result.paymentState, 'paid')
    assert.match(payerOrder.body.result.paymentNotice, /原路退回/)
    const stranger = f.ctx.testData.account({ account: `stranger_${randomUUID().replaceAll('-', '').slice(0, 8)}`, password })
    assert.equal((await f.call('GET', `/member/order/${orderId}`, stranger.token)).status, 403)
    assert.deepEqual(payerOrder.body.result.refunds.map((refund: { amount: number; payerAccount: string; state: string }) =>
      ({ amount: refund.amount, payerAccount: refund.payerAccount, state: refund.state })),
    [{ amount: amountCents / 100, payerAccount: f.payer.account, state: '已退款' }])
    assert.equal((await f.call('GET', `/member/order/${orderId}`, f.merchant.token)).status, 403)
    assert.equal((await f.call('GET', `/member/family-orders/page`, f.payer.token)).body.result.items[0].needsAttention, false)
    assert.equal((await f.call('GET', '/member/order?orderState=2', f.buyer.token)).body.result.items[0].needsAttention, true)
    await f.call('GET', `/member/order/${orderId}`, f.buyer.token)
    assert.equal((await f.call('GET', '/member/order?orderState=2', f.buyer.token)).body.result.items[0].needsAttention, false)
  } finally { await f.ctx.app.close() }
})

test('B-45 与 B-56：付款截止前一分钟可发起，T2 恰好在宽限截止仍成功', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    f.advance(14 * 60_000 + 59_000)
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'success', paidAt: f.clock.now() + 10 * 60_000 } })
    const started = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    assert.equal(started.status, 200)
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM payments WHERE id=?', started.body.result.paymentId)!.state, 'succeeded')
    assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 2)
  } finally { await f.ctx.app.close() }
})

test('B-56：付款截止时发起被拒并释放库存，且不创建支付单', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    f.advance(15 * 60_000)
    assert.equal((await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })).status, 409)
    assert.equal(f.ctx.db.all('SELECT id FROM payments WHERE order_id=?', orderId).length, 0)
    assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 6)
    assert.equal(f.ctx.catalog.sku(f.sku.id).stock, 7)
  } finally { await f.ctx.app.close() }
})

test('B-46 与 B-58：未知结果在宽限期后查单并于 24 小时转人工，库存保留', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    f.advance(10 * 60_000)
    await f.ctx.payments.reconcile(f.clock.now())
    assert.equal(f.ctx.catalog.sku(f.sku.id).stock, 6)
    f.advance(24 * 60 * 60_000)
    await f.ctx.payments.reconcile(f.clock.now())
    const merchant = f.ctx.accounts.login(f.merchant.account, password)
    const buyer = f.ctx.accounts.login(f.buyer.account, password)
    const review = await f.call('GET', '/merchant/payments/review', merchant.token)
    assert.equal(review.status, 200, JSON.stringify(review.body))
    assert.equal(review.body.result.items.length, 1)
    assert.equal(review.body.result.items[0].orderId, orderId)
    assert.equal(f.ctx.db.one<{ review_at: number }>('SELECT review_at FROM payments WHERE order_id=?', orderId)!.review_at, f.clock.now())
    const refreshedBuyer = f.ctx.accounts.login(f.buyer.account, password)
    const list = await f.call('GET', '/member/order?orderState=1', refreshedBuyer.token)
    assert.equal(list.body.result.items[0].needsAttention, true)
    const detailAfterList = await f.call('GET', `/member/order/${orderId}`, refreshedBuyer.token)
    assert.equal(detailAfterList.body.result.paymentState, 'review')
    assert.equal(detailAfterList.body.result.needsAttention, false)
    const resolution = { outcome: 'unpaid', reason: '渠道确认没有扣款', requestKey: randomUUID() }
    const paymentId = review.body.result.items[0].id as string
    assert.equal(detailAfterList.body.result.canCancel, true)
    assert.equal((await f.call('POST', `/merchant/payments/${paymentId}/requery`, buyer.token)).status, 403)
    assert.equal((await f.call('POST', `/merchant/payments/${paymentId}/requery`, merchant.token)).status, 200)
    assert.equal((await f.call('PUT', `/merchant/payments/${paymentId}/resolution`, merchant.token, resolution)).status, 200)
    assert.equal((await f.call('PUT', `/merchant/payments/${paymentId}/resolution`, merchant.token, resolution)).status, 200)
    assert.equal(f.ctx.db.all('SELECT id FROM payment_review_resolutions WHERE payment_id=?', paymentId).length, 1)
    assert.equal((await f.call('POST', `/merchant/orders/${orderId}/ship`, merchant.token)).status, 409)
  } finally { await f.ctx.app.close() }
})

test('转人工后继续按间隔查单并在渠道成功时清除核实状态', async () => {
  let outcome: 'unknown' | 'success' = 'unknown'
  let paymentCreated = 0
  let paymentAmount = amountCents
  let queryCount = 0
  const channel: PaymentChannel = {
    create: payment => { paymentCreated = payment.created; paymentAmount = payment.amount; return { accepted: true } },
    query: () => { queryCount++; return outcome === 'success' ? { state: 'success', paidAt: paymentCreated, amount: paymentAmount } : { state: 'unknown' } },
    close: () => ({ state: 'closed' }),
    refund: () => 'success'
  }
  const f = await fixture(channel)
  try {
    const orderId = await f.createOrder()
    await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    f.advance(10 * 60_000)
    await f.ctx.payments.reconcile(f.clock.now())
    f.advance(24 * 60 * 60_000)
    await f.ctx.payments.reconcile(f.clock.now())
    const payment = f.ctx.db.one<{ id: string; review_at: number | null; state: string }>(
      'SELECT id,review_at,state FROM payments WHERE order_id=?', orderId)!
    assert.ok(payment.review_at)
    const queryCountAtReview = queryCount
    outcome = 'success'
    for (let attempt = 0; attempt < 5; attempt++) {
      f.advance(31 * 60_000)
      await f.ctx.payments.reconcile(f.clock.now())
    }
    assert.ok(queryCount > queryCountAtReview, '转人工后应继续调用渠道查单')
    const settled = f.ctx.db.one<{ state: string; review_at: number | null }>(
      'SELECT state,review_at FROM payments WHERE id=?', payment.id)!
    assert.equal(settled.state, 'succeeded')
    assert.equal(settled.review_at, null)
    const merchant = f.ctx.accounts.login(f.merchant.account, password)
    const review = await f.call('GET', '/merchant/payments/review', merchant.token)
    assert.equal(review.body.result.items.some((item: { id: string }) => item.id === payment.id), false)
    const buyer = f.ctx.accounts.login(f.buyer.account, password)
    const detail = await f.call('GET', `/member/order/${orderId}`, buyer.token)
    assert.equal(detail.body.result.paymentState, 'paid')
  } finally { await f.ctx.app.close() }
})

test('渠道关单及查单都明确返回 closed 时按未付款处理', async () => {
  const closedChannel: PaymentChannel = {
    create: () => ({ accepted: true }),
    query: () => ({ state: 'closed' }),
    close: () => ({ state: 'closed' }),
    refund: () => 'success'
  }
  const beforeDeadline = await fixture(closedChannel)
  try {
    const orderId = await beforeDeadline.createOrder()
    const started = await beforeDeadline.call('POST', `/member/order/${orderId}/payments`, beforeDeadline.buyer.token, { amountCents })
    beforeDeadline.advance(10 * 60_000)
    await beforeDeadline.ctx.payments.reconcile(beforeDeadline.clock.now())
    assert.equal(beforeDeadline.ctx.db.one<{ state: string }>('SELECT state FROM payments WHERE id=?', started.body.result.paymentId)!.state, 'failed')
    assert.equal(beforeDeadline.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 1)
    assert.equal((await beforeDeadline.call('GET', `/member/order/${orderId}`, beforeDeadline.buyer.token)).body.result.canPay, true)
    assert.equal(beforeDeadline.ctx.catalog.sku(beforeDeadline.sku.id).stock, 6)
  } finally { await beforeDeadline.ctx.app.close() }

  const afterDeadline = await fixture(closedChannel)
  try {
    const orderId = await afterDeadline.createOrder()
    const started = await afterDeadline.call('POST', `/member/order/${orderId}/payments`, afterDeadline.buyer.token, { amountCents })
    afterDeadline.advance(15 * 60_000)
    await afterDeadline.ctx.payments.reconcile(afterDeadline.clock.now())
    assert.equal(afterDeadline.ctx.db.one<{ state: string }>('SELECT state FROM payments WHERE id=?', started.body.result.paymentId)!.state, 'failed')
    assert.equal(afterDeadline.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 6)
    assert.equal(afterDeadline.ctx.catalog.sku(afterDeadline.sku.id).stock, 7)
    assert.equal(afterDeadline.ctx.db.all("SELECT id FROM inventory_movements WHERE order_id=? AND kind='expire'", orderId).length, 1)
  } finally { await afterDeadline.ctx.app.close() }
})

test('回调成功与渠道 closed 相反时连续两次后转人工而非判失败', async () => {
  class ClosedMockChannel extends MockPaymentChannel {
    query(paymentId: string) { super.query(paymentId); return { state: 'closed' as const } }
    close(paymentId: string) { super.close(paymentId); return { state: 'closed' as const } }
  }
  const channel: PaymentChannel = new ClosedMockChannel('development-payment-callback-secret-32-bytes')
  const f = await fixture(channel)
  try {
    const orderId = await f.createOrder()
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    const started = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    const paymentId = started.body.result.paymentId as string
    const callback = f.ctx.payments.signedCallback(paymentId, { state: 'success', paidAt: f.clock.now() })
    await f.call('POST', '/payments/callback', '', callback)
    assert.equal(f.ctx.db.one<{ state: string; mismatch_count: number }>('SELECT state,mismatch_count FROM payments WHERE id=?', paymentId)!.mismatch_count, 1)
    f.advance(60_000)
    await f.ctx.payments.reconcile(f.clock.now())
    const payment = f.ctx.db.one<{ state: string; mismatch_count: number; review_at: number | null }>(
      'SELECT state,mismatch_count,review_at FROM payments WHERE id=?', paymentId)!
    assert.equal(payment.state, 'pending')
    assert.equal(payment.mismatch_count, 2)
    assert.ok(payment.review_at)
  } finally { await f.ctx.app.close() }
})

test('本地已关单遇到成功回调但渠道查单 closed 时仍按 K13 计入相反次数', async () => {
  let queries = 0
  class ClosedMockChannel extends MockPaymentChannel {
    query(paymentId: string) { queries++; super.query(paymentId); return { state: 'closed' as const } }
    close(paymentId: string) { super.close(paymentId); return { state: 'closed' as const } }
  }
  const channel: PaymentChannel = new ClosedMockChannel('development-payment-callback-secret-32-bytes')
  const f = await fixture(channel)
  try {
    const orderId = await f.createOrder()
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    const started = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    const paymentId = started.body.result.paymentId as string
    assert.equal((await f.call('PUT', `/member/order/${orderId}/cancel`, f.buyer.token)).status, 200)
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM payments WHERE id=?', paymentId)!.state, 'closed')
    const queriesAfterClose = queries
    f.advance(31 * 60_000)
    await f.ctx.payments.reconcile(f.clock.now())
    assert.equal(queries, queriesAfterClose, '已关闭支付再次查到 closed 后应停止后台查单')
    const callback = f.ctx.payments.signedCallback(paymentId, { state: 'success', paidAt: f.clock.now() })
    assert.equal((await f.call('POST', '/payments/callback', '', callback)).status, 200)
    const firstMismatch = f.ctx.db.one<{ mismatch_count: number; state: string }>('SELECT mismatch_count,state FROM payments WHERE id=?', paymentId)!
    assert.equal(firstMismatch.mismatch_count, 1)
    assert.equal(firstMismatch.state, 'pending')
    f.advance(60_000)
    await f.ctx.payments.reconcile(f.clock.now())
    const reviewed = f.ctx.db.one<{ mismatch_count: number; review_at: number | null; state: string }>(
      'SELECT mismatch_count,review_at,state FROM payments WHERE id=?', paymentId)!
    assert.equal(reviewed.state, 'pending')
    assert.equal(reviewed.mismatch_count, 2)
    assert.ok(reviewed.review_at)
  } finally { await f.ctx.app.close() }
})

test('B-58：转人工核实后下单人仍可取消并只释放一次库存', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    f.advance(24 * 60 * 60_000)
    await f.ctx.payments.reconcile(f.clock.now())
    const buyerToken = f.ctx.accounts.login(f.buyer.account, password).token
    const detail = await f.call('GET', `/member/order/${orderId}`, buyerToken)
    assert.equal(detail.body.result.paymentState, 'review')
    assert.equal(detail.body.result.canCancel, true)
    assert.equal((await f.call('PUT', `/member/order/${orderId}/cancel`, buyerToken)).status, 200)
    assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 6)
    assert.equal(f.ctx.catalog.sku(f.sku.id).stock, 7)
    assert.equal(f.ctx.db.all("SELECT id FROM inventory_movements WHERE order_id=? AND kind IN ('cancel','expire')", orderId).length, 1)
  } finally { await f.ctx.app.close() }
})

test('商家登记未扣款需原因请求号、留审计且幂等后按失败规则取消订单', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    const started = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    f.advance(24 * 60 * 60_000)
    await f.ctx.payments.reconcile(f.clock.now())
    const paymentId = started.body.result.paymentId as string
    const url = `/merchant/payments/${paymentId}/resolution`
    const requestKey = randomUUID()
    const resolution = { outcome: 'unpaid', reason: '渠道确认没有扣款', requestKey }
    const merchantToken = f.ctx.accounts.login(f.merchant.account, password).token
    assert.equal((await f.call('PUT', url, merchantToken, { outcome: 'unpaid', requestKey })).status, 400)
    assert.equal((await f.call('PUT', url, merchantToken, { outcome: 'unpaid', reason: resolution.reason })).status, 400)
    const buyerToken = f.ctx.accounts.login(f.buyer.account, password).token
    assert.equal((await f.call('PUT', url, buyerToken, resolution)).status, 403)
    assert.equal((await f.call('PUT', url, merchantToken, resolution)).status, 200)
    assert.equal((await f.call('PUT', url, merchantToken, resolution)).status, 200)
    assert.equal((await f.call('PUT', url, merchantToken, { ...resolution, reason: '改写原因并重放' })).status, 409)
    assert.equal((await f.call('PUT', url, merchantToken, { ...resolution, requestKey: randomUUID() })).status, 409)
    const audit = f.ctx.db.one<{ payment_id: string; merchant_id: string; request_key: string; outcome: string; reason: string; paid_at: number | null }>(
      'SELECT payment_id,merchant_id,request_key,outcome,reason,paid_at FROM payment_review_resolutions WHERE payment_id=?', paymentId)!
    assert.deepEqual({ ...audit }, { payment_id: paymentId, merchant_id: f.merchant.id, request_key: requestKey,
      outcome: 'unpaid', reason: resolution.reason, paid_at: null })
    assert.equal(f.ctx.db.all('SELECT id FROM payment_review_resolutions WHERE payment_id=?', paymentId).length, 1)
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM payments WHERE id=?', paymentId)!.state, 'failed')
    assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 6)
    assert.equal(f.ctx.catalog.sku(f.sku.id).stock, 7)
    assert.equal(f.ctx.db.all("SELECT id FROM inventory_movements WHERE order_id=? AND kind='expire'", orderId).length, 1)
  } finally { await f.ctx.app.close() }
})

test('商家提前登记未扣款只结束支付尝试，订单可重新付款且库存仍占用', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'success', query: 'opposite' } })
    const first = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    f.advance(60_000)
    await f.ctx.payments.reconcile(f.clock.now())
    const paymentId = first.body.result.paymentId as string
    const resolution = { outcome: 'unpaid', reason: '渠道确认没有扣款', requestKey: randomUUID() }
    assert.equal((await f.call('PUT', `/merchant/payments/${paymentId}/resolution`, f.merchant.token, resolution)).status, 200)
    assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 1)
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM payments WHERE id=?', paymentId)!.state, 'failed')
    assert.equal(f.ctx.catalog.sku(f.sku.id).stock, 6)
    assert.equal((await f.call('GET', `/member/order/${orderId}`, f.buyer.token)).body.result.canPay, true)
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'success' } })
    assert.equal((await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })).status, 200)
  } finally { await f.ctx.app.close() }
})

test('商家登记已扣款走正常成功结算规则并保留审计记录', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    const started = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    const paymentId = started.body.result.paymentId as string
    const graceDeadline = f.ctx.db.one<{ grace_deadline: number }>('SELECT grace_deadline FROM payments WHERE id=?', paymentId)!.grace_deadline
    f.advance(24 * 60 * 60_000)
    await f.ctx.payments.reconcile(f.clock.now())
    const url = `/merchant/payments/${paymentId}/resolution`
    const merchantToken = f.ctx.accounts.login(f.merchant.account, password).token
    assert.equal((await f.call('PUT', url, merchantToken, { outcome: 'paid', reason: '线下核对已扣款', requestKey: randomUUID() })).status, 400)
    const resolution = { outcome: 'paid', paidAt: graceDeadline, reason: '线下核对已扣款', requestKey: randomUUID() }
    assert.equal((await f.call('PUT', url, merchantToken, resolution)).status, 200)
    assert.equal((await f.call('PUT', url, merchantToken, resolution)).status, 200)
    assert.equal(f.ctx.db.all('SELECT id FROM payment_review_resolutions WHERE payment_id=?', paymentId).length, 1)
    assert.deepEqual({ ...f.ctx.db.one<{ merchant_id: string; outcome: string; paid_at: number; reason: string }>(
      'SELECT merchant_id,outcome,paid_at,reason FROM payment_review_resolutions WHERE payment_id=?', paymentId)! },
    { merchant_id: f.merchant.id, outcome: 'paid', paid_at: graceDeadline, reason: resolution.reason })
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM payments WHERE id=?', paymentId)!.state, 'succeeded')
    assert.deepEqual({ ...f.ctx.db.one<{ state: number; paid_by: string; paid_at: number }>(
      'SELECT state,paid_by,paid_at FROM orders WHERE id=?', orderId)! }, { state: 2, paid_by: f.buyer.id, paid_at: graceDeadline })
    assert.equal(f.ctx.catalog.sku(f.sku.id).stock, 6)
    assert.equal((await f.call('POST', `/merchant/orders/${orderId}/ship`, merchantToken)).status, 200)
  } finally { await f.ctx.app.close() }
})

test('B-53：本人和亲友的重付均保留先被确认的一笔并退款迟到成功', async () => {
  for (const family of [false, true]) {
    const f = await fixture()
    try {
      const orderId = await f.createOrder()
      if (family) await invitePayer(f, orderId)
      const token = family ? f.payer.token : f.buyer.token
      f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'fail' } })
      const first = await f.call('POST', `/member/order/${orderId}/payments`, token, { amountCents })
      f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'success' } })
      const second = await f.call('POST', `/member/order/${orderId}/payments`, token, { amountCents })
      f.ctx.testData.payments({ paymentId: first.body.result.paymentId, preset: { outcome: 'success' } })
      const late = f.ctx.payments.signedCallback(first.body.result.paymentId, { state: 'success', paidAt: f.clock.now() })
      assert.equal((await f.call('POST', '/payments/callback', '', late)).status, 200)
      assert.equal(f.ctx.db.one<{ paid_by: string }>('SELECT paid_by FROM orders WHERE id=?', orderId)!.paid_by, family ? f.payer.id : f.buyer.id)
      assert.equal(f.ctx.db.all("SELECT id FROM payments WHERE order_id=? AND state='succeeded'", orderId).length, 2)
      assert.equal(f.ctx.db.one<{ id: string }>("SELECT id FROM refunds WHERE payment_id=?", first.body.result.paymentId)!.id.length > 0, true)
      assert.equal(f.ctx.db.one<{ id: string }>("SELECT id FROM payments WHERE id=?", second.body.result.paymentId)!.id, second.body.result.paymentId)
    } finally { await f.ctx.app.close() }
  }
})

test('B-53：较早 T2 的迟到成功不替换先确认的亲友付款人', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'fail' } })
    const buyerPayment = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    await invitePayer(f, orderId)
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    const payerPayment = await f.call('POST', `/member/order/${orderId}/payments`, f.payer.token, { amountCents })
    const payerPaidAt = f.clock.now() + 1000
    f.ctx.testData.payments({ paymentId: payerPayment.body.result.paymentId, preset: { outcome: 'success', paidAt: payerPaidAt } })
    assert.equal((await f.call('POST', '/payments/callback', '',
      f.ctx.payments.signedCallback(payerPayment.body.result.paymentId, { state: 'success', paidAt: payerPaidAt }))).status, 200)
    assert.equal(f.ctx.db.one<{ paid_by: string; paid_at: number }>('SELECT paid_by,paid_at FROM orders WHERE id=?', orderId)!.paid_by, f.payer.id)

    f.ctx.testData.payments({ paymentId: buyerPayment.body.result.paymentId, preset: { outcome: 'success', paidAt: f.clock.now() } })
    assert.equal((await f.call('POST', '/payments/callback', '',
      f.ctx.payments.signedCallback(buyerPayment.body.result.paymentId, { state: 'success', paidAt: f.clock.now() }))).status, 200)

    const order = f.ctx.db.one<{ paid_by: string; paid_at: number }>('SELECT paid_by,paid_at FROM orders WHERE id=?', orderId)!
    assert.deepEqual({ ...order }, { paid_by: f.payer.id, paid_at: payerPaidAt })
    assert.deepEqual({ ...f.ctx.db.one<{ payer_id: string; reason: string; amount: number }>(
      'SELECT p.payer_id,r.reason,r.amount FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.id=?', buyerPayment.body.result.paymentId)! },
    { payer_id: f.buyer.id, reason: 'duplicate', amount: amountCents })
    assert.equal(f.ctx.db.all('SELECT id FROM refunds WHERE payment_id IN (SELECT id FROM payments WHERE order_id=?)', orderId).length, 1)
  } finally { await f.ctx.app.close() }
})

test('B-57：本人和亲友付款与查单连续两次相反时转人工且不释放库存', async () => {
  for (const family of [false, true]) {
    const f = await fixture()
    try {
      const orderId = await f.createOrder()
      if (family) await invitePayer(f, orderId)
      f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'success', query: 'opposite' } })
      const token = family ? f.payer.token : f.buyer.token
      const started = await f.call('POST', `/member/order/${orderId}/payments`, token, { amountCents })
      f.advance(60_000)
      await f.ctx.payments.reconcile(f.clock.now())
      assert.ok(f.ctx.db.one<{ review_at: number }>('SELECT review_at FROM payments WHERE id=?', started.body.result.paymentId)!.review_at)
      assert.equal(f.ctx.catalog.sku(f.sku.id).stock, 6)
      const buyerList = await f.call('GET', '/member/order?orderState=1', f.buyer.token)
      assert.equal(buyerList.body.result.items[0].needsAttention, true)
      if (family) {
        const payerList = await f.call('GET', '/member/family-orders/page', f.payer.token)
        assert.equal(payerList.body.result.items[0].needsAttention, true)
        await f.call('GET', `/member/order/${orderId}`, f.buyer.token)
        assert.equal((await f.call('GET', '/member/order?orderState=1', f.buyer.token)).body.result.items[0].needsAttention, false)
        const payerStillUnread = await f.call('GET', '/member/family-orders/page', f.payer.token)
        assert.equal(payerStillUnread.body.result.items[0].needsAttention, true)
        await f.call('GET', `/member/order/${orderId}`, f.payer.token)
        const payerRead = await f.call('GET', '/member/family-orders/page', f.payer.token)
        assert.equal(payerRead.body.result.items[0].needsAttention, false)
      }
    } finally { await f.ctx.app.close() }
  }
})

test('B-59：确认中下单人取消并遇到渠道已扣款只退款一次，亲友不能取消', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    await invitePayer(f, orderId)
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'close-paid' } })
    const started = await f.call('POST', `/member/order/${orderId}/payments`, f.payer.token, { amountCents })
    assert.equal((await f.call('PUT', `/member/order/${orderId}/cancel`, f.payer.token)).status, 403)
    assert.equal((await f.call('PUT', `/member/order/${orderId}/cancel`, f.buyer.token)).status, 200)
    assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 6)
    assert.equal(f.ctx.db.all('SELECT id FROM refunds WHERE payment_id=?', started.body.result.paymentId).length, 1)
    assert.equal(f.ctx.catalog.sku(f.sku.id).stock, 7)
  } finally { await f.ctx.app.close() }
})

test('mock-pay 不会把注入的非模拟渠道当作模拟器调用', async () => {
  let createCalls = 0
  const f = await buildTestApp({ databasePath: ':memory:', uploadsPath: './unused', publicUrl: 'http://127.0.0.1:3000',
    mockPayments: true, paymentChannel: {
      create: () => { createCalls++; return { accepted: true } },
      query: () => ({ state: 'unknown' }), close: () => ({ state: 'closed' }), refund: () => 'success'
    } })
  try {
    const buyer = f.testData.account({ account: 'mock_channel_buyer', password })
    const address = f.testData.address({ userId: buyer.id, receiver: '买家', contact: '13800000000', address: '测试地址' })
    const product = f.testData.product({ name: '模拟渠道隔离商品', skus: [{ spec: '标准', priceCents: amountCents, stock: 1 }] })
    const order = await f.app.inject({ method: 'POST', url: '/member/order', headers: { authorization: `Bearer ${buyer.token}` },
      payload: { addressId: address.id, requestKey: randomUUID(), expectedAmountCents: amountCents, goods: [{ skuId: product.skus[0]!.id, count: 1 }] } })
    const response = await f.app.inject({ method: 'POST', url: `/member/order/${order.json().result.id}/mock-pay`,
      headers: { authorization: `Bearer ${buyer.token}` }, payload: { amountCents } })
    assert.equal(response.statusCode, 403)
    assert.equal(createCalls, 0)
  } finally { await f.app.close() }
})

test('付款渠道缺失时返回 503，正式环境配置渠道但缺少回调密钥时拒绝启动', async () => {
  const f = await buildTestApp({ databasePath: ':memory:', uploadsPath: './unused', publicUrl: 'http://127.0.0.1:3000',
    mockPayments: false, paymentChannel: null })
  try {
    const buyer = f.testData.account({ account: 'no_channel_buyer', password })
    const address = f.testData.address({ userId: buyer.id, receiver: '买家', contact: '13800000000', address: '测试地址' })
    const product = f.testData.product({ name: '未配置渠道商品', skus: [{ spec: '标准', priceCents: amountCents, stock: 1 }] })
    const order = await f.app.inject({ method: 'POST', url: '/member/order', headers: { authorization: `Bearer ${buyer.token}` },
      payload: { addressId: address.id, requestKey: randomUUID(), expectedAmountCents: amountCents, goods: [{ skuId: product.skus[0]!.id, count: 1 }] } })
    const started = await f.app.inject({ method: 'POST', url: `/member/order/${order.json().result.id}/payments`,
      headers: { authorization: `Bearer ${buyer.token}` }, payload: { amountCents } })
    assert.equal(started.statusCode, 503)
  } finally { await f.app.close() }
  await assert.rejects(() => buildApp({ databasePath: ':memory:', uploadsPath: './unused', publicUrl: 'https://example.invalid',
    mockPayments: false, production: true, corsOrigins: ['https://example.invalid'], paymentChannel: { create: () => ({ accepted: true }),
      query: () => ({ state: 'unknown' }), close: () => ({ state: 'closed' }), refund: () => 'success' } }), /PAYMENT_CALLBACK_SECRET/)
})

test('B-40、B-50：本人和付款亲友成功后都能查看有效支付状态', async () => {
  for (const family of [false, true]) {
    const f = await fixture()
    try {
      const orderId = await f.createOrder()
      if (family) await invitePayer(f, orderId)
      const token = family ? f.payer.token : f.buyer.token
      assert.equal((await f.call('POST', `/member/order/${orderId}/payments`, token, { amountCents })).status, 200)
      const buyerOrder = await f.call('GET', `/member/order/${orderId}`, f.buyer.token)
      const payerOrder = await f.call('GET', `/member/order/${orderId}`, f.payer.token)
      assert.equal(buyerOrder.body.result.paymentState, 'paid')
      if (family) {
        assert.equal(payerOrder.body.result.paymentState, 'paid')
        assert.equal(payerOrder.body.result.skus.length, 1)
        assert.equal(payerOrder.body.result.address, undefined)
      } else assert.equal(payerOrder.status, 403)
    } finally { await f.ctx.app.close() }
  }
})

test('B-41、B-51：失败后可重付；已解绑亲友不能发起下一笔支付', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    await invitePayer(f, orderId)
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'fail' } })
    assert.equal((await f.call('POST', `/member/order/${orderId}/payments`, f.payer.token, { amountCents })).status, 200)
    const relation = f.ctx.db.one<{ id: string }>('SELECT id FROM relations WHERE owner_id=? AND friend_id=?', f.buyer.id, f.payer.id)!
    f.ctx.accounts.updateRelation(f.ctx.accounts.authenticate(`Bearer ${f.buyer.token}`), relation.id, 'revoke')
    assert.equal((await f.call('POST', `/member/order/${orderId}/payments`, f.payer.token, { amountCents })).status, 403)
    assert.equal((await f.call('PUT', `/member/order/${orderId}/payer`, f.buyer.token, { friendId: null })).status, 200)
    assert.equal((await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })).status, 200)
  } finally { await f.ctx.app.close() }
})

test('B-48、B-55：无支付订单超时和宽限内失败延至付款截止后均只释放一次', async () => {
  for (const paymentStarted of [false, true]) {
    const f = await fixture()
    try {
      const orderId = await f.createOrder()
      if (paymentStarted) {
        f.advance(14 * 60_000 + 59_000)
        f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
        const started = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
        f.advance(1000)
        f.ctx.testData.payments({ paymentId: started.body.result.paymentId, preset: { outcome: 'fail' } })
        const failed = f.ctx.payments.signedCallback(started.body.result.paymentId, { state: 'fail' })
        await f.call('POST', '/payments/callback', '', failed)
      } else {
        f.advance(15 * 60_000)
        f.ctx.orders.expire(f.clock.now())
      }
      assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 6)
      assert.equal(f.ctx.catalog.sku(f.sku.id).stock, 7)
      assert.equal(f.ctx.db.all('SELECT id FROM inventory_movements WHERE order_id=? AND kind IN (\'expire\',\'cancel\')', orderId).length, 1)
    } finally { await f.ctx.app.close() }
  }
})

test('B-57：本人和亲友付款的查单成功缺少交易时间时均保持确认中', async () => {
  for (const family of [false, true]) {
    const f = await fixture()
    try {
      const orderId = await f.createOrder()
      if (family) await invitePayer(f, orderId)
      f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
      const token = family ? f.payer.token : f.buyer.token
      const started = await f.call('POST', `/member/order/${orderId}/payments`, token, { amountCents })
      f.ctx.testData.payments({ paymentId: started.body.result.paymentId, preset: { outcome: 'success', query: 'missing-time' } })
      const callback = f.ctx.payments.signedCallback(started.body.result.paymentId, { state: 'success' })
      await f.call('POST', '/payments/callback', '', callback)
      assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 1)
      assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM payments WHERE id=?', started.body.result.paymentId)!.state, 'pending')
    } finally { await f.ctx.app.close() }
  }
})

test('迁移 007 中途外键失败整体回滚，修复历史付款人后可重新升级', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-payment-rollback-'))
  const path = join(root, 'v6.sqlite')
  const raw = new DatabaseSync(path)
  try {
    raw.exec(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'))
    raw.exec(`CREATE TABLE categories(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT REFERENCES categories(id),source_key TEXT UNIQUE NOT NULL);
      CREATE TABLE product_categories(product_id TEXT PRIMARY KEY REFERENCES products(id),category_id TEXT NOT NULL REFERENCES categories(id));
      CREATE INDEX product_categories_category ON product_categories(category_id);
      CREATE INDEX orders_owner_state_created ON orders(owner_id,state,created DESC,id);
      PRAGMA user_version=2;`)
    raw.exec(await readFile(new URL('../src/migrations/003-inventory.sql', import.meta.url), 'utf8'))
    raw.exec(await readFile(new URL('../src/migrations/004-stock-adjustment.sql', import.meta.url), 'utf8'))
    raw.exec(await readFile(new URL('../src/migrations/006-address-autosave.sql', import.meta.url), 'utf8'))
    raw.exec('PRAGMA foreign_keys=OFF; PRAGMA user_version=6;')
    raw.exec(`INSERT INTO users(id,account,password,nickname) VALUES('buyer','rollback_buyer','x','买家');
      INSERT INTO products(id,name,category,picture,description) VALUES('rollback-product','旧商品','测试','/assets/product.svg','旧商品');
      INSERT INTO skus(id,product_id,spec,price,stock) VALUES('rollback-sku','rollback-product','标准',2475,1);
      INSERT INTO orders(id,owner_id,state,amount,address,request_key,request_body,created,expires,paid_by,paid_at)
        VALUES('rollback-order','buyer',2,2475,'{}','paid-key','{}',1000,901000,'missing-payer',2000);
      CREATE TABLE refund_retry_actions(dummy INTEGER);`)
  } finally { raw.close() }
  try {
    assert.throws(() => new Database(path), /refund_retry_actions already exists/)
    const inspect = new DatabaseSync(path)
    try {
      assert.equal(inspect.prepare('PRAGMA user_version').get()!.user_version, 6)
      assert.equal(inspect.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='payments'").get(), undefined)
      assert.equal(inspect.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='refunds'").get(), undefined)
      assert.ok(inspect.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='refund_retry_actions'").get())
      inspect.exec('DROP TABLE refund_retry_actions')
    } finally { inspect.close() }
    assert.throws(() => new Database(path), /FOREIGN KEY constraint failed/)
    const afterForeignKey = new DatabaseSync(path)
    try {
      assert.equal(afterForeignKey.prepare('PRAGMA user_version').get()!.user_version, 6)
      assert.equal(afterForeignKey.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='payments'").get(), undefined)
      assert.equal(afterForeignKey.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='refund_retry_actions'").get(), undefined)
      afterForeignKey.prepare('INSERT INTO users(id,account,password,nickname) VALUES(?,?,?,?)').run('missing-payer','fixed_payer','x','亲友')
    } finally { afterForeignKey.close() }
    const migrated = new Database(path)
    try {
      assert.equal(migrated.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 14)
      assert.ok(migrated.one("SELECT name FROM sqlite_master WHERE type='table' AND name='refund_retry_actions'"))
    }
    finally { migrated.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v7 备份统计支付、退款与退款重试审计，并报告缺少有效支付的已付款订单', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-payment-backup-'))
  const path = join(root, 'live', 'mall.sqlite')
  const f = await buildTestApp({ databasePath: path, uploadsPath: join(root, 'live', 'uploads'), publicUrl: 'http://127.0.0.1:3000', mockPayments: true })
  try {
    const buyer = f.testData.account({ account: 'backup_buyer', password })
    const address = f.testData.address({ userId: buyer.id, receiver: '买家', contact: '13800000000', address: '测试地址' })
    const product = f.testData.product({ name: '备份支付商品', skus: [{ spec: '标准', priceCents: amountCents, stock: 2 }] })
    const created = await f.app.inject({ method: 'POST', url: '/member/order', headers: { authorization: `Bearer ${buyer.token}` },
      payload: { addressId: address.id, requestKey: randomUUID(), expectedAmountCents: amountCents, goods: [{ skuId: product.skus[0]!.id, count: 1 }] } })
    const orderId = created.json().result.id as string
    await f.app.inject({ method: 'POST', url: `/member/order/${orderId}/mock-pay`, headers: { authorization: `Bearer ${buyer.token}` }, payload: { amountCents } })
    f.db.run('DELETE FROM payments WHERE order_id=?', orderId)
    const backup = await createBackup({ databasePath: path, uploadsPath: join(root, 'live', 'uploads'), destination: join(root, 'snapshot') })
    assert.equal(backup.manifest.schemaVersion, 14)
    assert.equal(backup.counts.payments, 0)
    assert.equal(backup.counts.refunds, 0)
    assert.equal(backup.counts.refund_retry_actions, 0)
    assert.deepEqual(backup.manifest.issues.filter(issue => issue.type === 'payment-mismatch'), [{ type: 'payment-mismatch', orderId }])
    const verified = await verifyBackup(backup.root)
    assert.equal(verified.counts.payments, 0)
    assert.equal(verified.counts.refund_retry_actions, 0)
  } finally { await f.app.close(); await rm(root, { recursive: true, force: true }) }
})

test('库存页显示仍被确认中支付占用的商品数量', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    const page = await f.call('GET', `/merchant/inventory?skuId=${f.sku.id}`, f.merchant.token)
    assert.equal(page.body.result.items[0].confirmingCount, 1)
  } finally { await f.ctx.app.close() }
})

test('退款失败后按可控时间重试原退款单，退款通知状态更新且不重复建单', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'success', paidAt: f.clock.now() + 10 * 60_000 + 1, refundFailures: 1 } })
    const started = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    const refund = f.ctx.db.one<{ id: string; state: string; attempts: number }>(
      'SELECT id,state,attempts FROM refunds WHERE payment_id=?', started.body.result.paymentId)!
    assert.equal(refund.state, 'failed')
    assert.equal(refund.attempts, 1)
    f.advance(60_000)
    await f.ctx.payments.reconcile(f.clock.now())
    const retried = f.ctx.db.one<{ id: string; state: string; attempts: number }>('SELECT id,state,attempts FROM refunds WHERE payment_id=?', started.body.result.paymentId)!
    assert.equal(retried.id, refund.id)
    assert.equal(retried.state, 'succeeded')
    assert.equal(retried.attempts, 2)
    assert.equal(f.ctx.db.all('SELECT id FROM refunds WHERE payment_id=?', started.body.result.paymentId).length, 1)
  } finally { await f.ctx.app.close() }
})

test('退款持续失败满 24 小时转人工并停止自动重试，通知下单人与亲友付款人', async () => {
  let refundFails = true
  const channel = new MockPaymentChannel('development-payment-callback-secret-32-bytes')
  channel.refund = () => refundFails ? 'fail' : 'success'
  const f = await fixture(channel)
  try {
    const orderId = await f.createOrder()
    await invitePayer(f, orderId)
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    await f.call('POST', `/member/order/${orderId}/payments`, f.payer.token, { amountCents })
    f.advance(10 * 60_000 + 1)
    f.ctx.testData.payments({ paymentId: f.ctx.db.one<{ id: string }>('SELECT id FROM payments WHERE order_id=?', orderId)!.id,
      preset: { outcome: 'success', paidAt: f.clock.now() } })
    await f.ctx.payments.reconcile(f.clock.now())
    const refundId = f.ctx.db.one<{ id: string; created: number; review_at: number | null }>(
      'SELECT id,created,review_at FROM refunds WHERE payment_id IN (SELECT id FROM payments WHERE order_id=?)', orderId)!.id
    const attemptsAtCreation = f.ctx.db.one<{ attempts: number }>('SELECT attempts FROM refunds WHERE id=?', refundId)!.attempts
    assert.equal(attemptsAtCreation, 1)
    f.advance(24 * 60 * 60_000)
    await f.ctx.payments.reconcile(f.clock.now())
    const refund = f.ctx.db.one<{ attempts: number; review_at: number | null }>('SELECT attempts,review_at FROM refunds WHERE id=?', refundId)!
    assert.equal(refund.attempts, attemptsAtCreation, '达到 24 小时后不再自动尝试')
    assert.ok(refund.review_at)
    f.advance(3 * 3600_000)
    await f.ctx.payments.reconcile(f.clock.now())
    assert.equal(f.ctx.db.one<{ attempts: number }>('SELECT attempts FROM refunds WHERE id=?', refundId)!.attempts, attemptsAtCreation)
    const merchant = f.ctx.accounts.login(f.merchant.account, password)
    const page = await f.call('GET', '/merchant/payments/review', merchant.token)
    assert.ok(page.body.result.items.some((item: { id: string; kind?: string }) => item.id === refundId && item.kind === 'refund'))
    assert.deepEqual(f.ctx.db.all<{ recipient_id: string }>("SELECT recipient_id FROM payment_notices WHERE refund_id=? AND kind='review' ORDER BY recipient_id", refundId)
      .map(row => row.recipient_id).sort(), [f.buyer.id, f.payer.id].sort())
    const owner = f.ctx.accounts.login(f.buyer.account, password)
    assert.equal((await f.call('GET', `/member/order/${orderId}`, owner.token)).body.result.paymentNotice,
      `¥24.75（2026-11-05 16:10 由 ${f.payer.account} 付款）退款遇到问题，我们正在人工处理。可以进入帮助与客服咨询。`)
    const friend = f.ctx.accounts.login(f.payer.account, password)
    const friendDetail = await f.call('GET', `/member/order/${orderId}`, friend.token)
    assert.equal(friendDetail.body.result.paymentNotice,
      `¥24.75（2026-11-05 16:10 由 ${f.payer.account} 付款）退款遇到问题，我们正在人工处理。可以进入帮助与客服咨询。`)
    assert.equal(friendDetail.body.result.skus.length, 0)
  } finally { await f.ctx.app.close() }
})

test('商家重试退款使用同一退款单和请求号只执行一次并留操作记录', async () => {
  let refundFails = true
  const refundIds: string[] = []
  const channel = new MockPaymentChannel('development-payment-callback-secret-32-bytes')
  channel.refund = (refundId) => { refundIds.push(refundId); return refundFails ? 'fail' : 'success' }
  const f = await fixture(channel)
  try {
    const orderId = await f.createOrder()
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'success', paidAt: f.clock.now() + 10 * 60_000 + 1 } })
    await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    const refund = f.ctx.db.one<{ id: string; payment_id: string }>('SELECT id,payment_id FROM refunds WHERE payment_id IN (SELECT id FROM payments WHERE order_id=?)', orderId)!
    refundFails = false
    const payload = { requestKey: randomUUID() }
    f.advance(24 * 60 * 60_000)
    await f.ctx.payments.reconcile(f.clock.now())
    const merchantToken = f.ctx.accounts.login(f.merchant.account, password).token
    const result = await f.call('POST', `/merchant/refunds/${refund.id}/retry`, merchantToken, payload)
    assert.equal(result.status, 200)
    assert.equal((await f.call('POST', `/merchant/refunds/${refund.id}/retry`, merchantToken, payload)).status, 200)
    assert.equal((await f.call('POST', `/merchant/refunds/${refund.id}/retry`, f.ctx.accounts.login(f.buyer.account, password).token, { requestKey: randomUUID() })).status, 403)
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM refunds WHERE id=?', refund.id)!.state, 'succeeded')
    assert.deepEqual(refundIds, [refund.id, refund.id])
    assert.equal(f.ctx.db.all('SELECT id FROM refund_retry_actions WHERE refund_id=?', refund.id).length, 1)
  } finally { await f.ctx.app.close() }
})

test('退款提示逐笔包含金额付款人和中国时区时间并按付款时间排序', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    await invitePayer(f, orderId)
    const ownerPayment = randomUUID(), friendPayment = randomUUID()
    const firstAt = Date.UTC(2026, 10, 5, 8, 10)
    const secondAt = Date.UTC(2026, 10, 5, 8, 12)
    for (const [id, payerId, paidAt] of [[ownerPayment, f.buyer.id, secondAt], [friendPayment, f.payer.id, firstAt]] as const) {
      f.ctx.db.run(`INSERT INTO payments(id,order_id,payer_id,amount,state,created,grace_deadline,channel_paid_at)
        VALUES(?,?,?,?,'succeeded',?,?,?)`, id, orderId, payerId, amountCents, paidAt, paidAt, paidAt)
      f.ctx.db.run(`INSERT INTO refunds(id,payment_id,amount,reason,state,attempts,next_attempt_at,created)
        VALUES(?,?,?,'duplicate','succeeded',1,NULL,?)`, randomUUID(), id, amountCents, paidAt)
    }
    const pendingPayment = randomUUID()
    const pendingAt = Date.UTC(2026, 10, 5, 8, 13)
    f.ctx.db.run(`INSERT INTO payments(id,order_id,payer_id,amount,state,created,grace_deadline,channel_paid_at)
      VALUES(?,?,?,?,'succeeded',?,?,?)`, pendingPayment, orderId, f.buyer.id, amountCents, pendingAt, pendingAt, pendingAt)
    f.ctx.db.run(`INSERT INTO refunds(id,payment_id,amount,reason,state,attempts,next_attempt_at,created)
      VALUES(?,?,?,'duplicate','failed',3,?,?)`, randomUUID(), pendingPayment, amountCents, f.clock.now(), pendingAt)
    const detail = await f.call('GET', `/member/order/${orderId}`, f.buyer.token)
    assert.equal(detail.body.result.paymentNotice,
      `¥24.75（2026-11-05 16:10 由 ${f.payer.account} 付款）已原路退回付款账户。\n¥24.75（2026-11-05 16:12 由 ${f.buyer.account} 付款）已原路退回付款账户。\n¥24.75（2026-11-05 16:13 由 ${f.buyer.account} 付款）正在退回付款账户。退款处理中，系统会自动重试，无需操作。`)
    const friendDetail = await f.call('GET', `/member/order/${orderId}`, f.payer.token)
    assert.equal(friendDetail.body.result.paymentNotice,
      `¥24.75（2026-11-05 16:10 由 ${f.payer.account} 付款）已原路退回付款账户。`)
  } finally { await f.ctx.app.close() }
})

test('B-59：成功回调与确认中取消并发到达时只创建一笔原路退款', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    const started = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    f.ctx.testData.payments({ paymentId: started.body.result.paymentId, preset: { outcome: 'success' } })
    const callback = f.ctx.payments.signedCallback(started.body.result.paymentId, { state: 'success', paidAt: f.clock.now() })
    const [cancelled, callbackResult] = await Promise.all([
      f.call('PUT', `/member/order/${orderId}/cancel`, f.buyer.token),
      f.call('POST', '/payments/callback', '', callback)
    ])
    assert.ok([200, 409].includes(cancelled.status))
    assert.equal(callbackResult.status, 200)
    assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)!.state, 6)
    assert.equal(f.ctx.db.all('SELECT id FROM refunds WHERE payment_id=?', started.body.result.paymentId).length, 1)
    assert.equal(f.ctx.catalog.sku(f.sku.id).stock, 7)
  } finally { await f.ctx.app.close() }
})

test('B-59：取消时渠道仍未知，稍后查到成功后原路退款且库存只释放一次', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    const started = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    const paymentId = started.body.result.paymentId
    assert.equal((await f.call('PUT', `/member/order/${orderId}/cancel`, f.buyer.token)).status, 200)
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM payments WHERE id=?', paymentId)!.state, 'closed')
    assert.equal(f.ctx.db.all('SELECT id FROM refunds WHERE payment_id=?', paymentId).length, 0)
    assert.equal(f.ctx.catalog.sku(f.sku.id).stock, 7)

    const paidAt = f.clock.now()
    f.ctx.testData.payments({ paymentId, preset: { outcome: 'success', paidAt } })
    f.advance(60_000)
    await f.ctx.payments.reconcile(f.clock.now())

    const payment = f.ctx.db.one<{ state: string; channel_paid_at: number }>('SELECT state,channel_paid_at FROM payments WHERE id=?', paymentId)!
    const refund = f.ctx.db.one<{ reason: string; state: string; amount: number }>(
      'SELECT reason,state,amount FROM refunds WHERE payment_id=?', paymentId)!
    assert.equal(payment.state, 'succeeded')
    assert.equal(payment.channel_paid_at, paidAt)
    assert.equal(refund.reason, 'cancelled')
    assert.equal(refund.state, 'succeeded')
    assert.equal(refund.amount, amountCents)
    assert.equal(f.ctx.db.all('SELECT id FROM refunds WHERE payment_id=?', paymentId).length, 1)
    assert.equal(f.ctx.catalog.sku(f.sku.id).stock, 7)
  } finally { await f.ctx.app.close() }
})

test('GET 订单与商家列表、库存读取不调用支付渠道', async () => {
  const spy = channelSpy()
  const f = await fixture(spy.channel)
  try {
    const orderId = await f.createOrder()
    await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    assert.equal((await f.call('GET', '/member/order?orderState=1', f.buyer.token)).status, 200)
    assert.equal((await f.call('GET', `/member/order/${orderId}`, f.buyer.token)).status, 200)
    assert.equal((await f.call('GET', '/merchant/orders', f.merchant.token)).status, 200)
    assert.equal((await f.call('GET', '/merchant/payments/review', f.merchant.token)).status, 200)
    assert.equal((await f.call('GET', `/merchant/inventory?skuId=${f.sku.id}`, f.merchant.token)).status, 200)
    assert.deepEqual(spy.calls, { create: 1, query: 0, close: 0, refund: 0 })
  } finally { await f.ctx.app.close() }
})

test('B-44：回调查单由 reconcile 驱动', async () => {
  const f = await fixture()
  try {
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    const orderId = await f.createOrder()
    const started = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    let reconcileCalls = 0
    const original = f.ctx.payments.reconcile.bind(f.ctx.payments)
    f.ctx.payments.reconcile = async (...args) => { reconcileCalls++; return original(...args) }
    f.ctx.testData.payments({ paymentId: started.body.result.paymentId, preset: { outcome: 'success' } })
    const callback = f.ctx.payments.signedCallback(started.body.result.paymentId, { state: 'success' })
    assert.equal((await f.call('POST', '/payments/callback', '', callback)).status, 200)
    assert.equal(reconcileCalls, 1)
  } finally { await f.ctx.app.close() }
})

test('B-42：用户手动查单由 reconcile 驱动', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    let reconcileCalls = 0
    const original = f.ctx.payments.reconcile.bind(f.ctx.payments)
    f.ctx.payments.reconcile = async (...args) => { reconcileCalls++; return original(...args) }
    assert.equal((await f.call('POST', `/member/order/${orderId}/payments/refresh`, f.buyer.token)).status, 200)
    assert.equal(reconcileCalls, 1)
  } finally { await f.ctx.app.close() }
})

test('B-58：商家重新查单由 reconcile 驱动', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    const started = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    f.advance(24 * 60 * 60_000)
    await f.ctx.payments.reconcile(f.clock.now())
    const merchantToken = f.ctx.accounts.login(f.merchant.account, password).token
    let reconcileCalls = 0
    const original = f.ctx.payments.reconcile.bind(f.ctx.payments)
    f.ctx.payments.reconcile = async (...args) => { reconcileCalls++; return original(...args) }
    assert.equal((await f.call('POST', `/merchant/payments/${started.body.result.paymentId}/requery`, merchantToken)).status, 200)
    assert.equal(reconcileCalls, 1)
  } finally { await f.ctx.app.close() }
})

test('B-59：确认中取消经 reconcile 执行关单', async () => {
  const spy = channelSpy()
  const f = await fixture(spy.channel)
  try {
    const orderId = await f.createOrder()
    await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    let reconcileCalls = 0
    const original = f.ctx.payments.reconcile.bind(f.ctx.payments)
    f.ctx.payments.reconcile = async (...args) => { reconcileCalls++; return original(...args) }
    assert.equal((await f.call('PUT', `/member/order/${orderId}/cancel`, f.buyer.token)).status, 200)
    assert.equal(reconcileCalls, 1)
    assert.equal(spy.calls.close, 1)
  } finally { await f.ctx.app.close() }
})

test('商家登记已扣款产生的退款经 reconcile 执行', async () => {
  const f = await fixture()
  try {
    const orderId = await f.createOrder()
    f.ctx.testData.payments({ paymentId: 'next', preset: { outcome: 'unknown' } })
    const started = await f.call('POST', `/member/order/${orderId}/payments`, f.buyer.token, { amountCents })
    const paymentId = started.body.result.paymentId as string
    const paidAt = f.ctx.db.one<{ grace_deadline: number }>('SELECT grace_deadline FROM payments WHERE id=?', paymentId)!.grace_deadline + 1
    f.advance(24 * 60 * 60_000)
    await f.ctx.payments.reconcile(f.clock.now())
    const merchantToken = f.ctx.accounts.login(f.merchant.account, password).token
    let reconcileCalls = 0
    const original = f.ctx.payments.reconcile.bind(f.ctx.payments)
    f.ctx.payments.reconcile = async (...args) => { reconcileCalls++; return original(...args) }
    assert.equal((await f.call('PUT', `/merchant/payments/${paymentId}/resolution`, merchantToken,
      { outcome: 'paid', paidAt, reason: '核对账单已扣款', requestKey: randomUUID() })).status, 200)
    assert.equal(reconcileCalls, 1)
  } finally { await f.ctx.app.close() }
})
