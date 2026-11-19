import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBackup, restoreBackup } from '../src/backup.ts'
import { Database } from '../src/database.ts'
import { createPromiseDriver, type PromiseDriver } from '../src/promises/extract.ts'
import { promiseTables } from '../src/promises/backup.ts'
import type { PromiseDraft, PromiseSnapshot } from '../src/promises/generated.ts'
import { buildTestApp } from './helpers/fixtures.ts'
import { identityHeaders } from './helpers/identity-headers.ts'

const description = '支持7天退换。承诺48小时内发货。'

async function fixture(databasePath = ':memory:', uploadsPath = './unused', promiseDriver = createPromiseDriver({ mock: true })) {
  let now = Date.UTC(2026, 10, 18, 8)
  const ctx = await buildTestApp({ databasePath, uploadsPath, publicUrl: 'http://localhost', mockPayments: true,
    clock: { now: () => now }, promiseDriver })
  const buyer = ctx.testData.account({ account: 'buyer', password: 'test-password-123' })
  const merchant = ctx.testData.account({ account: 'seller', password: 'test-password-123', role: 'merchant' })
  const other = ctx.testData.account({ account: 'other', password: 'test-password-123' })
  const delivery = ctx.testData.address({ userId: buyer.id, receiver: '验收人', contact: '13800000000', address: '验收地址一号' })
  const product = ctx.testData.product({ name: '承诺测试商品', category: '箱包', description,
    skus: [{ spec: '标准款', priceCents: 2300, stock: 100 }, { spec: '加厚款', priceCents: 2300, stock: 100 }] })
  const [sku, second] = [product.skus[0]!, product.skus[1]!]
  const base = `/merchant/products/${product.id}/promises`
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, token = buyer.token) => {
    const response = await ctx.app.inject({ method, url, headers: identityHeaders(ctx.accounts, token), payload })
    return { status: response.statusCode, ...response.json() }
  }
  const state = async () => (await call('GET', base, undefined, merchant.token)).result as { published: PromiseSnapshot | null; draft: PromiseDraft | null }
  const extract = async () => {
    const res = await call('POST', base + '/extract', {}, merchant.token)
    assert.equal(res.status, 200, JSON.stringify(res))
    return res.result.draft as PromiseDraft
  }
  const decisions = (draft: PromiseDraft) => draft.entries.filter(entry => entry.status === 'known')
    .map(entry => ({ fieldId: entry.fieldId, decision: entry.fieldId === 'dispatch-window' ? 'reject' : 'accept' }))
  const confirm = async (draft: PromiseDraft, token = merchant.token) => {
    const res = await call('POST', base + '/confirmations', { draftId: draft.id, decisions: decisions(draft) }, token)
    assert.equal(res.status, 200, JSON.stringify(res))
    return res.result.confirmationToken as string
  }
  const publish = (confirmationToken: string, requestKey = randomUUID(), token = merchant.token) =>
    call('POST', base + '/publish', { confirmationToken, requestKey }, token)
  const edit = async (revision: number, description: string) => {
    const res = await call('PUT', `/merchant/products/${product.id}`, { requestKey: randomUUID(), expectedRevision: revision, description }, merchant.token)
    assert.equal(res.status, 200, JSON.stringify(res))
  }
  const order = async (both = false) => {
    const goods = (both ? [sku, second] : [sku]).map(value => ({ skuId: value.id, count: 1 }))
    const res = await call('POST', '/member/order', { source: 'buy-now', addressId: delivery.id,
      requestKey: randomUUID(), expectedAmountCents: 2300 * goods.length, goods })
    assert.equal(res.status, 200, JSON.stringify(res))
    return res.result.id as string
  }
  const detail = async (orderId: string) => (await call('GET', `/member/order/${orderId}`)).result
  return { ctx, buyer, merchant, other, product, sku, second, base, call, state, extract, decisions, confirm, publish, edit,
    order, detail, advance: (ms: number) => { now += ms } }
}

