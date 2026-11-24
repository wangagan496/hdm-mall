import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { buildTestApp } from './helpers/fixtures.ts'
import { identityHeaders } from './helpers/identity-headers.ts'
import { Database } from '../src/database.ts'
import { radarIdempotencyKey, runRadar } from '../src/price-radar.ts'
import { computeOrderCompensation } from '../src/compensation-calc.ts'
import { recordPriceEvent } from '../src/price-events.ts'
import { createBackup, restoreBackup, verifyBackup } from '../src/backup.ts'
import { compensationSchemas } from '../../contract-kit/v1/compensation.ts'
import { compensationVectors } from '../../contract-kit/v1/vectors/compensation.ts'
import {
  parseCompensationDraftBrief,
  parseCompensationConfirmInput,
  parseCompensationReceipt
} from '../src/compensation/generated.ts'

const ONE_DAY_S = 86400
const ONE_DAY_MS = 86_400_000

async function setupFixture(opts?: { priceCents?: number; rootDir?: string }) {
  let now = Date.UTC(2026, 10, 20, 8)
  const priceCents = opts?.priceCents ?? 10000
  const root = opts?.rootDir ?? mkdtempSync(join(tmpdir(), 'hdm-comp-test-'))
  const ctx = await buildTestApp({
    databasePath: opts?.rootDir ? join(root, 'data', 'mall.sqlite') : ':memory:',
    uploadsPath: opts?.rootDir ? join(root, 'uploads') : './unused',
    publicUrl: 'http://localhost',
    mockPayments: true,
    clock: { now: () => now }
  })
  const buyer = ctx.testData.account({ account: 'buyer1', password: 'test-password-123' })
  const otherBuyer = ctx.testData.account({ account: 'buyer2', password: 'test-password-123' })
  const merchant = ctx.testData.account({ account: 'seller1', password: 'test-password-123', role: 'merchant' })
  const address = ctx.testData.address({ userId: buyer.id, receiver: '收货人', contact: '13800000000', address: '测试路1号' })
  const product = ctx.testData.product({
    name: '测试价保商品',
    category: '箱包',
    description: '品质保障。',
    skus: [{ spec: '标准款', priceCents, stock: 50 }]
  })
  const sku = product.skus[0]!

  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, token = buyer.token) => {
    const response = await ctx.app.inject({ method, url, headers: identityHeaders(ctx.accounts, token), payload })
    return { status: response.statusCode, ...response.json() }
  }
  const curPromo = await call('GET', '/merchant/settings/promotion', undefined, merchant.token)
  if (curPromo.result?.enabled) {
    const off = await call('PUT', '/merchant/settings/promotion', {
      requestKey: randomUUID(),
      expectedRevision: curPromo.result.revision,
      thresholdCents: curPromo.result.thresholdCents,
      discountCents: curPromo.result.discountCents,
      enabled: false
    }, merchant.token)
    assert.equal(off.status, 200, JSON.stringify(off))
  }
  const tick = (ms: number) => { now += ms }
  const reloginAll = async () => {
    for (const u of [{ ref: buyer, account: 'buyer1' }, { ref: otherBuyer, account: 'buyer2' }, { ref: merchant, account: 'seller1' }]) {
      const r = await ctx.app.inject({ method: 'POST', url: '/login', payload: { account: u.account, password: 'test-password-123' } })
      u.ref.token = r.json().result.token
    }
  }
  const publishPolicy = async (extra: { windowDays?: number; budgetPerOrderCents?: number; totalBudgetCents?: number; effectiveAtOffset?: number } = {}) => {
    const d = await call('POST', '/merchant/settings/protection/draft', {
      requestKey: randomUUID(),
      windowDays: extra.windowDays ?? 7,
      budgetPerOrderCents: extra.budgetPerOrderCents ?? 2000,
      totalBudgetCents: extra.totalBudgetCents ?? 10000,
      effectiveAtOffset: extra.effectiveAtOffset ?? ONE_DAY_S
    }, merchant.token)
    assert.equal(d.status, 200, JSON.stringify(d))
    const c = await call('POST', '/merchant/settings/protection/confirm', {
      policyId: d.result.policyId,
      policyHash: d.result.policyHash
    }, merchant.token)
    assert.equal(c.status, 200, JSON.stringify(c))
    const p = await call('POST', '/merchant/settings/protection/publish', {
      token: c.result.token,
      policyId: d.result.policyId,
      requestKey: randomUUID()
    }, merchant.token)
    assert.equal(p.status, 200, JSON.stringify(p))
    return { policyId: d.result.policyId as string, receiptId: p.result.receiptId as string }
  }
  const placeAndPay = async (count = 1, unitPrice = priceCents) => {
    const o = await call('POST', '/member/order', {
      requestKey: randomUUID(),
      goods: [{ skuId: sku.id, count }],
      addressId: address.id,
      expectedAmountCents: unitPrice * count
    }, buyer.token)
    assert.equal(o.status, 200, JSON.stringify(o))
    const pay = await call('POST', `/member/order/${o.result.id}/mock-pay`, { amountCents: unitPrice * count }, buyer.token)
    assert.equal(pay.status, 200, JSON.stringify(pay))
    return o.result.id as string
  }
  const lowerProductPrice = async (newPriceCents: number) => {
    const detail = await call('GET', `/merchant/products/${product.id}`, undefined, merchant.token)
    assert.equal(detail.status, 200)
    const edit = await call('PUT', `/merchant/products/${product.id}`, {
      requestKey: randomUUID(),
      expectedRevision: detail.result.revision,
      skus: [{ id: sku.id, priceCents: newPriceCents }]
    }, merchant.token)
    assert.equal(edit.status, 200, JSON.stringify(edit))
  }

  return {
    root, ctx, buyer, otherBuyer, merchant, product, sku, address,
    call, tick, reloginAll, publishPolicy, placeAndPay, lowerProductPrice,
    getNow: () => now,
    cleanup: async () => {
      await ctx.app.close()
      if (!opts?.rootDir) rmSync(root, { recursive: true, force: true })
    }
  }
}

test('contract-kit compensation schema 与生成解析器严格匹配测试向量', () => {
  for (const vector of compensationVectors) {
    const schema = compensationSchemas[vector.kind as keyof typeof compensationSchemas]
    assert.equal(schema.safeParse(vector.value).success, vector.valid, vector.name)
    const json = JSON.stringify(vector.value)
    if (vector.kind === 'CompensationDraftBrief') assert.equal(parseCompensationDraftBrief(json) !== null, vector.valid, vector.name)
    if (vector.kind === 'CompensationConfirmInput') assert.equal(parseCompensationConfirmInput(json) !== null, vector.valid, vector.name)
    if (vector.kind === 'CompensationReceipt') assert.equal(parseCompensationReceipt(json) !== null, vector.valid, vector.name)
  }
})

test('降价事件仅记录降价，雷达生成幂等草稿且重启不重复建', async () => {
  const f = await setupFixture({ priceCents: 10000 })
  try {
    const { policyId } = await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 3000, totalBudgetCents: 10000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()

    const orderId = await f.placeAndPay(1)
    // 涨价不记事件
    await f.lowerProductPrice(11000)
    assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM price_events')!.n, 0)

    // 降价 2500 分（11000 -> 8500，但订单实付 10000 -> 整篮差额 1500 分）
    await f.lowerProductPrice(8500)
    const events = f.ctx.db.all<{ id: string; source: string; old_price_cents: number; new_price_cents: number }>('SELECT * FROM price_events')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.source, 'merchant_edit')

    const s1 = runRadar(f.ctx.db, f.getNow())
    assert.equal(s1.created, 1)
    // 模拟重复 tick / 重启再扫描：不得新建草稿
    const s2 = runRadar(f.ctx.db, f.getNow() + 60_000)
    assert.equal(s2.created, 0)

    const drafts = f.ctx.db.all<{ id: string; idempotency_key: string; capped_cents: number }>('SELECT * FROM compensation_drafts')
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0]!.idempotency_key, radarIdempotencyKey(orderId, policyId, events[0]!.id))
    assert.equal(drafts[0]!.capped_cents, 1500)

    const listRes = await f.call('GET', `/buyer/orders/${orderId}/compensation/drafts`)
    assert.equal(listRes.status, 200)
    assert.equal(listRes.result.length, 1)
    assert.equal(listRes.result[0].cappedCents, 1500)
    assert.equal(listRes.result[0].policyVersion, 1)
  } finally { await f.cleanup() }
})

test('满减开启与加惠触发 price_events，雷达按整篮新低生成草稿', async () => {
  const f = await setupFixture({ priceCents: 10000 })
  try {
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 2500, totalBudgetCents: 10000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()

    const orderId = await f.placeAndPay(1)
    const curPromo = await f.call('GET', '/merchant/settings/promotion', undefined, f.merchant.token)
    assert.equal(curPromo.status, 200)
    const editPromo = await f.call('PUT', '/merchant/settings/promotion', {
      requestKey: randomUUID(),
      expectedRevision: curPromo.result.revision,
      thresholdCents: 9900,
      discountCents: 1200,
      enabled: true
    }, f.merchant.token)
    assert.equal(editPromo.status, 200)

    const events = f.ctx.db.all<{ source: string; promotion_rule_id: string | null }>('SELECT source, promotion_rule_id FROM price_events')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.source, 'promotion_add')
    assert.equal(events[0]!.promotion_rule_id, String(editPromo.result.revision))

    const scan = runRadar(f.ctx.db, f.getNow())
    assert.equal(scan.created, 1)
    const listRes = await f.call('GET', `/buyer/orders/${orderId}/compensation/drafts`)
    assert.equal(listRes.result.length, 1)
    assert.equal(listRes.result[0].cappedCents, 1200)
  } finally { await f.cleanup() }
})

test('草稿过期被拒 (403) 与金额不符被拒 (400)', async () => {
  const f = await setupFixture({ priceCents: 10000 })
  try {
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 3000, totalBudgetCents: 10000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()

    const orderId = await f.placeAndPay(1)
    await f.lowerProductPrice(8000)
    runRadar(f.ctx.db, f.getNow())

    const draft = (await f.call('GET', `/buyer/orders/${orderId}/compensation/drafts`)).result[0]
    assert.ok(draft)

    // 金额不符 -> 400
    const mismatch = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: draft.draftId,
      requestKey: randomUUID(),
      confirmedCents: draft.cappedCents + 1
    })
    assert.equal(mismatch.status, 400)

    // 推进超过 48 小时草稿有效期 -> 403
    f.tick(49 * 3600_000)
    await f.reloginAll()
    const expired = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: draft.draftId,
      requestKey: randomUUID(),
      confirmedCents: draft.cappedCents
    })
    assert.equal(expired.status, 403)
  } finally { await f.cleanup() }
})

test('余额约束 R+C+U<=F 超出被拒 (409)，重复 requestKey 返回原回执且不重复扣额', async () => {
  const f = await setupFixture({ priceCents: 10000 })
  try {
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 5000, totalBudgetCents: 20000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()

    // 订单总额 F = 20000（2件），降价到 6000（每件降 4000 -> capped = 5000）
    const orderId = await f.placeAndPay(2, 10000)
    f.tick(1)
    const orderId2 = await f.placeAndPay(2, 10000)
    await f.lowerProductPrice(6000)
    runRadar(f.ctx.db, f.getNow())
    const draft = (await f.call('GET', `/buyer/orders/${orderId}/compensation/drafts`)).result[0]
    const draft2 = (await f.call('GET', `/buyer/orders/${orderId2}/compensation/drafts`)).result[0]
    assert.equal(draft.cappedCents, 5000)
    assert.equal(draft2.cappedCents, 5000)

    // 先对 order1 记一笔已占退款 R = 16000，使 F - R = 4000 < 5000 -> 超出被拒 409
    const payRow = f.ctx.db.one<{ id: string }>('SELECT id FROM payments WHERE order_id=?', orderId)!
    f.ctx.db.run(
      "INSERT INTO refunds(id,payment_id,amount,reason,state,attempts,next_attempt_at,created) VALUES(?,?,16000,'cancelled','succeeded',1,NULL,?)",
      randomUUID(), payRow.id, f.getNow()
    )

    const exceed = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: draft.draftId,
      requestKey: randomUUID(),
      confirmedCents: 5000
    })
    assert.equal(exceed.status, 409)

    // 对 order2 记一笔退款 R = 10000（剩余可退 10000 >= 5000），验证首次确认与重复 requestKey 幂等
    const payRow2 = f.ctx.db.one<{ id: string }>('SELECT id FROM payments WHERE order_id=?', orderId2)!
    f.ctx.db.run(
      "INSERT INTO refunds(id,payment_id,amount,reason,state,attempts,next_attempt_at,created) VALUES(?,?,10000,'cancelled','succeeded',1,NULL,?)",
      randomUUID(), payRow2.id, f.getNow()
    )
    const reqKey = randomUUID()
    const first = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: draft2.draftId,
      requestKey: reqKey,
      confirmedCents: 5000
    })
    assert.equal(first.status, 200, JSON.stringify(first))
    assert.equal(first.result.channelStatus, 'pending')

    const second = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: draft2.draftId,
      requestKey: reqKey,
      confirmedCents: 5000
    })
    assert.equal(second.status, 200)
    assert.equal(second.result.receiptId, first.result.receiptId)
    assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM compensation_receipts WHERE order_id=?', orderId2)!.n, 1)

    // 同一 requestKey 异参 -> 409
    const tamper = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: draft2.draftId,
      requestKey: reqKey,
      confirmedCents: 4000
    })
    assert.equal(tamper.status, 409)
  } finally { await f.cleanup() }
})