test('承诺发布必须逐条选择，凭据绑定当前店主登录，回执可重查且只发布一次', async () => {
  const f = await fixture()
  try {
    const draft = await f.extract()
    assert.equal(draft.entries.filter(entry => entry.status === 'known').length, 2)
    assert.equal((await f.call('POST', f.base + '/confirmations', { draftId: draft.id, decisions: f.decisions(draft).slice(0, 1) }, f.merchant.token)).status, 400)
    const token = await f.confirm(draft)
    const tokenHash = createHash('sha256').update(token).digest('hex')
    assert.ok(f.ctx.db.one('SELECT 1 FROM promise_confirmations WHERE token_hash=?', tokenHash))
    assert.equal(f.ctx.db.one('SELECT 1 FROM promise_confirmations WHERE token_hash=?', token), undefined)
    const requestKey = randomUUID()
    assert.equal((await f.publish(token, requestKey, f.buyer.token)).status, 403)
    assert.equal((await f.publish('f'.repeat(64), requestKey)).reason, 'PROMISE_CONFIRMATION_INVALID')
    const secondSession = (await f.ctx.app.inject({ method: 'POST', url: '/login', payload: { account: 'seller', password: 'test-password-123' } })).json().result.token
    assert.equal((await f.publish(token, requestKey, secondSession)).reason, 'PROMISE_CONFIRMATION_INVALID')
    const otherToken = await f.confirm(draft)
    const published = await Promise.all([f.publish(token, requestKey), f.publish(token, requestKey)])
    assert.equal(published[0]!.status, 200)
    assert.deepEqual(published[0]!.result, published[1]!.result)
    assert.equal((await f.publish(token)).reason, 'PROMISE_CONFIRMATION_INVALID')
    assert.equal((await f.publish(otherToken)).reason, 'PROMISE_DRAFT_STALE')
    const receiptUrl = f.base + '/receipts/' + requestKey
    assert.deepEqual((await f.call('GET', receiptUrl, undefined, secondSession)).result, published[0]!.result)
    assert.equal((await f.call('GET', receiptUrl, undefined, f.buyer.token)).status, 403)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) count FROM promise_publications')!.count, 1)
    const entries = (published[0]!.result as PromiseSnapshot).entries
    assert.equal(entries.find(entry => entry.fieldId === 'return-window')?.value, '7')
    assert.equal(entries.find(entry => entry.fieldId === 'shipping-cost')?.status, 'unknown')
    assert.equal(entries.some(entry => entry.fieldId === 'dispatch-window'), false)
    assert.equal((await f.state()).draft, null)
  } finally { await f.ctx.app.close() }
})

test('凭据到期、身份来回切换和商品改动均要求重新确认', async () => {
  const f = await fixture()
  try {
    const draft = await f.extract()
    const expired = await f.confirm(draft)
    f.advance(5 * 60_000)
    assert.equal((await f.publish(expired)).reason, 'PROMISE_CONFIRMATION_INVALID')
    const wrongIdentity = await f.confirm(draft)
    for (const identity of ['buyer', 'merchant']) {
      assert.equal((await f.call('POST', '/member/identity/switch', { identity }, f.merchant.token)).status, 200)
    }
    assert.equal((await f.publish(wrongIdentity)).reason, 'PROMISE_CONFIRMATION_INVALID')
    const stale = await f.confirm(draft)
    await f.edit(draft.productRevision, '支持14天退换。')
    assert.equal((await f.publish(stale)).reason, 'PROMISE_DRAFT_STALE')
    assert.equal((await f.call('POST', f.base + '/confirmations', { draftId: draft.id, decisions: f.decisions(draft) }, f.merchant.token)).reason, 'PROMISE_DRAFT_STALE')
    assert.equal((await f.state()).draft, null)
    assert.equal((await f.publish(await f.confirm(await f.extract()))).status, 200)
  } finally { await f.ctx.app.close() }
})