test('部分退货后雷达排除退件，退件份额不转给留件', async () => {
  const f = await setupFixture({ priceCents: 10000 })
  try {
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 10000, totalBudgetCents: 50000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()

    // 买 2 件共 20000，发货收货后退 1 件
    const orderId = await f.placeAndPay(2, 10000)
    assert.equal((await f.call('POST', `/merchant/orders/${orderId}/ship`, { carrier: '顺丰', trackingNo: 'SF100002' }, f.merchant.token)).status, 200)
    assert.equal((await f.call('PUT', `/member/order/${orderId}/receipt`, {}, f.buyer.token)).status, 200)
    const sale = await f.call('POST', `/member/order/${orderId}/after-sales`, {
      requestKey: randomUUID(),
      kind: 'refund-missing',
      description: '少了一件申请仅退款',
      items: [{ skuId: f.sku.id, count: 1 }]
    })
    assert.equal(sale.status, 200, JSON.stringify(sale))
    assert.equal((await f.call('POST', `/merchant/after-sales/${sale.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)).status, 200)

    // 单价降价 2000 分（10000 -> 8000）：原篮 2 件差 4000，退掉 1 件后留件只得 2000 分，绝不能拿 4000 分
    await f.lowerProductPrice(8000)
    runRadar(f.ctx.db, f.getNow())
    const drafts = (await f.call('GET', `/buyer/orders/${orderId}/compensation/drafts`)).result
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0].basketDeltaCents, 2000)
    assert.equal(drafts[0].cappedCents, 2000)
    assert.deepEqual(drafts[0].perLine, [{ order_line_id: f.sku.id, delta_cents: 2000 }])
  } finally { await f.cleanup() }
})

test('政策总预算不足时草稿标 pending_budget，预算释放后下轮激活，渠道未知不冒充到账，非买家与跨号被拒', async () => {
  const f = await setupFixture({ priceCents: 10000 })
  try {
    // 总预算仅 1000 分，单笔上限 1000 分
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 1000, totalBudgetCents: 1000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()

    const order1 = await f.placeAndPay(1)
    f.tick(1)
    const order2 = await f.placeAndPay(1)

    await f.lowerProductPrice(9000) // 每单降价 1000
    const s1 = runRadar(f.ctx.db, f.getNow())
    assert.equal(s1.created, 1)
    assert.equal(s1.pendingBudget, 1)

    const d1List = (await f.call('GET', `/buyer/orders/${order1}/compensation/drafts`)).result
    const d2List = (await f.call('GET', `/buyer/orders/${order2}/compensation/drafts`)).result
    assert.equal(d1List.length, 1)
    assert.equal(d2List.length, 0) // 第二单为 pending_budget，不可展示为可确认

    const d2Row = f.ctx.db.one<{ id: string; status: string }>('SELECT id,status FROM compensation_drafts WHERE order_id=?', order2)!
    assert.equal(d2Row.status, 'pending_budget')

    // 确认第一单 -> 检查 channel_status 与非买家权限
    const mRes = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: d1List[0].draftId, requestKey: randomUUID(), confirmedCents: 1000
    }, f.merchant.token)
    assert.equal(mRes.status, 403)

    const oRes = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: d1List[0].draftId, requestKey: randomUUID(), confirmedCents: 1000
    }, f.otherBuyer.token)
    assert.equal(oRes.status, 403)

    const receipt = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: d1List[0].draftId, requestKey: randomUUID(), confirmedCents: 1000
    }, f.buyer.token)
    assert.equal(receipt.status, 200)
    assert.equal(receipt.result.channelStatus, 'pending')
    assert.equal(receipt.result.statusLabel, '补差已登记，渠道处理中')

    // 若渠道状态未知 -> 不冒充到账，订单详情也保留该状态
    f.ctx.db.run("UPDATE compensation_receipts SET channel_status='unknown' WHERE receipt_id=?", receipt.result.receiptId)
    const rView = await f.call('GET', `/buyer/compensation/receipts/${receipt.result.receiptId}`)
    assert.equal(rView.status, 200)
    assert.equal(rView.result.channelStatus, 'unknown')
    assert.equal(rView.result.statusLabel, '待执行（渠道结果待核实）')

    const orderDetail = await f.call('GET', `/member/order/${order1}`)
    assert.equal(orderDetail.result.compensationReceipts[0].channelStatus, 'unknown')

    // 模拟渠道失败释放预算（且先退掉 order1 的占额），下轮雷达应将 order2 从 pending_budget 激活为 pending
    f.ctx.db.run("UPDATE compensation_receipts SET channel_status='failed' WHERE receipt_id=?", receipt.result.receiptId)
    const s2 = runRadar(f.ctx.db, f.getNow() + 1000)
    assert.equal(s2.activatedFromBudget, 1)
    assert.equal((await f.call('GET', `/buyer/orders/${order2}/compensation/drafts`)).result.length, 1)
  } finally { await f.cleanup() }
})

test('备份与恢复包含版本 29 三张表并拒绝超额/篡改回执', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hdm-comp-backup-'))
  const f = await setupFixture({ priceCents: 10000, rootDir: root })
  try {
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 2000, totalBudgetCents: 10000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()
    const orderId = await f.placeAndPay(1)
    await f.lowerProductPrice(8500)
    runRadar(f.ctx.db, f.getNow())
    const draft = (await f.call('GET', `/buyer/orders/${orderId}/compensation/drafts`)).result[0]
    const receipt = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: draft.draftId, requestKey: randomUUID(), confirmedCents: draft.cappedCents
    })
    assert.equal(receipt.status, 200)
    await f.ctx.app.close()

    const options = { databasePath: join(root, 'data', 'mall.sqlite'), uploadsPath: join(root, 'uploads') }
    const backup = await createBackup({ ...options, destination: join(root, 'backup') })
    assert.equal(backup.manifest.schemaVersion, 30)
    assert.equal(backup.counts.price_events, 1)
    assert.equal(backup.counts.compensation_drafts, 1)
    assert.equal(backup.counts.compensation_receipts, 1)

    const restored = await restoreBackup({ backupPath: backup.root, destination: join(root, 'restored') })
    assert.equal(restored.report.format, 1)
    assert.equal(restored.report.counts.price_events, 1)
    assert.equal(restored.report.counts.compensation_drafts, 1)
    assert.equal(restored.report.counts.compensation_receipts, 1)

    // 篡改回执金额与草稿不一致 -> 备份拒绝
    const tamperedDb = new DatabaseSync(join(root, 'data', 'mall.sqlite'))
    try {
      tamperedDb.prepare('UPDATE compensation_receipts SET confirmed_cents=999999 WHERE receipt_id=?').run(receipt.result.receiptId)
    } finally {
      tamperedDb.close()
    }
    await assert.rejects(
      createBackup({ ...options, destination: join(root, 'tampered-backup') }),
      /补差回执与草稿或订单归属不一致|补差与退款总额超过订单实付/
    )
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('P1修复1：补差后取消/售后/未知通道占额双向守恒 R+C+U<=F 且通过备份校验', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hdm-comp-refund-'))
  const f = await setupFixture({ priceCents: 10000, rootDir: root })
  try {
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 5000, totalBudgetCents: 100000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()

    // 1) 实付10000 -> 确认补差1000（pending），再取消+商家同意 -> 退款扣减为 9000，R+C+U = 10000
    const o1 = await f.placeAndPay(1, 10000)
    // 顺带建单2用于 unknown 占额与售后退款验证
    f.tick(1)
    const o2 = await f.placeAndPay(1, 10000)

    f.tick(1000)
    await f.lowerProductPrice(9000)
    runRadar(f.ctx.db, f.getNow())

    const d1 = (await f.call('GET', `/buyer/orders/${o1}/compensation/drafts`)).result[0]
    const r1 = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: d1.draftId, requestKey: randomUUID(), confirmedCents: 1000
    })
    assert.equal(r1.status, 200)
    assert.equal(r1.result.channelStatus, 'pending')

    // 订单详情取消确认文案同步为剩余可退 9000 分
    const detailBeforeCancel = await f.call('GET', `/member/order/${o1}`)
    assert.equal(detailBeforeCancel.result.cancelConfirmation.amountCents, 9000)

    const cancelReq = await f.call('POST', `/member/order/${o1}/cancel-requests`, { requestKey: randomUUID() })
    assert.equal(cancelReq.status, 200)
    const cancelRes = await f.call('POST', `/merchant/orders/${o1}/cancel-requests/${cancelReq.result.cancelRequestId}/resolve`, {
      requestKey: randomUUID(), decision: 'approve'
    }, f.merchant.token)
    assert.equal(cancelRes.status, 200, JSON.stringify(cancelRes))
    const o1Refund = f.ctx.db.one<{ amount: number; state: string }>(
      "SELECT r.amount,r.state FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.order_id=? AND r.reason='cancelled'",
      o1
    )!
    assert.equal(o1Refund.amount, 9000)
    assert.equal(o1Refund.state, 'succeeded')

    // 2) o2 将补差通道置为 unknown（继续占额 1000），发货收货后申请少件仅退款 -> 退 9000，合计 R+C+U=10000
    const d2 = (await f.call('GET', `/buyer/orders/${o2}/compensation/drafts`)).result[0]
    const r2 = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: d2.draftId, requestKey: randomUUID(), confirmedCents: 1000
    })
    assert.equal(r2.status, 200)
    f.ctx.db.run("UPDATE compensation_receipts SET channel_status='unknown' WHERE receipt_id=?", r2.result.receiptId)

    assert.equal((await f.call('POST', `/merchant/orders/${o2}/ship`, { carrier: '顺丰', trackingNo: 'SF200001' }, f.merchant.token)).status, 200)
    assert.equal((await f.call('PUT', `/member/order/${o2}/receipt`, {})).status, 200)
    const saleReq = await f.call('POST', `/member/order/${o2}/after-sales`, {
      requestKey: randomUUID(), kind: 'refund-missing', description: '补差后申请少件退款',
      items: [{ skuId: f.sku.id, count: 1 }]
    })
    assert.equal(saleReq.status, 200, JSON.stringify(saleReq))
    const saleApp = await f.call('POST', `/merchant/after-sales/${saleReq.result.afterSaleId}/approve`, {
      requestKey: randomUUID()
    }, f.merchant.token)
    assert.equal(saleApp.status, 200, JSON.stringify(saleApp))
    const o2Refund = f.ctx.db.one<{ amount: number }>(
      "SELECT r.amount FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.order_id=? AND r.reason='after-sale'",
      o2
    )!
    assert.equal(o2Refund.amount, 9000)

    await f.ctx.app.close()
    const backup = await createBackup({
      databasePath: join(root, 'data', 'mall.sqlite'),
      uploadsPath: join(root, 'uploads'),
      destination: join(root, 'backup')
    })
    assert.equal(backup.manifest.schemaVersion, 30)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('P1修复2：连续降价按累计新低目标扣减已占额，单笔上限/多事件/反序确认/涨价不追回全成立', async () => {
  const f = await setupFixture({ priceCents: 10000 })
  try {
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 2500, totalBudgetCents: 100000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()

    // Case A: 原实付10000 -> 9000确认1000 -> 8000再确认1000 -> 累计2000
    const o1 = await f.placeAndPay(1, 10000)
    f.tick(1000)
    await f.lowerProductPrice(9000)
    runRadar(f.ctx.db, f.getNow())
    const d1 = (await f.call('GET', `/buyer/orders/${o1}/compensation/drafts`)).result[0]
    assert.equal(d1.cappedCents, 1000)
    assert.equal((await f.call('POST', '/buyer/compensation/confirm', {
      draftId: d1.draftId, requestKey: randomUUID(), confirmedCents: 1000
    })).status, 200)

    f.tick(1000)
    await f.lowerProductPrice(8000)
    runRadar(f.ctx.db, f.getNow())
    const d2List = (await f.call('GET', `/buyer/orders/${o1}/compensation/drafts`)).result
    assert.equal(d2List.length, 1)
    assert.equal(d2List[0].cappedCents, 1000)
    assert.equal((await f.call('POST', '/buyer/compensation/confirm', {
      draftId: d2List[0].draftId, requestKey: randomUUID(), confirmedCents: 1000
    })).status, 200)
    assert.equal(f.ctx.db.one<{ total: number }>('SELECT SUM(confirmed_cents) total FROM compensation_receipts WHERE order_id=?', o1)!.total, 2000)

    // Case B: 再降到 6000（新低差4000，但单笔政策上限2500）-> 仅补 500，总计 2500；涨回 9500 不追回已补
    f.tick(1000)
    await f.lowerProductPrice(6000)
    runRadar(f.ctx.db, f.getNow())
    const d3 = (await f.call('GET', `/buyer/orders/${o1}/compensation/drafts`)).result[0]
    assert.equal(d3.cappedCents, 500)
    assert.equal((await f.call('POST', '/buyer/compensation/confirm', {
      draftId: d3.draftId, requestKey: randomUUID(), confirmedCents: 500
    })).status, 200)
    assert.equal(f.ctx.db.one<{ total: number }>('SELECT SUM(confirmed_cents) total FROM compensation_receipts WHERE order_id=?', o1)!.total, 2500)

    // Case C: 多份待确认草稿不同顺序确认不重复补、同轮多事件只签发一份；涨价后再微降（仍在已补2500内）不再签发
    f.tick(1000)
    await f.lowerProductPrice(10000)
    const o2 = await f.placeAndPay(1, 10000)
    f.tick(1000)
    await f.lowerProductPrice(9000)
    runRadar(f.ctx.db, f.getNow()) // 创建 o2 第1份草稿 1000
    f.tick(1000)
    await f.lowerProductPrice(8000)
    runRadar(f.ctx.db, f.getNow()) // 创建 o2 第2份草稿 1000
    const o2Drafts = (await f.call('GET', `/buyer/orders/${o2}/compensation/drafts`)).result
    assert.equal(o2Drafts.length, 2)
    // 反序：先确认更新的那份，再确认先前的那份
    for (const draft of o2Drafts) {
      assert.equal(draft.cappedCents, 1000)
      assert.equal((await f.call('POST', '/buyer/compensation/confirm', {
        draftId: draft.draftId, requestKey: randomUUID(), confirmedCents: 1000
      })).status, 200)
    }
    assert.equal(f.ctx.db.one<{ total: number }>('SELECT SUM(confirmed_cents) total FROM compensation_receipts WHERE order_id=?', o2)!.total, 2000)
    // 涨回 9500 不追回，且再降到 9000 也不再新增草稿（仍高于已补新低 8000）
    f.tick(1000)
    await f.lowerProductPrice(9500)
    f.tick(1000)
    await f.lowerProductPrice(9000)
    const extraScan = runRadar(f.ctx.db, f.getNow())
    assert.equal(extraScan.created, 0)
    assert.equal((await f.call('GET', `/buyer/orders/${o2}/compensation/drafts`)).result.length, 0)
  } finally { await f.cleanup() }
})

test('P1修复3：部分退货与价格回弹使旧草稿失效并重算重确认（雷达扫前/扫后均拒旧金额）', async () => {
  const f = await setupFixture({ priceCents: 10000 })
  try {
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 5000, totalBudgetCents: 100000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()

    // Case A: 2件各10000 -> 8000，草稿4000 -> 退1件后直接确认旧草稿 -> 409并重算新草稿2000
    const o1 = await f.placeAndPay(2, 10000)
    f.tick(1)
    const o2 = await f.placeAndPay(2, 10000)
    f.tick(1000)
    await f.lowerProductPrice(8000)
    runRadar(f.ctx.db, f.getNow())

    const d1Old = (await f.call('GET', `/buyer/orders/${o1}/compensation/drafts`)).result[0]
    assert.equal(d1Old.cappedCents, 4000)

    assert.equal((await f.call('POST', `/merchant/orders/${o1}/ship`, { carrier: '顺丰', trackingNo: 'SF300001' }, f.merchant.token)).status, 200)
    assert.equal((await f.call('PUT', `/member/order/${o1}/receipt`, {})).status, 200)
    const s1 = await f.call('POST', `/member/order/${o1}/after-sales`, {
      requestKey: randomUUID(), kind: 'refund-missing', description: '少一件退款后重算补差',
      items: [{ skuId: f.sku.id, count: 1 }]
    })
    assert.equal(s1.status, 200)
    assert.equal((await f.call('POST', `/merchant/after-sales/${s1.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)).status, 200)

    // 不经雷达直接提交旧草稿 -> 拒绝 409 并自动生成重算后 2000 新草稿
    const staleTry = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: d1Old.draftId, requestKey: randomUUID(), confirmedCents: 4000
    })
    assert.equal(staleTry.status, 409)
    assert.equal(staleTry.reason, 'COMPENSATION_CONDITION_CHANGED')

    const d1NewList = (await f.call('GET', `/buyer/orders/${o1}/compensation/drafts`)).result
    assert.equal(d1NewList.length, 1)
    assert.equal(d1NewList[0].cappedCents, 2000)
    const confirmNew1 = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: d1NewList[0].draftId, requestKey: randomUUID(), confirmedCents: 2000
    })
    assert.equal(confirmNew1.status, 200)
    assert.equal(confirmNew1.result.confirmedCents, 2000)

    // Case B: o2 退1件后先走雷达重算，旧4000作废、新2000签发
    const d2Old = (await f.call('GET', `/buyer/orders/${o2}/compensation/drafts`)).result[0]
    assert.equal(d2Old.cappedCents, 4000)
    assert.equal((await f.call('POST', `/merchant/orders/${o2}/ship`, { carrier: '顺丰', trackingNo: 'SF300002' }, f.merchant.token)).status, 200)
    assert.equal((await f.call('PUT', `/member/order/${o2}/receipt`, {})).status, 200)
    const s2 = await f.call('POST', `/member/order/${o2}/after-sales`, {
      requestKey: randomUUID(), kind: 'refund-missing', description: '先退一件再跑雷达',
      items: [{ skuId: f.sku.id, count: 1 }]
    })
    assert.equal(s2.status, 200)
    assert.equal((await f.call('POST', `/merchant/after-sales/${s2.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)).status, 200)

    const rescan = runRadar(f.ctx.db, f.getNow() + 1000)
    assert.ok(rescan.cancelled >= 1 && rescan.recalculated >= 1)
    assert.equal((await f.call('POST', '/buyer/compensation/confirm', {
      draftId: d2Old.draftId, requestKey: randomUUID(), confirmedCents: 4000
    })).status, 409)
    const d2NewList = (await f.call('GET', `/buyer/orders/${o2}/compensation/drafts`)).result
    assert.equal(d2NewList.length, 1)
    assert.equal(d2NewList[0].cappedCents, 2000)
    assert.equal((await f.call('POST', '/buyer/compensation/confirm', {
      draftId: d2NewList[0].draftId, requestKey: randomUUID(), confirmedCents: 2000
    })).status, 200)
  } finally { await f.cleanup() }
})

test('P2修复4：长期生效政策不被 window_days 截断，订单窗口边界与新旧政策隔离成立', async () => {
  const f = await setupFixture({ priceCents: 10000 })
  try {
    // 第1版：保护7天，上限1000；第1天后生效
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 1000, totalBudgetCents: 100000 })
    // 生效第8天后才下单（第9天+1秒）
    f.tick(8 * ONE_DAY_MS + 1000)
    await f.reloginAll()

    const orderDay8 = await f.placeAndPay(1, 10000)
    f.tick(1000)
    await f.lowerProductPrice(9000)
    const scan1 = runRadar(f.ctx.db, f.getNow())
    assert.equal(scan1.created, 1)
    const draftsDay8 = (await f.call('GET', `/buyer/orders/${orderDay8}/compensation/drafts`)).result
    assert.equal(draftsDay8.length, 1)
    assert.equal(draftsDay8[0].cappedCents, 1000)
    assert.equal(draftsDay8[0].policyVersion, 1)

    // 边界：orderDay8 窗口为 [paid_at, paid_at + 7天)；若直到过窗第8天后才降价，不再对该单建草稿
    f.tick(8 * ONE_DAY_MS)
    await f.reloginAll()
    await f.lowerProductPrice(7000)
    runRadar(f.ctx.db, f.getNow())
    const afterExpiryDrafts = (await f.call('GET', `/buyer/orders/${orderDay8}/compensation/drafts`)).result
    assert.equal(afterExpiryDrafts.length, 0)

    // 发布第2版政策（10天，单笔上限3000，第1天后生效），对比旧单与新单版本隔离
    await f.lowerProductPrice(10000)
    await f.publishPolicy({ windowDays: 10, budgetPerOrderCents: 3000, totalBudgetCents: 100000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()
    const orderV2 = await f.placeAndPay(1, 10000)
    f.tick(1000)
    await f.lowerProductPrice(7500)
    runRadar(f.ctx.db, f.getNow())
    const v2Draft = (await f.call('GET', `/buyer/orders/${orderV2}/compensation/drafts`)).result[0]
    assert.equal(v2Draft.policyVersion, 2)
    assert.equal(v2Draft.windowDays, 10)
    assert.equal(v2Draft.cappedCents, 2500)
  } finally { await f.cleanup() }
})

test('真实 v29 数据库升级到 v30 保留三表并验证旧草稿在部分退货后仍失效', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hdm-comp-v29-upg-'))
  const f = await setupFixture({ priceCents: 10000, rootDir: root })
  try {
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 5000, totalBudgetCents: 100000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()
    const orderId = await f.placeAndPay(2, 10000)
    f.tick(1000)
    await f.lowerProductPrice(8000)
    runRadar(f.ctx.db, f.getNow())
    const draft = (await f.call('GET', `/buyer/orders/${orderId}/compensation/drafts`)).result[0]
    assert.equal(draft.cappedCents, 4000)
    await f.ctx.app.close()

    // 把库还原为真实的 v29 结构与数据（无 v30 索引、无 condition_hash、无 compensation_radar_state）
    const dbFile = join(root, 'data', 'mall.sqlite')
    const raw = new DatabaseSync(dbFile)
    try {
      raw.exec(`
        PRAGMA foreign_keys=OFF;
        DROP TRIGGER IF EXISTS orders_anchor_insert;
        DROP TRIGGER IF EXISTS orders_anchor_paid;
        DROP TABLE IF EXISTS order_audit_anchors;
        DROP TABLE IF EXISTS compensation_radar_state;
        DROP INDEX IF EXISTS cd_idempotency_live;
        DROP INDEX IF EXISTS cd_buyer_status;
        DROP INDEX IF EXISTS cd_order_active;
        DROP INDEX IF EXISTS cd_expiring;
        DROP INDEX IF EXISTS cr_order_active;
        DROP INDEX IF EXISTS cr_policy_active;
        DROP INDEX IF EXISTS orders_paid_radar;
        DROP INDEX IF EXISTS ppp_effective;
        CREATE TABLE compensation_drafts_v29 (
          id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), policy_id TEXT NOT NULL REFERENCES price_protection_policies(id),
          price_event_id TEXT NOT NULL REFERENCES price_events(id), merchant_id TEXT NOT NULL REFERENCES users(id),
          buyer_id TEXT NOT NULL REFERENCES users(id), basket_delta_cents INTEGER NOT NULL CHECK(basket_delta_cents > 0),
          capped_cents INTEGER NOT NULL CHECK(capped_cents > 0), per_line JSON NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','pending_budget','confirmed','expired','cancelled'))
        );
        INSERT INTO compensation_drafts_v29 SELECT id,order_id,policy_id,price_event_id,merchant_id,buyer_id,basket_delta_cents,capped_cents,per_line,idempotency_key,created_at,expires_at,status FROM compensation_drafts;
        DROP TABLE compensation_drafts;
        ALTER TABLE compensation_drafts_v29 RENAME TO compensation_drafts;
        CREATE INDEX cd_buyer_status ON compensation_drafts(buyer_id, status, expires_at);
        PRAGMA user_version=29;
        PRAGMA foreign_keys=ON;
      `)
      assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 29)
    } finally {
      raw.close()
    }

    // 用 buildTestApp 重新打开：自动升级 v29 -> v30，保留原有 4000 草稿，且部分退货后仍可校验并拒绝旧草稿
    const app2 = await buildTestApp({
      databasePath: dbFile,
      uploadsPath: join(root, 'uploads'),
      publicUrl: 'http://localhost',
      mockPayments: true,
      clock: { now: () => f.getNow() }
    })
    try {
      assert.equal(app2.db.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 30)
      assert.equal(app2.db.one<{ n: number }>('SELECT COUNT(*) n FROM compensation_drafts WHERE id=?', draft.draftId)!.n, 1)
      assert.equal(app2.db.one<{ id: number }>('SELECT id FROM compensation_radar_state WHERE id=1')!.id, 1)

      const bLogin = (await app2.app.inject({ method: 'POST', url: '/login', payload: { account: 'buyer1', password: 'test-password-123' } })).json().result.token
      const mLogin = (await app2.app.inject({ method: 'POST', url: '/login', payload: { account: 'seller1', password: 'test-password-123' } })).json().result.token
      assert.equal((await app2.app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/ship`, headers: identityHeaders(app2.accounts, mLogin), payload: { carrier: '顺丰', trackingNo: 'SF999999' } })).statusCode, 200)
      assert.equal((await app2.app.inject({ method: 'PUT', url: `/member/order/${orderId}/receipt`, headers: identityHeaders(app2.accounts, bLogin), payload: {} })).statusCode, 200)
      const sale = await app2.app.inject({
        method: 'POST', url: `/member/order/${orderId}/after-sales`, headers: identityHeaders(app2.accounts, bLogin),
        payload: { requestKey: randomUUID(), kind: 'refund-missing', description: '旧库升级后部分退货重算', items: [{ skuId: f.sku.id, count: 1 }] }
      })
      assert.equal(sale.statusCode, 200)
      assert.equal((await app2.app.inject({
        method: 'POST', url: `/merchant/after-sales/${sale.json().result.afterSaleId}/approve`, headers: identityHeaders(app2.accounts, mLogin), payload: { requestKey: randomUUID() }
      })).statusCode, 200)

      const oldConfirm = await app2.app.inject({
        method: 'POST', url: '/buyer/compensation/confirm', headers: identityHeaders(app2.accounts, bLogin),
        payload: { draftId: draft.draftId, requestKey: randomUUID(), confirmedCents: 4000 }
      })
      assert.equal(oldConfirm.statusCode, 409)
      const draftsAfter = (await app2.app.inject({
        method: 'GET', url: `/buyer/orders/${orderId}/compensation/drafts`, headers: identityHeaders(app2.accounts, bLogin)
      })).json().result
      assert.equal(draftsAfter.length, 1)
      assert.equal(draftsAfter[0].cappedCents, 2000)
    } finally {
      await app2.app.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('性能与查询计划：雷达按覆盖局部索引 orders_paid_radar 裁剪历史订单并验证覆盖索引', async () => {
  const f = await setupFixture({ priceCents: 10000 })
  try {
    const db = f.ctx.db
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 2000, totalBudgetCents: 10000000 })
    // 写入 500 条早已出窗的历史已付款订单 + 10 条生效后窗口期内订单
    const oldPaidAt = f.getNow()
    f.tick(30 * ONE_DAY_MS)
    await f.reloginAll()
    // 推进雷达检查点越过历史订单
    runRadar(db, f.getNow())
    for (let i = 0; i < 500; i++) {
      db.run(
        `INSERT INTO orders(id,owner_id,state,amount,discount,created,expires,paid_by,paid_at,address,request_key,request_body)
         VALUES(?,?,2,10000,0,?,?,?,?,?,?,?)`,
        randomUUID(), f.buyer.id, oldPaidAt - 10000 + i, oldPaidAt + 900000, f.buyer.id, oldPaidAt - 10000 + i,
        JSON.stringify({ receiver: 'A', contact: '13800000000', address: 'X' }), randomUUID(), '{}'
      )
    }
    const activeIds: string[] = []
    for (let i = 0; i < 10; i++) {
      f.tick(1)
      activeIds.push(await f.placeAndPay(1, 10000))
    }
    db.run('ANALYZE')

    const eqpOrders = db.all<{ detail: string }>(
      'EXPLAIN QUERY PLAN SELECT id,owner_id,amount,paid_at FROM orders WHERE state IN (2,3,4,5) AND paid_at IS NOT NULL AND paid_at >= ? ORDER BY paid_at ASC, id ASC',
      f.getNow() - 7 * ONE_DAY_MS
    ).map(r => r.detail).join(' | ')
    assert.match(eqpOrders, /orders_paid_radar/)
    assert.ok(!/USE TEMP B-TREE FOR ORDER BY/.test(eqpOrders), eqpOrders)

    const eqpReceipts = db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT COALESCE(SUM(confirmed_cents),0) FROM compensation_receipts WHERE order_id=? AND channel_status<>'failed'",
      activeIds[0]!
    ).map(r => r.detail).join(' | ')
    assert.match(eqpReceipts, /cr_order_active/)

    f.tick(1000)
    await f.lowerProductPrice(9000)
    const scan = runRadar(db, f.getNow())
    assert.equal(scan.created, 10)

    db.run('ANALYZE')
    const eqpDrafts = db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN UPDATE compensation_drafts SET status='expired' WHERE status IN ('pending','pending_budget') AND expires_at<=?",
      f.getNow()
    ).map(r => r.detail).join(' | ')
    assert.match(eqpDrafts, /cd_expiring/)
  } finally { await f.cleanup() }
})