test('模型返回前修改商品使本次草稿作废', async () => {
  const mock = createPromiseDriver({ mock: true })!
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const driver: PromiseDriver = { ...mock, extract: async (messages, signal) => { entered(); await gate; return mock.extract(messages, signal) } }
  const f = await fixture(':memory:', './unused', driver)
  try {
    const pending = f.call('POST', f.base + '/extract', {}, f.merchant.token)
    await ready
    const product = (await f.call('GET', `/merchant/products/${f.product.id}`, undefined, f.merchant.token)).result
    await f.edit(product.revision, '支持14天退换。')
    release()
    assert.equal((await pending).reason, 'PROMISE_DRAFT_STALE')
    assert.equal((await f.state()).draft, null)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) count FROM promise_drafts')!.count, 0)
  } finally { release(); await f.ctx.app.close() }
})

test('下单与发布并发时同一订单所有规格冻结同一已发布版本，旧单持续保留原快照', async () => {
  const f = await fixture()
  try {
    const legacy = await f.order()
    const draft = await f.extract()
    const oldSnapshot = (await f.publish(await f.confirm(draft))).result as PromiseSnapshot
    const oldOrder = await f.order()
    await f.edit(draft.productRevision, '支持14天退换。')
    assert.deepEqual((await f.state()).published, oldSnapshot)
    const newToken = await f.confirm(await f.extract())
    const [published, concurrent, otherConcurrent] = await Promise.all([f.publish(newToken), f.order(true), f.order(true)])
    assert.equal(published.status, 200)
    const newer = published.result as PromiseSnapshot
    assert.notEqual(newer.receiptId, oldSnapshot.receiptId)
    for (const orderId of [concurrent, otherConcurrent]) {
      const order = await f.detail(orderId)
      assert.equal(order.skus.length, 2)
      assert.deepEqual(order.skus[0].promiseSnapshot, order.skus[1].promiseSnapshot)
      assert.ok([oldSnapshot.receiptId, newer.receiptId].includes(order.skus[0].promiseSnapshot.receiptId))
    }
    assert.deepEqual((await f.detail(await f.order())).skus[0].promiseSnapshot, newer)
    assert.deepEqual((await f.detail(oldOrder)).skus[0].promiseSnapshot, oldSnapshot)
    assert.equal((await f.detail(legacy)).skus[0].promiseSnapshot, null)
  } finally { await f.ctx.app.close() }
})

test('售后预选规则随字段目录版本冻结到发布回执和订单', async () => {
  const base = createPromiseDriver({ mock: true })!
  const driver: PromiseDriver = { ...base, extract: async () => ({ status: 'completed', tokens: 1,
    content: JSON.stringify({ claims: [{ fieldId: 'bag-lining', source: 'description', quote: '内衬为聚酯纤维。',
      value: '聚酯纤维', unit: null, condition: null }] }) }) }
  const f = await fixture(':memory:', './unused', driver)
  try {
    const current = (await f.call('GET', `/merchant/products/${f.product.id}`, undefined, f.merchant.token)).result
    await f.edit(current.revision, '内衬为聚酯纤维。')
    const draft = await f.extract()
    assert.equal(draft.entries.find(entry => entry.fieldId === 'bag-lining')?.suggestedAfterSaleKind, 'return-quality')
    const result = await f.publish(await f.confirm(draft))
    assert.equal(result.status, 200)
    const receipt = result.result as PromiseSnapshot
    assert.equal(receipt.templateVersion, 'promises-20261118-2')
    const orderId = await f.order()
    const frozen = (await f.detail(orderId)).skus[0]!.promiseSnapshot as PromiseSnapshot
    assert.deepEqual(frozen.entries.find(entry => entry.fieldId === 'bag-lining'),
      receipt.entries.find(entry => entry.fieldId === 'bag-lining'))

    const latest = (await f.call('GET', `/merchant/products/${f.product.id}`, undefined, f.merchant.token)).result
    await f.edit(latest.revision, '内衬为棉布。')
    const historical = (await f.detail(orderId)).skus[0]!.promiseSnapshot as PromiseSnapshot
    assert.deepEqual(historical, frozen)
  } finally { await f.ctx.app.close() }
})