test('按件精确归因：补差->退1件->二次降价->退第2件全链路金额守恒且通过备份校验与恢复', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hdm-comp-unit-cyc-'))
  const f = await setupFixture({ priceCents: 10000, rootDir: root })
  try {
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 10000, totalBudgetCents: 100000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()
    const orderId = await f.placeAndPay(2, 10000)

    // 发货并确认收货后第一次降价至 8000，确认补差 4000（每件 2000）
    assert.equal((await f.call('POST', `/merchant/orders/${orderId}/ship`, { carrier: '顺丰', trackingNo: 'SF-UNIT-1' }, f.merchant.token)).status, 200)
    assert.equal((await f.call('PUT', `/member/order/${orderId}/receipt`, {})).status, 200)
    f.tick(1000)
    await f.lowerProductPrice(8000)
    runRadar(f.ctx.db, f.getNow())
    const d1 = (await f.call('GET', `/buyer/orders/${orderId}/compensation/drafts`)).result[0]
    assert.equal(d1.cappedCents, 4000)
    await f.call('POST', '/buyer/compensation/confirm', {
      draftId: d1.draftId, requestKey: randomUUID(), confirmedCents: 4000
    })

    // 退第 1 件（refund-missing）：扣除该件自身分得的 2000，实退 8000
    f.tick(1000)
    const sale1 = await f.call('POST', `/member/order/${orderId}/after-sales`, {
      requestKey: randomUUID(), kind: 'refund-missing', description: '少发第1件按件扣减补差', items: [{ skuId: f.sku.id, count: 1 }]
    })
    assert.equal(sale1.status, 200, JSON.stringify(sale1))
    const approve1 = await f.call('POST', `/merchant/after-sales/${sale1.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)
    assert.equal(approve1.result.appliedState, 'refunding')
    const r1 = f.ctx.db.one<{ amount: number }>('SELECT amount FROM after_sales WHERE id=?', sale1.result.afterSaleId)!
    assert.equal(r1.amount, 8000)

    // 二次降价至 6000：留件目标 4000，仅扣留件已获 2000，应新签 2000（不把退件的 2000 转计留件）
    f.tick(1000)
    await f.lowerProductPrice(6000)
    runRadar(f.ctx.db, f.getNow())
    const d2List = (await f.call('GET', `/buyer/orders/${orderId}/compensation/drafts`)).result
    assert.equal(d2List.length, 1)
    assert.equal(d2List[0].cappedCents, 2000)
    await f.call('POST', '/buyer/compensation/confirm', {
      draftId: d2List[0].draftId, requestKey: randomUUID(), confirmedCents: 2000
    })

    // 继续退回第 2 件（留件累计已领 2000+2000=4000），实退应为 10000 - 4000 = 6000；总计 4000+8000+2000+6000 = 20000
    f.tick(1000)
    const sale2 = await f.call('POST', `/member/order/${orderId}/after-sales`, {
      requestKey: randomUUID(), kind: 'refund-missing', description: '第2件退款扣除累计4000补差', items: [{ skuId: f.sku.id, count: 1 }]
    })
    assert.equal(sale2.status, 200, JSON.stringify(sale2))
    assert.equal((await f.call('POST', `/merchant/after-sales/${sale2.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)).status, 200)
    const r2 = f.ctx.db.one<{ amount: number }>('SELECT amount FROM after_sales WHERE id=?', sale2.result.afterSaleId)!
    assert.equal(r2.amount, 6000)

    // 备份校验与恢复闭环（包含补差 + 两次部分售后退款）
    await f.ctx.app.close()
    const options = { databasePath: join(root, 'data', 'mall.sqlite'), uploadsPath: join(root, 'uploads') }
    const backup = await createBackup({ ...options, destination: join(root, 'backup') })
    assert.equal(backup.manifest.schemaVersion, 30)
    const verified = await verifyBackup(backup.root)
    assert.equal(verified.manifest.format, 1)
    assert.equal(verified.counts.compensation_receipts, 2)
    assert.equal(verified.counts.after_sales, 2)
    const restored = await restoreBackup({ backupPath: backup.root, destination: join(root, 'restored') })
    assert.equal(restored.report.format, 1)
  } finally {
    try { await f.ctx.app.close() } catch {}
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('多SKU篮子按行归因与冻结时钟条件指纹消歧，且不把已降价SKU补差误扣到另一SKU', async () => {
  const f = await setupFixture({ priceCents: 10000 })
  try {
    const productB = f.ctx.testData.product({
      name: '副商品B',
      category: '箱包',
      description: '另一条SKU。',
      skus: [{ spec: 'B款', priceCents: 10000, stock: 50 }]
    })
    const skuB = productB.skus[0]!

    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 10000, totalBudgetCents: 100000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()

    const orderRes = await f.call('POST', '/member/order', {
      requestKey: randomUUID(),
      goods: [{ skuId: f.sku.id, count: 2 }, { skuId: skuB.id, count: 1 }],
      addressId: f.address.id,
      expectedAmountCents: 30000
    })
    assert.equal(orderRes.status, 200, JSON.stringify(orderRes))
    const orderId = orderRes.result.id as string
    assert.equal((await f.call('POST', `/member/order/${orderId}/mock-pay`, { amountCents: 30000 })).status, 200)
    assert.equal((await f.call('POST', `/merchant/orders/${orderId}/ship`, { carrier: '顺丰', trackingNo: 'SF-MULTI-SKU' }, f.merchant.token)).status, 200)
    assert.equal((await f.call('PUT', `/member/order/${orderId}/receipt`, {})).status, 200)

    // Drop 1: 仅 A 降价 10000 -> 8000；不推进时钟直接确认并申请 B 售后（验证同毫秒时间戳 via conditionHash 不歧义）
    f.tick(1000)
    await f.lowerProductPrice(8000)
    runRadar(f.ctx.db, f.getNow())
    const d1 = (await f.call('GET', `/buyer/orders/${orderId}/compensation/drafts`)).result[0]
    assert.equal(d1.cappedCents, 4000)
    await f.call('POST', '/buyer/compensation/confirm', {
      draftId: d1.draftId, requestKey: randomUUID(), confirmedCents: 4000
    })
    // 同一毫秒申请退 B（1件）：B 从未领过补差，应按 B 实付全额退款 10000，不被 A 的补差扣减
    const saleB = await f.call('POST', `/member/order/${orderId}/after-sales`, {
      requestKey: randomUUID(), kind: 'refund-missing', description: '退未补差的SKU-B', items: [{ skuId: skuB.id, count: 1 }]
    })
    assert.equal(saleB.status, 200, JSON.stringify(saleB))
    assert.equal(f.ctx.db.one<{ amount: number }>('SELECT amount FROM after_sales WHERE id=?', saleB.result.afterSaleId)!.amount, 10000)

    // 之后 A 再降到 7000，仅扣 A 自己之前已确认的 4000，保留 2000 增量，不会误扣 B
    f.tick(1000)
    await f.lowerProductPrice(7000)
    runRadar(f.ctx.db, f.getNow())
    const d2 = (await f.call('GET', `/buyer/orders/${orderId}/compensation/drafts`)).result
    assert.equal(d2.length, 1)
    assert.equal(d2[0].cappedCents, 2000)
  } finally { await f.cleanup() }
})

test('奇数分摊与冻结同毫秒补差对部分退货退款扣减的精确守恒', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hdm-comp-odd-'))
  const f = await setupFixture({ priceCents: 5000, rootDir: root })
  try {
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 10000, totalBudgetCents: 100000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()
    const orderId = await f.placeAndPay(2, 5000) // 两件各 5000，实付 10000

    await f.call('POST', `/merchant/orders/${orderId}/ship`, { carrier: '顺丰', trackingNo: 'SF-ODD' }, f.merchant.token)
    await f.call('PUT', `/member/order/${orderId}/receipt`, {})
    f.tick(1000)
    await f.lowerProductPrice(4000)
    runRadar(f.ctx.db, f.getNow())
    const d1 = (await f.call('GET', `/buyer/orders/${orderId}/compensation/drafts`)).result[0]
    // 奇数 101 分按稳定件 ID 升序分配 51 + 50（先向下取整各50，余1给第1件）；先退第1件扣除51得4949，第2件扣除50得4950
    f.ctx.db.run('UPDATE compensation_drafts SET basket_delta_cents=101, capped_cents=101, per_line=? WHERE id=?',
      JSON.stringify([{ order_line_id: f.sku.id, delta_cents: 101 }]), d1.draftId)
    await f.call('POST', '/buyer/compensation/confirm', {
      draftId: d1.draftId, requestKey: randomUUID(), confirmedCents: 101
    })

    const sale1 = await f.call('POST', `/member/order/${orderId}/after-sales`, {
      requestKey: randomUUID(), kind: 'refund-missing', description: '奇数分摊第1件退货', items: [{ skuId: f.sku.id, count: 1 }]
    })
    assert.equal(sale1.status, 200, JSON.stringify(sale1))
    assert.equal(f.ctx.db.one<{ amount: number }>('SELECT amount FROM after_sales WHERE id=?', sale1.result.afterSaleId)!.amount, 4949)
    await f.call('POST', `/merchant/after-sales/${sale1.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)

    // 第 2 件分得 50 分，再退第 2 件应退 5000 - 50 = 4950，总计 101 + 4949 + 4950 = 10000 严密守恒
    f.tick(1000)
    const sale2 = await f.call('POST', `/member/order/${orderId}/after-sales`, {
      requestKey: randomUUID(), kind: 'refund-missing', description: '奇数分摊第2件退货', items: [{ skuId: f.sku.id, count: 1 }]
    })
    assert.equal(sale2.status, 200, JSON.stringify(sale2))
    assert.equal(f.ctx.db.one<{ amount: number }>('SELECT amount FROM after_sales WHERE id=?', sale2.result.afterSaleId)!.amount, 4950)
    await f.call('POST', `/merchant/after-sales/${sale2.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)

    await f.ctx.app.close()
    const options = { databasePath: join(root, 'data', 'mall.sqlite'), uploadsPath: join(root, 'uploads') }
    const backup = await createBackup({ ...options, destination: join(root, 'backup') })
    const verifiedOdd = await verifyBackup(backup.root)
    assert.equal(verifiedOdd.manifest.format, 1)
  } finally {
    try { await f.ctx.app.close() } catch {}
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('部分退件不释放同单政策累计上限，仅渠道 failed 时释放占额', async () => {
  const f = await setupFixture({ priceCents: 10000 })
  try {
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 5000, totalBudgetCents: 100000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()

    // 场景 A：买2件各10000（实付20000），单笔上限5000；降到6000确认5000 -> 退1件实退7500 -> 再降到1000，整单上限已满不得再补
    const orderFull = await f.placeAndPay(2, 10000)
    await f.lowerProductPrice(6000)
    runRadar(f.ctx.db, f.getNow())
    const dFull = (await f.call('GET', `/buyer/orders/${orderFull}/compensation/drafts`)).result[0]
    assert.equal(dFull.cappedCents, 5000)
    const rFull = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: dFull.draftId, requestKey: randomUUID(), confirmedCents: 5000
    })
    assert.equal(rFull.status, 200)
    f.ctx.db.run("UPDATE compensation_receipts SET channel_status='executed' WHERE receipt_id=?", rFull.result.receiptId)

    await f.call('POST', `/merchant/orders/${orderFull}/ship`, { carrier: '顺丰', trackingNo: 'SF-CAP-1' }, f.merchant.token)
    await f.call('PUT', `/member/order/${orderFull}/receipt`, {})
    f.tick(1000)
    const saleFull = await f.call('POST', `/member/order/${orderFull}/after-sales`, {
      requestKey: randomUUID(), kind: 'refund-missing', description: '退1件后整单5000上限不得释放', items: [{ skuId: f.sku.id, count: 1 }]
    })
    assert.equal(saleFull.status, 200)
    await f.call('POST', `/merchant/after-sales/${saleFull.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)
    assert.equal(f.ctx.db.one<{ amount: number }>('SELECT amount FROM after_sales WHERE id=?', saleFull.result.afterSaleId)!.amount, 7500)

    f.tick(1000)
    await f.lowerProductPrice(1000)
    runRadar(f.ctx.db, f.getNow())
    assert.equal((await f.call('GET', `/buyer/orders/${orderFull}/compensation/drafts`)).result.length, 0)

    // 若之前回执改为 failed，则仅释放留件自身未兑现的 2500，已退件被原篮 K 占用的 2500 仍不转嫁给留件
    f.ctx.db.run("UPDATE compensation_receipts SET channel_status='failed' WHERE receipt_id=?", rFull.result.receiptId)
    f.tick(1000)
    await f.lowerProductPrice(900)
    runRadar(f.ctx.db, f.getNow())
    const afterFailed = (await f.call('GET', `/buyer/orders/${orderFull}/compensation/drafts`)).result
    assert.equal(afterFailed.length, 1)
    assert.equal(afterFailed[0].cappedCents, 2500)

    // 单件全退前 failed 则恢复单件完整上限 5000
    await f.lowerProductPrice(10000)
    f.tick(1000)
    const singleOrd = await f.placeAndPay(1, 10000)
    await f.lowerProductPrice(4000)
    runRadar(f.ctx.db, f.getNow())
    const dSingle = (await f.call('GET', `/buyer/orders/${singleOrd}/compensation/drafts`)).result[0]
    assert.equal(dSingle.cappedCents, 5000)
    const rSingle = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: dSingle.draftId, requestKey: randomUUID(), confirmedCents: 5000
    })
    assert.equal(rSingle.status, 200)
    f.ctx.db.run("UPDATE compensation_receipts SET channel_status='failed' WHERE receipt_id=?", rSingle.result.receiptId)
    f.tick(1000)
    await f.lowerProductPrice(3900)
    runRadar(f.ctx.db, f.getNow())
    const afterSingleFailed = (await f.call('GET', `/buyer/orders/${singleOrd}/compensation/drafts`)).result
    assert.equal(afterSingleFailed.length, 1)
    assert.equal(afterSingleFailed[0].cappedCents, 5000)

    // 场景 B：买2件各10000，先补差4000(各2000) -> 退1件(实退8000) -> 再降到1000：整单K上限5000余1000分配到原2件各+500，仅留件可得500（总计4500<=5000）
    await f.lowerProductPrice(10000)
    f.tick(1000)
    const orderPart = await f.placeAndPay(2, 10000)
    await f.lowerProductPrice(8000)
    runRadar(f.ctx.db, f.getNow())
    const dPart1 = (await f.call('GET', `/buyer/orders/${orderPart}/compensation/drafts`)).result[0]
    assert.equal(dPart1.cappedCents, 4000)
    await f.call('POST', '/buyer/compensation/confirm', {
      draftId: dPart1.draftId, requestKey: randomUUID(), confirmedCents: 4000
    })

    await f.call('POST', `/merchant/orders/${orderPart}/ship`, { carrier: '顺丰', trackingNo: 'SF-CAP-2' }, f.merchant.token)
    await f.call('PUT', `/member/order/${orderPart}/receipt`, {})
    f.tick(1000)
    const salePart = await f.call('POST', `/member/order/${orderPart}/after-sales`, {
      requestKey: randomUUID(), kind: 'refund-missing', description: '退1件后整单剩余K均分原篮留件仅得500', items: [{ skuId: f.sku.id, count: 1 }]
    })
    assert.equal(f.ctx.db.one<{ amount: number }>('SELECT amount FROM after_sales WHERE id=?', salePart.result.afterSaleId)!.amount, 8000)
    await f.call('POST', `/merchant/after-sales/${salePart.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)

    f.tick(1000)
    await f.lowerProductPrice(1000)
    runRadar(f.ctx.db, f.getNow())
    const dPart2 = (await f.call('GET', `/buyer/orders/${orderPart}/compensation/drafts`)).result
    assert.equal(dPart2.length, 1)
    assert.equal(dPart2[0].cappedCents, 500)
    const rPart2 = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: dPart2[0].draftId, requestKey: randomUUID(), confirmedCents: 500
    })
    assert.equal(rPart2.status, 200)
    assert.equal(
      f.ctx.db.one<{ total: number }>("SELECT COALESCE(SUM(confirmed_cents),0) total FROM compensation_receipts WHERE order_id=? AND channel_status<>'failed'", orderPart)!.total,
      4500
    )

    // 场景 C（未确认草稿退件 K 不重分）：买2件各10000，上限5000；降到6000生成5000未确认草稿（各占2500）-> 退1件 -> 旧草稿409作废，重算新草稿与再扫仅给留件2500；之后再降至1000仍不再把退件占用的2500转给留件
    await f.lowerProductPrice(10000)
    f.tick(1000)
    const orderUnconf = await f.placeAndPay(2, 10000)
    await f.lowerProductPrice(6000)
    runRadar(f.ctx.db, f.getNow())
    const oldUnconf = (await f.call('GET', `/buyer/orders/${orderUnconf}/compensation/drafts`)).result[0]
    assert.equal(oldUnconf.cappedCents, 5000)

    await f.call('POST', `/merchant/orders/${orderUnconf}/ship`, { carrier: '顺丰', trackingNo: 'SF-CAP-3' }, f.merchant.token)
    await f.call('PUT', `/member/order/${orderUnconf}/receipt`, {})
    f.tick(1000)
    const saleUnconf = await f.call('POST', `/member/order/${orderUnconf}/after-sales`, {
      requestKey: randomUUID(), kind: 'refund-missing', description: '未确认草稿退1件不转分K额度', items: [{ skuId: f.sku.id, count: 1 }]
    })
    assert.equal(f.ctx.db.one<{ amount: number }>('SELECT amount FROM after_sales WHERE id=?', saleUnconf.result.afterSaleId)!.amount, 10000)
    await f.call('POST', `/merchant/after-sales/${saleUnconf.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)

    const staleTry = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: oldUnconf.draftId, requestKey: randomUUID(), confirmedCents: 5000
    })
    assert.equal(staleTry.status, 409)
    assert.equal(staleTry.reason, 'COMPENSATION_CONDITION_CHANGED')

    runRadar(f.ctx.db, f.getNow())
    const dUnconfNew = (await f.call('GET', `/buyer/orders/${orderUnconf}/compensation/drafts`)).result
    assert.equal(dUnconfNew.length, 1)
    assert.equal(dUnconfNew[0].cappedCents, 2500)
    const rUnconf = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: dUnconfNew[0].draftId, requestKey: randomUUID(), confirmedCents: 2500
    })
    assert.equal(rUnconf.status, 200)

    f.tick(1000)
    await f.lowerProductPrice(1000)
    runRadar(f.ctx.db, f.getNow())
    assert.equal((await f.call('GET', `/buyer/orders/${orderUnconf}/compensation/drafts`)).result.length, 0)
  } finally { await f.cleanup() }
})

test('补差后净额取消备份校验与默认恢复（含pending/unknown/executed/failed及异常篡改拦截）', async () => {
  for (const channel of ['pending', 'unknown', 'executed', 'failed-after-cancel', 'failed-before-cancel'] as const) {
    const root = mkdtempSync(join(tmpdir(), `hdm-comp-cancel-bkp-${channel}-`))
    const f = await setupFixture({ priceCents: 10000, rootDir: root })
    try {
      await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 5000, totalBudgetCents: 100000 })
      f.tick(ONE_DAY_MS + 1000)
      await f.reloginAll()
      const orderId = await f.placeAndPay(1, 10000)
      await f.lowerProductPrice(9000)
      runRadar(f.ctx.db, f.getNow())
      const draft = (await f.call('GET', `/buyer/orders/${orderId}/compensation/drafts`)).result[0]
      const receipt = await f.call('POST', '/buyer/compensation/confirm', {
        draftId: draft.draftId, requestKey: randomUUID(), confirmedCents: 1000
      })
      assert.equal(receipt.status, 200)
      if (channel === 'unknown' || channel === 'executed') {
        f.ctx.db.run('UPDATE compensation_receipts SET channel_status=? WHERE receipt_id=?', channel, receipt.result.receiptId)
      } else if (channel === 'failed-before-cancel') {
        f.ctx.db.run("UPDATE compensation_receipts SET channel_status='failed' WHERE receipt_id=?", receipt.result.receiptId)
      }
      const req = await f.call('POST', `/member/order/${orderId}/cancel-requests`, { requestKey: randomUUID() })
      assert.equal(req.status, 200)
      const approve = await f.call('POST', `/merchant/orders/${orderId}/cancel-requests/${req.result.cancelRequestId}/resolve`, {
        requestKey: randomUUID(), decision: 'approve'
      }, f.merchant.token)
      assert.equal(approve.status, 200)
      if (channel === 'failed-after-cancel') {
        f.ctx.db.run("UPDATE compensation_receipts SET channel_status='failed' WHERE receipt_id=?", receipt.result.receiptId)
      }
      const expectedRefund = channel === 'failed-before-cancel' ? 10000 : 9000
      assert.equal(
        f.ctx.db.one<{ amount: number }>("SELECT r.amount FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.order_id=? AND r.reason='cancelled'", orderId)!.amount,
        expectedRefund
      )

      await f.ctx.app.close()
      const options = { databasePath: join(root, 'data', 'mall.sqlite'), uploadsPath: join(root, 'uploads') }
      const backup = await createBackup({ ...options, destination: join(root, 'backup') })
      assert.deepEqual(backup.manifest.issues, [])
      const restored = await restoreBackup({ backupPath: backup.root, destination: join(root, 'restored') })
      assert.deepEqual(restored.report.issues, [])

      // 篡改拦截 1：无视补差把退款改成 5000（低于 F - total）-> 产生 payment-mismatch + cancel-request-mismatch 并阻断默认恢复
      if (channel === 'pending') {
        const tamperedUnderDb = new DatabaseSync(join(root, 'data', 'mall.sqlite'))
        try {
          tamperedUnderDb.exec(`
            CREATE TRIGGER IF NOT EXISTS tmp_allow_upd_refund BEFORE UPDATE ON refunds BEGIN SELECT 1; END;
          `)
        } catch {}
        try {
          // 绕过不可变触发器模拟外部篡改退款金额为非法低值 5000
          tamperedUnderDb.exec('DROP TRIGGER IF EXISTS refunds_identity_update;')
          tamperedUnderDb.prepare("UPDATE refunds SET amount=5000 WHERE reason='cancelled'").run()
        } finally {
          tamperedUnderDb.close()
        }
        const underBkp = await createBackup({ ...options, destination: join(root, 'under-bkp') })
        assert.ok(underBkp.manifest.issues.some(i => i.type === 'cancel-request-mismatch'))
        assert.ok(underBkp.manifest.issues.some(i => i.type === 'payment-mismatch'))
        await assert.rejects(
          restoreBackup({ backupPath: underBkp.root, destination: join(root, 'under-restored') }),
          /不一致/
        )
      }
    } finally {
      try { await f.ctx.app.close() } catch {}
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  }
})

test('check4：未提前扫雷达时先降后退仍按原篮先分K，且同篮未创新低时已退件历史目标不迁给另一SKU；历史缺口停止自动发差', async () => {
  const f = await setupFixture({ priceCents: 10000 })
  try {
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 5000, totalBudgetCents: 100000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()

    // 1) 未先扫雷达：两件10000，K=5000 -> 降至6000（未扫描）-> 退1件 -> 首次 runRadar 仅能给留件 2500
    const orderDelayedScan = await f.placeAndPay(2, 10000)
    f.tick(1000)
    await f.lowerProductPrice(6000)
    await f.call('POST', `/merchant/orders/${orderDelayedScan}/ship`, { carrier: '顺丰', trackingNo: 'SF-DELAY' }, f.merchant.token)
    await f.call('PUT', `/member/order/${orderDelayedScan}/receipt`, {})
    const saleDelay = await f.call('POST', `/member/order/${orderDelayedScan}/after-sales`, {
      requestKey: randomUUID(), kind: 'refund-missing', description: '未提前扫雷达先退1件', items: [{ skuId: f.sku.id, count: 1 }]
    })
    assert.equal(saleDelay.status, 200)
    await f.call('POST', `/merchant/after-sales/${saleDelay.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)
    runRadar(f.ctx.db, f.getNow())
    const delayedDrafts = (await f.call('GET', `/buyer/orders/${orderDelayedScan}/compensation/drafts`)).result
    assert.equal(delayedDrafts.length, 1)
    assert.equal(delayedDrafts[0].cappedCents, 2500)

    // 2) 另一商品 B 混合涨跌：A 10000->8000 (篮18000, 补A 2000) -> 退A(8000) -> A涨回10000且B降至8000 (篮仍18000无新低) -> B不得再获补差
    await f.lowerProductPrice(10000)
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 10000, totalBudgetCents: 100000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()
    const productB = f.ctx.testData.product({
      name: '整篮新低对照商品B',
      category: '箱包',
      description: '验证E_A不迁给B。',
      skus: [{ spec: 'B款', priceCents: 10000, stock: 50 }]
    })
    const skuB = productB.skus[0]!
    const orderMixed = await f.call('POST', '/member/order', {
      requestKey: randomUUID(),
      goods: [{ skuId: f.sku.id, count: 1 }, { skuId: skuB.id, count: 1 }],
      addressId: f.address.id,
      expectedAmountCents: 20000
    })
    assert.equal(orderMixed.status, 200)
    const mixedId = orderMixed.result.id as string
    assert.equal((await f.call('POST', `/member/order/${mixedId}/mock-pay`, { amountCents: 20000 })).status, 200)

    f.tick(1000)
    await f.lowerProductPrice(8000)
    runRadar(f.ctx.db, f.getNow())
    const firstMixed = (await f.call('GET', `/buyer/orders/${mixedId}/compensation/drafts`)).result[0]
    assert.equal(firstMixed.cappedCents, 2000)
    assert.equal((await f.call('POST', '/buyer/compensation/confirm', {
      draftId: firstMixed.draftId, requestKey: randomUUID(), confirmedCents: 2000
    })).status, 200)

    await f.call('POST', `/merchant/orders/${mixedId}/ship`, { carrier: '顺丰', trackingNo: 'SF-MIX' }, f.merchant.token)
    await f.call('PUT', `/member/order/${mixedId}/receipt`, {})
    const saleA = await f.call('POST', `/member/order/${mixedId}/after-sales`, {
      requestKey: randomUUID(), kind: 'refund-missing', description: '退A净退款8000', items: [{ skuId: f.sku.id, count: 1 }]
    })
    await f.call('POST', `/merchant/after-sales/${saleA.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)

    f.tick(1000)
    await f.lowerProductPrice(10000) // A涨回10000
    const bDetail = await f.call('GET', `/merchant/products/${productB.id}`, undefined, f.merchant.token)
    await f.call('PUT', `/merchant/products/${productB.id}`, {
      requestKey: randomUUID(), expectedRevision: bDetail.result.revision, skus: [{ id: skuB.id, priceCents: 8000 }]
    }, f.merchant.token)
    runRadar(f.ctx.db, f.getNow())
    assert.equal((await f.call('GET', `/buyer/orders/${mixedId}/compensation/drafts`)).result.length, 0)

    // 3) 历史证据链存在缺口时（即便存在 price_events），禁止拿当前 SKU 价格拼成历史最低，停止自动发差
    await f.lowerProductPrice(10000)
    f.tick(1000)
    const gapOrder = await f.placeAndPay(1, 10000)
    f.tick(1000)
    f.ctx.db.run('UPDATE skus SET price=6000 WHERE id=?', f.sku.id)
    recordPriceEvent(f.ctx.db, f.merchant.id, f.product.id, f.sku.id, 10000, 6000, 'merchant_edit', null, f.getNow())
    runRadar(f.ctx.db, f.getNow())
    assert.equal((await f.call('GET', `/buyer/orders/${gapOrder}/compensation/drafts`)).result.length, 0)
    const gapPolicy = f.ctx.db.one<{ id: string; version: number; window_days: number; budget_per_order_cents: number; total_budget_cents: number }>(
      'SELECT id,version,window_days,budget_per_order_cents,total_budget_cents FROM price_protection_policies ORDER BY version DESC LIMIT 1'
    )!
    const gapCalc = computeOrderCompensation(f.ctx.db, { id: gapOrder, amount: 10000 }, gapPolicy, f.getNow())
    assert.equal(gapCalc.insufficientHistory, true)
    assert.equal(gapCalc.cappedCents, 0)
  } finally { await f.cleanup() }
})

test('check5与check5-extra：先退后降原篮K先分后滤、退后再创新低均分原篮、同毫秒事务分组及稳定行ID余分归属', async () => {
  const f = await setupFixture({ priceCents: 10000 })
  try {
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 5000, totalBudgetCents: 100000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()

    // 1) P1-A1：2件各10000，K=5000，先退1件，再降6000首扫 -> 原篮各分2500，仅留件可得2500
    const oRetFirst2 = await f.placeAndPay(2, 10000)
    await f.call('POST', `/merchant/orders/${oRetFirst2}/ship`, { carrier: '顺丰', trackingNo: 'SF-C5-1' }, f.merchant.token)
    await f.call('PUT', `/member/order/${oRetFirst2}/receipt`, {})
    const sale2 = await f.call('POST', `/member/order/${oRetFirst2}/after-sales`, {
      requestKey: randomUUID(), kind: 'refund-missing', description: '先退1件再降6000', items: [{ skuId: f.sku.id, count: 1 }]
    })
    await f.call('POST', `/merchant/after-sales/${sale2.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)
    f.tick(1000)
    await f.lowerProductPrice(6000)
    runRadar(f.ctx.db, f.getNow())
    const dRetFirst2 = (await f.call('GET', `/buyer/orders/${oRetFirst2}/compensation/drafts`)).result
    assert.equal(dRetFirst2.length, 1)
    assert.equal(dRetFirst2[0].cappedCents, 2500)

    // 规范对照（3件10000，K=5000，先退1件再降8000）：按方案719-720原篮先分5000(3件=1667,1667,1666)再过滤退件得3333/3334，留件不吞退件K份额
    await f.lowerProductPrice(10000)
    f.tick(1000)
    const oRetFirst3 = await f.placeAndPay(3, 10000)
    await f.call('POST', `/merchant/orders/${oRetFirst3}/ship`, { carrier: '顺丰', trackingNo: 'SF-C5-1B' }, f.merchant.token)
    await f.call('PUT', `/member/order/${oRetFirst3}/receipt`, {})
    const sale3 = await f.call('POST', `/member/order/${oRetFirst3}/after-sales`, {
      requestKey: randomUUID(), kind: 'refund-missing', description: '3件先退1件按原篮K分摊', items: [{ skuId: f.sku.id, count: 1 }]
    })
    await f.call('POST', `/merchant/after-sales/${sale3.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)
    f.tick(1000)
    await f.lowerProductPrice(8000)
    runRadar(f.ctx.db, f.getNow())
    const dRetFirst3 = (await f.call('GET', `/buyer/orders/${oRetFirst3}/compensation/drafts`)).result
    assert.equal(dRetFirst3.length, 1)
    assert.equal(dRetFirst3[0].cappedCents, 3333)

    // 2) P1-A2：2件各10000，K=5000 -> 降9000确认2000(各1000) -> 退1件(实退9000) -> 再降6000：增量3000分原篮各1500，仅留件可得1500
    await f.lowerProductPrice(10000)
    f.tick(1000)
    const oNewLow = await f.placeAndPay(2, 10000)
    f.tick(1000)
    await f.lowerProductPrice(9000)
    runRadar(f.ctx.db, f.getNow())
    const dNewLow1 = (await f.call('GET', `/buyer/orders/${oNewLow}/compensation/drafts`)).result[0]
    assert.equal(dNewLow1.cappedCents, 2000)
    const rNewLow1 = await f.call('POST', '/buyer/compensation/confirm', {
      draftId: dNewLow1.draftId, requestKey: randomUUID(), confirmedCents: 2000
    })
    f.ctx.db.run("UPDATE compensation_receipts SET channel_status='executed' WHERE receipt_id=?", rNewLow1.result.receiptId)
    await f.call('POST', `/merchant/orders/${oNewLow}/ship`, { carrier: '顺丰', trackingNo: 'SF-C5-2' }, f.merchant.token)
    await f.call('PUT', `/member/order/${oNewLow}/receipt`, {})
    const saleNewLow = await f.call('POST', `/member/order/${oNewLow}/after-sales`, {
      requestKey: randomUUID(), kind: 'refund-missing', description: '已补后退1件再创新低', items: [{ skuId: f.sku.id, count: 1 }]
    })
    await f.call('POST', `/merchant/after-sales/${saleNewLow.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)
    assert.equal(f.ctx.db.one<{ amount: number }>('SELECT amount FROM after_sales WHERE id=?', saleNewLow.result.afterSaleId)!.amount, 9000)
    f.tick(1000)
    await f.lowerProductPrice(6000)
    runRadar(f.ctx.db, f.getNow())
    const dNewLow2 = (await f.call('GET', `/buyer/orders/${oNewLow}/compensation/drafts`)).result
    assert.equal(dNewLow2.length, 1)
    assert.equal(dNewLow2[0].cappedCents, 1500)

    // 3) P1-B：同一服务端毫秒分别两次 PUT 先降 8000 再涨 10000，保留中间低价草稿 2000
    await f.lowerProductPrice(10000)
    f.tick(1000)
    const oSameMsRebound = await f.placeAndPay(1, 10000)
    f.tick(1000) // 与下单分开，同毫秒连发两次独立 PUT
    await f.lowerProductPrice(8000)
    await f.lowerProductPrice(10000)
    runRadar(f.ctx.db, f.getNow())
    const dSameMs = (await f.call('GET', `/buyer/orders/${oSameMsRebound}/compensation/drafts`)).result
    assert.equal(dSameMs.length, 1)
    assert.equal(dSameMs[0].cappedCents, 2000)

    // 4) 同毫秒跨 SKU 分组对照（非原子两次 PUT 得 2000 vs 一次原子多 SKU PUT 抵消得 0）+ 整数余分按稳定 SKU ID 升序且跨下单顺序一致
    const dualProd = f.ctx.testData.product({
      name: '原子批量与余分双规格',
      category: '箱包',
      description: '原子事件对照。',
      skus: [{ spec: 'A', priceCents: 10000, stock: 50 }, { spec: 'B', priceCents: 10000, stock: 50 }]
    })
    const sku1 = dualProd.skus[0]!
    const sku2 = dualProd.skus[1]!
    const sortedSkus = [sku1, sku2].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const smallSku = sortedSkus[0]!
    const largeSku = sortedSkus[1]!

    // 同毫秒两次独立 PUT：first A:10000->8000, second B:10000->12000 -> 留存 2000
    const oSep = await f.call('POST', '/member/order', {
      requestKey: randomUUID(), goods: [{ skuId: sku1.id, count: 1 }, { skuId: sku2.id, count: 1 }],
      addressId: f.address.id, expectedAmountCents: 20000
    })
    assert.equal(oSep.status, 200)
    await f.call('POST', `/member/order/${oSep.result.id}/mock-pay`, { amountCents: 20000 })
    const oAtom = await f.call('POST', '/member/order', {
      requestKey: randomUUID(), goods: [{ skuId: sku2.id, count: 1 }, { skuId: sku1.id, count: 1 }],
      addressId: f.address.id, expectedAmountCents: 20000
    })
    assert.equal(oAtom.status, 200)
    await f.call('POST', `/member/order/${oAtom.result.id}/mock-pay`, { amountCents: 20000 })

    f.tick(1000)
    let dd = (await f.call('GET', `/merchant/products/${dualProd.id}`, undefined, f.merchant.token)).result
    await f.call('PUT', `/merchant/products/${dualProd.id}`, {
      requestKey: randomUUID(), expectedRevision: dd.revision, skus: [{ id: sku1.id, priceCents: 8000 }]
    }, f.merchant.token)
    dd = (await f.call('GET', `/merchant/products/${dualProd.id}`, undefined, f.merchant.token)).result
    await f.call('PUT', `/merchant/products/${dualProd.id}`, {
      requestKey: randomUUID(), expectedRevision: dd.revision, skus: [{ id: sku2.id, priceCents: 12000 }]
    }, f.merchant.token)
    runRadar(f.ctx.db, f.getNow())
    assert.equal((await f.call('GET', `/buyer/orders/${oSep.result.id}/compensation/drafts`)).result[0].cappedCents, 2000)

    // 同一毫秒另用单次原子 PUT 同时改两规格（20000 无净降）-> 不得形成历史低
    dd = (await f.call('GET', `/merchant/products/${dualProd.id}`, undefined, f.merchant.token)).result
    await f.call('PUT', `/merchant/products/${dualProd.id}`, {
      requestKey: randomUUID(), expectedRevision: dd.revision, skus: [{ id: sku1.id, priceCents: 10000 }, { id: sku2.id, priceCents: 10000 }]
    }, f.merchant.token)
    f.tick(1000)
    const oBatchOnly = await f.call('POST', '/member/order', {
      requestKey: randomUUID(), goods: [{ skuId: sku1.id, count: 1 }, { skuId: sku2.id, count: 1 }],
      addressId: f.address.id, expectedAmountCents: 20000
    })
    await f.call('POST', `/member/order/${oBatchOnly.result.id}/mock-pay`, { amountCents: 20000 })
    f.tick(1000)
    dd = (await f.call('GET', `/merchant/products/${dualProd.id}`, undefined, f.merchant.token)).result
    await f.call('PUT', `/merchant/products/${dualProd.id}`, {
      requestKey: randomUUID(), expectedRevision: dd.revision, skus: [{ id: sku1.id, priceCents: 8000 }, { id: sku2.id, priceCents: 12000 }]
    }, f.merchant.token)
    runRadar(f.ctx.db, f.getNow())
    assert.equal((await f.call('GET', `/buyer/orders/${oBatchOnly.result.id}/compensation/drafts`)).result.length, 0)

    // 5) P2 余分按稳定升序 SKU ID：还原各10000 -> 发布 K=1 单笔上限政策 -> 升序/降序下单 -> 各降1分至9999 -> 余分均落 smallSku 且退货扣减守恒
    dd = (await f.call('GET', `/merchant/products/${dualProd.id}`, undefined, f.merchant.token)).result
    await f.call('PUT', `/merchant/products/${dualProd.id}`, {
      requestKey: randomUUID(), expectedRevision: dd.revision, skus: [{ id: sku1.id, priceCents: 10000 }, { id: sku2.id, priceCents: 10000 }]
    }, f.merchant.token)
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 1, totalBudgetCents: 100000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()

    const oAsc = await f.call('POST', '/member/order', {
      requestKey: randomUUID(), goods: [{ skuId: smallSku.id, count: 1 }, { skuId: largeSku.id, count: 1 }],
      addressId: f.address.id, expectedAmountCents: 20000
    })
    await f.call('POST', `/member/order/${oAsc.result.id}/mock-pay`, { amountCents: 20000 })
    const oDesc = await f.call('POST', '/member/order', {
      requestKey: randomUUID(), goods: [{ skuId: largeSku.id, count: 1 }, { skuId: smallSku.id, count: 1 }],
      addressId: f.address.id, expectedAmountCents: 20000
    })
    await f.call('POST', `/member/order/${oDesc.result.id}/mock-pay`, { amountCents: 20000 })

    f.tick(1000)
    dd = (await f.call('GET', `/merchant/products/${dualProd.id}`, undefined, f.merchant.token)).result
    await f.call('PUT', `/merchant/products/${dualProd.id}`, {
      requestKey: randomUUID(), expectedRevision: dd.revision, skus: [{ id: smallSku.id, priceCents: 9999 }, { id: largeSku.id, priceCents: 9999 }]
    }, f.merchant.token)
    runRadar(f.ctx.db, f.getNow())

    for (const oid of [oAsc.result.id as string, oDesc.result.id as string]) {
      const dr = (await f.call('GET', `/buyer/orders/${oid}/compensation/drafts`)).result
      assert.equal(dr.length, 1)
      assert.deepEqual(dr[0].perLine, [{ order_line_id: smallSku.id, delta_cents: 1 }])
      assert.equal((await f.call('POST', '/buyer/compensation/confirm', {
        draftId: dr[0].draftId, requestKey: randomUUID(), confirmedCents: 1
      })).status, 200)
      await f.call('POST', `/merchant/orders/${oid}/ship`, { carrier: '顺丰', trackingNo: 'SF-REM' }, f.merchant.token)
      await f.call('PUT', `/member/order/${oid}/receipt`, {})
      // 退 smallSku 扣除分得的 1 分 -> 9999；再退 largeSku -> 全额 10000（总计 1 + 9999 + 10000 = 20000）
      const sSmall = await f.call('POST', `/member/order/${oid}/after-sales`, {
        requestKey: randomUUID(), kind: 'refund-missing', description: '退得余分的较小SKU', items: [{ skuId: smallSku.id, count: 1 }]
      })
      assert.equal(f.ctx.db.one<{ amount: number }>('SELECT amount FROM after_sales WHERE id=?', sSmall.result.afterSaleId)!.amount, 9999)
      await f.call('POST', `/merchant/after-sales/${sSmall.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)
      const sLarge = await f.call('POST', `/member/order/${oid}/after-sales`, {
        requestKey: randomUUID(), kind: 'refund-missing', description: '退未得余分的较大SKU', items: [{ skuId: largeSku.id, count: 1 }]
      })
      assert.equal(f.ctx.db.one<{ amount: number }>('SELECT amount FROM after_sales WHERE id=?', sLarge.result.afterSaleId)!.amount, 10000)
      await f.call('POST', `/merchant/after-sales/${sLarge.result.afterSaleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)
    }
  } finally { await f.cleanup() }
})

test('check6: 事务身份按来源/操作人/商品作用域划分（跨路由或跨商家复用 requestKey 不合并，同请求多 SKU 仍原子）', async () => {
  const f = await setupFixture()
  try {
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 5000, totalBudgetCents: 100000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()

    // 1) 同毫秒跨路由（promotion.edit 与 products/:id）复用同一 UUID requestKey -> 两笔独立事务，保留 2000 低价
    const oRoute = await f.call('POST', '/member/order', {
      requestKey: randomUUID(),
      goods: [{ skuId: f.sku.id, count: 1 }],
      addressId: f.address.id,
      expectedAmountCents: 10000
    })
    assert.equal(oRoute.status, 200)
    await f.call('POST', `/member/order/${oRoute.result.id}/mock-pay`, { amountCents: 10000 })

    f.tick(1000)
    const sharedKey = randomUUID()
    const promoRes = await f.call('GET', '/merchant/settings/promotion', undefined, f.merchant.token)
    assert.equal(promoRes.status, 200)
    const promoPut = await f.call('PUT', '/merchant/settings/promotion', {
      requestKey: sharedKey,
      expectedRevision: promoRes.result.revision,
      thresholdCents: 10000,
      discountCents: 2000,
      enabled: true
    }, f.merchant.token)
    assert.equal(promoPut.status, 200)

    const prodGet = await f.call('GET', `/merchant/products/${f.product.id}`, undefined, f.merchant.token)
    assert.equal(prodGet.status, 200)
    const prodPut = await f.call('PUT', `/merchant/products/${f.product.id}`, {
      requestKey: sharedKey,
      expectedRevision: prodGet.result.revision,
      skus: [{ id: f.sku.id, priceCents: 12000 }]
    }, f.merchant.token)
    assert.equal(prodPut.status, 200)

    runRadar(f.ctx.db, f.getNow())
    const routeDrafts = (await f.call('GET', `/buyer/orders/${oRoute.result.id}/compensation/drafts`)).result
    assert.deepEqual(routeDrafts.map((d: { cappedCents: number }) => d.cappedCents), [2000])

    // 关闭满减并准备跨商家复用同一 requestKey 测试
    const promoNow = await f.call('GET', '/merchant/settings/promotion', undefined, f.merchant.token)
    assert.equal((await f.call('PUT', '/merchant/settings/promotion', {
      requestKey: randomUUID(),
      expectedRevision: promoNow.result.revision,
      thresholdCents: 10000,
      discountCents: 2000,
      enabled: false
    }, f.merchant.token)).status, 200)

    // 2) 同毫秒跨商家（seller1 与 seller2）编辑同一多规格商品的不同 SKU 并复用同一 requestKey -> 独立事务保留 2000
    //    而由单一商家在同一次 PUT 同时改两规格（总价持平 20000）仍合并为一帧无草稿
    const merchant2 = f.ctx.testData.account({ account: 'seller2', password: 'test-password-123', role: 'merchant' })
    const multiProd = f.ctx.testData.product({
      name: '跨商家作用域商品',
      category: '箱包',
      description: 'check6 验证',
      skus: [{ spec: 'S1', priceCents: 10000, stock: 20 }, { spec: 'S2', priceCents: 10000, stock: 20 }]
    })
    const sku1 = multiProd.skus[0]!
    const sku2 = multiProd.skus[1]!

    const oCrossActor = await f.call('POST', '/member/order', {
      requestKey: randomUUID(),
      goods: [{ skuId: sku1.id, count: 1 }, { skuId: sku2.id, count: 1 }],
      addressId: f.address.id,
      expectedAmountCents: 20000
    })
    assert.equal(oCrossActor.status, 200)
    await f.call('POST', `/member/order/${oCrossActor.result.id}/mock-pay`, { amountCents: 20000 })

    f.tick(1000)
    const sharedActorKey = randomUUID()
    let mp = (await f.call('GET', `/merchant/products/${multiProd.id}`, undefined, f.merchant.token)).result
    assert.equal((await f.call('PUT', `/merchant/products/${multiProd.id}`, {
      requestKey: sharedActorKey,
      expectedRevision: mp.revision,
      skus: [{ id: sku1.id, priceCents: 8000 }]
    }, f.merchant.token)).status, 200)

    mp = (await f.call('GET', `/merchant/products/${multiProd.id}`, undefined, merchant2.token)).result
    assert.equal((await f.call('PUT', `/merchant/products/${multiProd.id}`, {
      requestKey: sharedActorKey,
      expectedRevision: mp.revision,
      skus: [{ id: sku2.id, priceCents: 12000 }]
    }, merchant2.token)).status, 200)

    runRadar(f.ctx.db, f.getNow())
    const actorDrafts = (await f.call('GET', `/buyer/orders/${oCrossActor.result.id}/compensation/drafts`)).result
    assert.deepEqual(actorDrafts.map((d: { cappedCents: number }) => d.cappedCents), [2000])

    // 还原并验证单一商家同次批量改多规格仍为原子一帧（不误拆）
    mp = (await f.call('GET', `/merchant/products/${multiProd.id}`, undefined, f.merchant.token)).result
    assert.equal((await f.call('PUT', `/merchant/products/${multiProd.id}`, {
      requestKey: randomUUID(),
      expectedRevision: mp.revision,
      skus: [{ id: sku1.id, priceCents: 10000 }, { id: sku2.id, priceCents: 10000 }]
    }, f.merchant.token)).status, 200)
    f.tick(1000)

    const oAtomicSame = await f.call('POST', '/member/order', {
      requestKey: randomUUID(),
      goods: [{ skuId: sku1.id, count: 1 }, { skuId: sku2.id, count: 1 }],
      addressId: f.address.id,
      expectedAmountCents: 20000
    })
    assert.equal(oAtomicSame.status, 200)
    await f.call('POST', `/member/order/${oAtomicSame.result.id}/mock-pay`, { amountCents: 20000 })

    f.tick(1000)
    mp = (await f.call('GET', `/merchant/products/${multiProd.id}`, undefined, f.merchant.token)).result
    assert.equal((await f.call('PUT', `/merchant/products/${multiProd.id}`, {
      requestKey: randomUUID(),
      expectedRevision: mp.revision,
      skus: [{ id: sku1.id, priceCents: 8000 }, { id: sku2.id, priceCents: 12000 }]
    }, f.merchant.token)).status, 200)

    runRadar(f.ctx.db, f.getNow())
    const atomicDrafts = (await f.call('GET', `/buyer/orders/${oAtomicSame.result.id}/compensation/drafts`)).result
    assert.equal(atomicDrafts.length, 0)
  } finally { await f.cleanup() }
})

test('check6-extra: 同毫秒下单/付款因果锚点前后对照、付款前低价不补、缺锚点停发，及新单详情 protectionBrief 非寿命截断', async () => {
  const f = await setupFixture()
  try {
    await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 5000, totalBudgetCents: 100000 })
    f.tick(ONE_DAY_MS + 1000)
    await f.reloginAll()

    const mkProd = (name: string) => f.ctx.testData.product({
      name, category: '箱包', description: 'check6-extra',
      skus: [{ spec: '标准', priceCents: 10000, stock: 20 }]
    })
    const pBefore = mkProd('同ms先降后下单')
    const pAfter = mkProd('同ms先付款后降再涨')
    const pMid = mkProd('同ms下单后付款前降再涨')

    // 1) 对照：在下单同毫秒于下单/付款之前完成 10000->8000->10000，再下单付款 -> 无草稿
    let pb = (await f.call('GET', `/merchant/products/${pBefore.id}`, undefined, f.merchant.token)).result
    assert.equal((await f.call('PUT', `/merchant/products/${pBefore.id}`, {
      requestKey: randomUUID(), expectedRevision: pb.revision, skus: [{ id: pBefore.skus[0]!.id, priceCents: 8000 }]
    }, f.merchant.token)).status, 200)
    pb = (await f.call('GET', `/merchant/products/${pBefore.id}`, undefined, f.merchant.token)).result
    assert.equal((await f.call('PUT', `/merchant/products/${pBefore.id}`, {
      requestKey: randomUUID(), expectedRevision: pb.revision, skus: [{ id: pBefore.skus[0]!.id, priceCents: 10000 }]
    }, f.merchant.token)).status, 200)
    const oBefore = await f.call('POST', '/member/order', {
      requestKey: randomUUID(), goods: [{ skuId: pBefore.skus[0]!.id, count: 1 }], addressId: f.address.id, expectedAmountCents: 10000
    })
    assert.equal(oBefore.status, 200)
    assert.equal((await f.call('POST', `/member/order/${oBefore.result.id}/mock-pay`, { amountCents: 10000 })).status, 200)

    // 2) 同毫秒先创建+付款，再同毫秒 10000->8000->10000 -> 保留 2000
    const oAfter = await f.call('POST', '/member/order', {
      requestKey: randomUUID(), goods: [{ skuId: pAfter.skus[0]!.id, count: 1 }], addressId: f.address.id, expectedAmountCents: 10000
    })
    assert.equal(oAfter.status, 200)
    assert.equal((await f.call('POST', `/member/order/${oAfter.result.id}/mock-pay`, { amountCents: 10000 })).status, 200)
    let pa = (await f.call('GET', `/merchant/products/${pAfter.id}`, undefined, f.merchant.token)).result
    assert.equal((await f.call('PUT', `/merchant/products/${pAfter.id}`, {
      requestKey: randomUUID(), expectedRevision: pa.revision, skus: [{ id: pAfter.skus[0]!.id, priceCents: 8000 }]
    }, f.merchant.token)).status, 200)
    pa = (await f.call('GET', `/merchant/products/${pAfter.id}`, undefined, f.merchant.token)).result
    assert.equal((await f.call('PUT', `/merchant/products/${pAfter.id}`, {
      requestKey: randomUUID(), expectedRevision: pa.revision, skus: [{ id: pAfter.skus[0]!.id, priceCents: 10000 }]
    }, f.merchant.token)).status, 200)

    // 3) 同毫秒创建后、付款前经历 10000->8000->10000，然后再 mock-pay -> 无草稿
    const oMid = await f.call('POST', '/member/order', {
      requestKey: randomUUID(), goods: [{ skuId: pMid.skus[0]!.id, count: 1 }], addressId: f.address.id, expectedAmountCents: 10000
    })
    assert.equal(oMid.status, 200)
    let pm = (await f.call('GET', `/merchant/products/${pMid.id}`, undefined, f.merchant.token)).result
    assert.equal((await f.call('PUT', `/merchant/products/${pMid.id}`, {
      requestKey: randomUUID(), expectedRevision: pm.revision, skus: [{ id: pMid.skus[0]!.id, priceCents: 8000 }]
    }, f.merchant.token)).status, 200)
    pm = (await f.call('GET', `/merchant/products/${pMid.id}`, undefined, f.merchant.token)).result
    assert.equal((await f.call('PUT', `/merchant/products/${pMid.id}`, {
      requestKey: randomUUID(), expectedRevision: pm.revision, skus: [{ id: pMid.skus[0]!.id, priceCents: 10000 }]
    }, f.merchant.token)).status, 200)
    assert.equal((await f.call('POST', `/member/order/${oMid.result.id}/mock-pay`, { amountCents: 10000 })).status, 200)

    runRadar(f.ctx.db, f.getNow())
    assert.equal((await f.call('GET', `/buyer/orders/${oBefore.result.id}/compensation/drafts`)).result.length, 0)
    assert.equal((await f.call('GET', `/buyer/orders/${oMid.result.id}/compensation/drafts`)).result.length, 0)
    const afterDrafts = (await f.call('GET', `/buyer/orders/${oAfter.result.id}/compensation/drafts`)).result
    assert.deepEqual(afterDrafts.map((d: { cappedCents: number }) => d.cappedCents), [2000])

    // 4) 若既有订单缺乏因果锚点且同毫秒有调价审计，computeOrderCompensation 明确报错/标记历史缺口而非猜数
    f.ctx.db.run('DELETE FROM order_audit_anchors WHERE order_id=?', oAfter.result.id)
    const gapComp = computeOrderCompensation(
      f.ctx.db,
      { id: oAfter.result.id, amount: 10000 },
      { id: afterDrafts[0].policyId, version: 1, window_days: 7, budget_per_order_cents: 5000, total_budget_cents: 100000 },
      f.getNow()
    )
    assert.equal(gapComp.insufficientHistory, true)
    assert.equal(gapComp.cappedCents, 0)

    // 5) 政策 window_days = 7 推进 8 天后新建并支付新订单，GET /member/order/:id 的 protectionBrief 仍正常返回
    f.tick(8 * ONE_DAY_MS)
    await f.reloginAll()
    const oLate = await f.call('POST', '/member/order', {
      requestKey: randomUUID(), goods: [{ skuId: f.sku.id, count: 1 }], addressId: f.address.id, expectedAmountCents: 10000
    })
    assert.equal(oLate.status, 200)
    assert.equal((await f.call('POST', `/member/order/${oLate.result.id}/mock-pay`, { amountCents: 10000 })).status, 200)
    const detail = await f.call('GET', `/member/order/${oLate.result.id}`)
    assert.equal(detail.status, 200)
    assert.ok(detail.result.protectionBrief !== null && typeof detail.result.protectionBrief === 'object')
    assert.equal(detail.result.protectionBrief.windowDays, 7)
  } finally { await f.cleanup() }
})

test('check6-schema: 已存在无锚点 v30 文件级兼容迁移、不伪造旧因果位置，且备份与恢复保留/校验 order_audit_anchors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hdm-v30-compat-'))
  try {
    const f = await setupFixture({ rootDir: root })
    let reopened: Database | undefined
    try {
      await f.publishPolicy({ windowDays: 7, budgetPerOrderCents: 5000, totalBudgetCents: 100000 })
      f.tick(ONE_DAY_MS + 1000)
      await f.reloginAll()

      // 一笔异毫秒降价订单 + 一笔同毫秒调价订单（模拟 check5 无锚点 v30 历史数据）
      const oDistinct = await f.placeAndPay(1)
      const pSameProd = f.ctx.testData.product({
        name: '旧v30同ms商品', category: '箱包', description: 'v30 compat',
        skus: [{ spec: '标准', priceCents: 10000, stock: 20 }]
      })
      const oSameMs = await f.call('POST', '/member/order', {
        requestKey: randomUUID(), goods: [{ skuId: pSameProd.skus[0]!.id, count: 1 }], addressId: f.address.id, expectedAmountCents: 10000
      })
      assert.equal(oSameMs.status, 200)
      assert.equal((await f.call('POST', `/member/order/${oSameMs.result.id}/mock-pay`, { amountCents: 10000 })).status, 200)
      let pSameDetail = (await f.call('GET', `/merchant/products/${pSameProd.id}`, undefined, f.merchant.token)).result
      assert.equal((await f.call('PUT', `/merchant/products/${pSameProd.id}`, {
        requestKey: randomUUID(), expectedRevision: pSameDetail.revision, skus: [{ id: pSameProd.skus[0]!.id, priceCents: 8000 }]
      }, f.merchant.token)).status, 200)

      f.tick(1000)
      await f.lowerProductPrice(9000)
      const nowBeforeClose = f.getNow()
      await f.ctx.app.close()

      // 将磁盘 DB 还原为无 order_audit_anchors 的历史 user_version=30 结构并快照导出（置于独立目录避免 backup 目标嵌套）
      const dbPath = join(root, 'data', 'mall.sqlite')
      const sourceDir = join(root, 'source')
      const preAnchorPath = join(sourceDir, 'pre-anchor-v30.sqlite')
      await import('node:fs/promises').then(m => m.mkdir(sourceDir, { recursive: true }))
      const rawPre = new DatabaseSync(dbPath)
      try {
        rawPre.exec(`
          DROP TRIGGER IF EXISTS orders_anchor_insert;
          DROP TRIGGER IF EXISTS orders_anchor_paid;
          DROP TABLE IF EXISTS order_audit_anchors;
          PRAGMA user_version = 30;
          VACUUM INTO '${preAnchorPath.replace(/\\/g, '/')}';
        `)
      } finally { rawPre.close() }

      // 无锚点旧 v30 备份验证与恢复不应因缺表崩溃
      const preBackupDir = join(root, 'backup-pre')
      const preBackup = await createBackup({ databasePath: preAnchorPath, uploadsPath: join(root, 'uploads'), destination: preBackupDir })
      assert.equal(preBackup.manifest.issues.length, 0)
      assert.equal(preBackup.counts.order_audit_anchors, undefined)

      // 用当前 Database 重新打开旧 v30 库：补建表与触发器但不伪造旧单锚点
      reopened = new Database(preAnchorPath, { now: () => nowBeforeClose })
      assert.equal(reopened.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 30)
      assert.equal(reopened.one<{ amount: number }>('SELECT amount FROM orders WHERE id=?', oDistinct)!.amount, 10000)
      assert.equal(reopened.one('SELECT * FROM order_audit_anchors WHERE order_id=?', oDistinct), undefined)
      assert.equal(reopened.one('SELECT * FROM order_audit_anchors WHERE order_id=?', oSameMs.result.id), undefined)

      // runRadar 正常执行：异毫秒旧单正常得出 1000，同毫秒缺锚点旧单不猜数停发
      runRadar(reopened, nowBeforeClose)
      assert.deepEqual(
        reopened.all<{ capped_cents: number }>("SELECT capped_cents FROM compensation_drafts WHERE order_id=? AND status='pending'", oDistinct).map(d => d.capped_cents),
        [1000]
      )
      assert.equal(
        reopened.all("SELECT id FROM compensation_drafts WHERE order_id=? AND status='pending'", oSameMs.result.id).length,
        0
      )

      // 重开后的新订单通过真实下单/付款接口自动写入真实因果锚点，且备份/恢复保留该表与计数并拒绝伪造锚点
      reopened.close()
      reopened = undefined
      const reopenedApp = await buildTestApp({
        databasePath: preAnchorPath,
        uploadsPath: join(root, 'uploads'),
        publicUrl: 'http://localhost',
        mockPayments: true,
        clock: { now: () => nowBeforeClose }
      })
      let newOid: string
      try {
        const loginB = await reopenedApp.app.inject({ method: 'POST', url: '/login', payload: { account: 'buyer1', password: 'test-password-123' } })
        const bTok = loginB.json().result.token as string
        const orderRes = await reopenedApp.app.inject({
          method: 'POST', url: '/member/order', headers: identityHeaders(reopenedApp.accounts, bTok),
          payload: { requestKey: randomUUID(), goods: [{ skuId: f.sku.id, count: 1 }], addressId: f.address.id, expectedAmountCents: 9000 }
        })
        assert.equal(orderRes.statusCode, 200)
        newOid = orderRes.json().result.id as string
        const payRes = await reopenedApp.app.inject({
          method: 'POST', url: `/member/order/${newOid}/mock-pay`, headers: identityHeaders(reopenedApp.accounts, bTok),
          payload: { amountCents: 9000 }
        })
        assert.equal(payRes.statusCode, 200)
        const anchor = reopenedApp.db.one<{ created_audit_seq: number; paid_audit_seq: number }>(
          'SELECT created_audit_seq, paid_audit_seq FROM order_audit_anchors WHERE order_id=?', newOid
        )
        assert.ok(anchor && anchor.created_audit_seq >= 0 && anchor.paid_audit_seq === anchor.created_audit_seq)
      } finally {
        await reopenedApp.app.close()
      }

      const anchoredBackup = await createBackup({ databasePath: preAnchorPath, uploadsPath: join(root, 'uploads'), destination: join(root, 'backup-anchored') })
      assert.equal(anchoredBackup.manifest.issues.length, 0)
      assert.equal(anchoredBackup.counts.order_audit_anchors, 1)
      const restored = await restoreBackup({ backupPath: join(root, 'backup-anchored'), destination: join(root, 'restored-anchored') })
      assert.equal(restored.report.counts.order_audit_anchors, 1)

      // 篡改锚点超过当前 audit_log 最大自增序 -> verifyBackup / inspectDatabase 明确拒绝
      const tamperedDb = new DatabaseSync(join(root, 'backup-anchored', 'mall.sqlite'))
      try {
        tamperedDb.prepare('UPDATE order_audit_anchors SET paid_audit_seq=999999999 WHERE order_id=?').run(newOid)
      } finally { tamperedDb.close() }
      await assert.rejects(() => verifyBackup(join(root, 'backup-anchored')), /订单因果锚点记录无效|校验|篡改|hash/i)
    } finally {
      reopened?.close()
      await f.cleanup().catch(() => {})
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