test('仅收货买家可核对，售后保存原文引用并可随备份恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'promise-backup-'))
  const databasePath = join(root, 'data', 'mall.sqlite'), uploadsPath = join(root, 'uploads')
  const f = await fixture(databasePath, uploadsPath)
  try {
    const published = (await f.publish(await f.confirm(await f.extract()))).result as PromiseSnapshot
    const orderId = await f.order(), orderUrl = `/member/order/${orderId}`
    const input = { skuId: f.sku.id, fieldId: 'return-window', result: 'mismatch' }
    assert.equal((await f.call('PUT', orderUrl + '/promise-check', input)).status, 409)
    assert.equal((await f.call('POST', orderUrl + '/mock-pay', { amountCents: 2300 })).status, 200)
    assert.equal((await f.call('POST', `/merchant/orders/${orderId}/ship`, { carrier: '顺丰', trackingNo: 'SF12345678' }, f.merchant.token)).status, 200)
    assert.equal((await f.call('PUT', orderUrl + '/receipt')).status, 200)
    assert.equal((await f.call('PUT', orderUrl + '/promise-check', input, f.merchant.token)).reason, 'BUYER_REQUIRED')
    assert.equal((await f.call('PUT', orderUrl + '/promise-check', input, f.other.token)).status, 403)
    assert.equal((await f.call('PUT', orderUrl + '/promise-check', { ...input, fieldId: 'shipping-cost' })).status, 400)
    const application = { requestKey: randomUUID(), kind: 'return-quality', description: '买家补充原因文字', items: [{ skuId: f.sku.id, count: 1 }],
      promiseMismatch: { skuId: f.sku.id, fieldId: input.fieldId }, imageIds: [] }
    assert.equal((await f.call('POST', orderUrl + '/after-sales', application)).status, 409)
    assert.deepEqual((await f.call('PUT', orderUrl + '/promise-check', input)).result, input)
    assert.equal((await f.call('PUT', orderUrl + '/promise-check', input)).status, 200)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) count FROM order_promise_checks')!.count, 1)
    const submitted = await f.call('POST', orderUrl + '/after-sales', application)
    assert.equal(submitted.status, 200, JSON.stringify(submitted))
    const sale = async () => (await f.detail(orderId)).afterSales.find((value: { id: string }) => value.id === submitted.result.afterSaleId)
    const publishedEntry = published.entries.find(entry => entry.fieldId === input.fieldId)!
    const stored = { ...application.promiseMismatch, label: '退换期限', quote: publishedEntry.quote, receiptId: published.receiptId }
    assert.equal(publishedEntry.quote, '支持7天退换')
    assert.deepEqual((await sale()).promiseMismatch, stored)
    assert.equal((await sale()).description, application.description)
    assert.equal((await f.call('PUT', orderUrl + '/promise-check', { ...input, result: 'matches' })).status, 200)
    assert.deepEqual((await sale()).promiseMismatch, stored)

    const backup = await createBackup({ databasePath, uploadsPath, destination: join(root, 'backup') })
    assert.equal(backup.manifest.schemaVersion, 21)
    for (const table of promiseTables) assert.ok(backup.counts[table]! > 0, table)
    const restored = await restoreBackup({ backupPath: backup.root, destination: join(root, 'restored') })
    const restoredDb = new Database(join(restored.root, 'mall.sqlite'))
    try {
      for (const table of promiseTables) assert.deepEqual(restoredDb.all(`SELECT * FROM ${table} ORDER BY rowid`), f.ctx.db.all(`SELECT * FROM ${table} ORDER BY rowid`))
    } finally { restoredDb.close() }

    f.ctx.db.run("UPDATE order_item_promise_snapshots SET snapshot=json_set(snapshot,'$.entries[0].value','99') WHERE order_id=?", orderId)
    await assert.rejects(createBackup({ databasePath, uploadsPath, destination: join(root, 'invalid-backup') }), /承诺快照/)
  } finally { await f.ctx.app.close(); await rm(root, { recursive: true, force: true }) }
})
