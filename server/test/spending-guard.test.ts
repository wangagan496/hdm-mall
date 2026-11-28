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
import { backfillSpendingReservations, spendingSummary } from '../src/spending-guard.ts'
import { createBackup, restoreBackup, verifyBackup } from '../src/backup.ts'
import type { PaymentChannel } from '../src/payment-channel.ts'
import { spendingGuardVectors } from '../../contract-kit/v1/vectors/spending-guard.ts'
import {
  parseSpendingPauseDetail,
  parseSpendingRule,
  parseSpendingRuleInput,
  parseSpendingSummary,
  parseWishlistConfirmInput,
  parseWishlistItem
} from '../src/spending-guard/generated.ts'

const PASSWORD = 'test-password-123'
const HOUR_MS = 3_600_000

async function setupFixture(opts?: { rootDir?: string; paymentChannel?: PaymentChannel; initialNow?: number }) {
  let now = opts?.initialNow ?? Date.UTC(2026, 10, 15, 4, 0, 0) // 北京时间 2026-11-15 12:00:00
  const root = opts?.rootDir ?? mkdtempSync(join(tmpdir(), 'hdm-spend-test-'))
  const ctx = await buildTestApp({
    databasePath: opts?.rootDir ? join(root, 'data', 'mall.sqlite') : ':memory:',
    uploadsPath: opts?.rootDir ? join(root, 'uploads') : './unused',
    publicUrl: 'http://127.0.0.1:3000',
    mockPayments: true,
    clock: { now: () => now },
    ...(opts?.paymentChannel ? { paymentChannel: opts.paymentChannel } : {})
  })

  const buyer = ctx.testData.account({ account: `buyer_${randomUUID().slice(0, 6)}`, password: PASSWORD })
  const buyer2 = ctx.testData.account({ account: `buyer2_${randomUUID().slice(0, 6)}`, password: PASSWORD })
  const merchant = ctx.testData.account({ account: `seller_${randomUUID().slice(0, 6)}`, password: PASSWORD, role: 'merchant' })
  const address = ctx.testData.address({ userId: buyer.id, receiver: '林青', contact: '13800001111', address: '上海市徐汇区漕河泾路1号' })
  const address2 = ctx.testData.address({ userId: buyer2.id, receiver: '陈然', contact: '13800002222', address: '广州市天河区体育西路2号' })
  const productA = ctx.testData.product({
    name: '理性消费测试包',
    category: '箱包',
    description: '正品头层牛皮。',
    skus: [
      { spec: '中号', priceCents: 6000, stock: 20 },
      { spec: '大号', priceCents: 12000, stock: 20 }
    ]
  })
  const productB = ctx.testData.product({
    name: '日常百货杯',
    category: '居家',
    description: '耐高温玻璃杯。',
    skus: [{ spec: '350ml', priceCents: 3000, stock: 30 }]
  })

  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token = '', payload?: object) => {
    const res = await ctx.app.inject({
      method,
      url,
      headers: token ? identityHeaders(ctx.accounts, token) : {},
      payload
    })
    let body: Record<string, unknown>
    try {
      body = res.json()
    } catch {
      body = {}
    }
    return { status: res.statusCode, body }
  }

  return {
    root,
    ctx,
    buyer,
    buyer2,
    merchant,
    address,
    address2,
    skuMedium: productA.skus[0]!,
    skuLarge: productA.skus[1]!,
    skuSmall: productB.skus[0]!,
    getNow: () => now,
    setNow: (next: number) => { now = next },
    tick: (ms: number) => { now += ms },
    call,
    close: async () => {
      await ctx.app.close()
      if (!opts?.rootDir) rmSync(root, { recursive: true, force: true })
    }
  }
}

test('SG01 契约向量由生成解析器严格校验通过并拒绝非法样本', () => {
  const parsers: Record<string, (text: string) => unknown> = {
    SpendingRule: parseSpendingRule,
    SpendingRuleInput: parseSpendingRuleInput,
    SpendingSummary: parseSpendingSummary,
    SpendingPauseDetail: parseSpendingPauseDetail,
    WishlistItem: parseWishlistItem,
    WishlistConfirmInput: parseWishlistConfirmInput
  }
  for (const vector of spendingGuardVectors) {
    const parser = parsers[vector.kind]
    assert.ok(parser, `missing parser for ${vector.kind}`)
    const parsed = parser(JSON.stringify(vector.value))
    if (vector.valid) assert.ok(parsed, `expected valid vector ${vector.name}`)
    else assert.equal(parsed, null, `expected invalid vector ${vector.name} to fail`)
  }
})

test('SG02 默认停用可正常下单；规则参数校验、乐观锁冲突、同号幂等与审计日志完整成立', async () => {
  const f = await setupFixture()
  try {
    // 默认未开启规则（version=0, enabled=false）时可直接下单
    const initialRules = await f.call('GET', '/member/spending/rules', f.buyer.token)
    assert.equal(initialRules.status, 200)
    assert.equal((initialRules.body.result as { current: { version: number; enabled: boolean } }).current.version, 0)
    assert.equal((initialRules.body.result as { current: { enabled: boolean } }).current.enabled, false)

    const passOrder = await f.call('POST', '/member/order', f.buyer.token, {
      source: 'buy-now',
      requestKey: randomUUID(),
      expectedAmountCents: f.skuMedium.priceCents,
      addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }]
    })
    assert.equal(passOrder.status, 200)
    assert.ok((passOrder.body.result as { id: string }).id)

    // 开启时未勾选说明拒绝
    const noDisclosure = await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      requestKey: randomUUID(),
      expectedVersion: 0,
      monthlyBudgetCents: 20000,
      perOrderLimitCents: null,
      cooldownThresholdCents: null,
      cooldownHours: null,
      enabled: true,
      disclosureAccepted: false
    })
    assert.equal(noDisclosure.status, 400)

    // 开启时三项全空拒绝
    const allEmpty = await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      requestKey: randomUUID(),
      expectedVersion: 0,
      monthlyBudgetCents: null,
      perOrderLimitCents: null,
      cooldownThresholdCents: null,
      cooldownHours: null,
      enabled: true,
      disclosureAccepted: true
    })
    assert.equal(allEmpty.status, 400)

    // 冷静阈值未配成对小时或超过 72h 拒绝
    const badPair = await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      requestKey: randomUUID(),
      expectedVersion: 0,
      monthlyBudgetCents: null,
      perOrderLimitCents: null,
      cooldownThresholdCents: 5000,
      cooldownHours: null,
      enabled: true,
      disclosureAccepted: true
    })
    assert.equal(badPair.status, 400)

    const over72h = await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      requestKey: randomUUID(),
      expectedVersion: 0,
      monthlyBudgetCents: null,
      perOrderLimitCents: null,
      cooldownThresholdCents: 5000,
      cooldownHours: 73,
      enabled: true,
      disclosureAccepted: true
    })
    assert.equal(over72h.status, 400)

    // 正常保存 v1，同一 requestKey 幂等重放，改参拒绝，旧版本冲突 409 SPENDING_RULE_VERSION_CHANGED
    const reqKey = randomUUID()
    const payloadV1 = {
      requestKey: reqKey,
      expectedVersion: 0,
      monthlyBudgetCents: 30000,
      perOrderLimitCents: 12000,
      cooldownThresholdCents: 10000,
      cooldownHours: 24,
      enabled: true,
      disclosureAccepted: true
    }
    const saved = await f.call('PUT', '/member/spending/rules', f.buyer.token, payloadV1)
    assert.equal(saved.status, 200)
    assert.equal((saved.body.result as { version: number }).version, 1)

    const replay = await f.call('PUT', '/member/spending/rules', f.buyer.token, payloadV1)
    assert.equal(replay.status, 200)
    assert.equal((replay.body.result as { id: string }).id, (saved.body.result as { id: string }).id)

    const changedSameKey = await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      ...payloadV1,
      monthlyBudgetCents: 40000
    })
    assert.equal(changedSameKey.status, 409)

    const staleVersion = await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      ...payloadV1,
      requestKey: randomUUID(),
      expectedVersion: 0
    })
    assert.equal(staleVersion.status, 409)
    assert.equal(staleVersion.body.reason, 'SPENDING_RULE_VERSION_CHANGED')

    // 审计日志只记一条 v1 变更
    const audits = f.ctx.db.all<{ action: string; summary: string }>("SELECT action,summary FROM audit_log WHERE action='spending.rule'")
    assert.equal(audits.length, 1)
    assert.match(audits[0]!.summary, /v1/)
  } finally {
    await f.close()
  }
})

test('SG03 单笔限额优先级高于月度预算，恰好等于可过，超1分返回409且不扣库存不删购物车', async () => {
  const f = await setupFixture()
  try {
    // 加入购物车用于验证拦截时不删购物车
    const addCart = await f.call('POST', '/member/cart', f.buyer.token, { skuId: f.skuSmall.id, count: 1, requestKey: randomUUID() })
    assert.equal(addCart.status, 200)
    const beforeStock = f.ctx.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', f.skuSmall.id)!.stock

    // 设单笔限额 5999 分、月度预算 1000 分（6000 分同时超两者，验证优先触发 per_order），先只设 2999 测边界
    await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      requestKey: randomUUID(),
      expectedVersion: 0,
      monthlyBudgetCents: 2000,
      perOrderLimitCents: 2999,
      cooldownThresholdCents: null,
      cooldownHours: null,
      enabled: true,
      disclosureAccepted: true
    })

    const paused = await f.call('POST', '/member/order', f.buyer.token, {
      source: 'cart',
      requestKey: randomUUID(),
      expectedAmountCents: f.skuSmall.priceCents, // 3000 = 2999 + 1
      addressId: f.address.id,
      goods: [{ skuId: f.skuSmall.id, count: 1 }]
    })
    assert.equal(paused.status, 409)
    assert.equal(paused.body.reason, 'SPENDING_PAUSED')
    const pauseResult = paused.body.result as { limitType: string; amountCents: number; limitCents: number; ruleVersion: number }
    assert.equal(pauseResult.limitType, 'per_order')
    assert.equal(pauseResult.amountCents, 3000)
    assert.equal(pauseResult.limitCents, 2999)
    assert.equal(pauseResult.ruleVersion, 1)

    // 库存未动、订单未生成、购物车仍在
    assert.equal(f.ctx.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', f.skuSmall.id)!.stock, beforeStock)
    assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM orders WHERE owner_id=?', f.buyer.id)!.n, 0)
    assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM carts WHERE user_id=?', f.buyer.id)!.n, 1)

    // 调高单笔限额为恰好等于 3000 分（同时放宽月预算），应当通过
    await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      requestKey: randomUUID(),
      expectedVersion: 1,
      monthlyBudgetCents: 3000,
      perOrderLimitCents: 3000,
      cooldownThresholdCents: null,
      cooldownHours: null,
      enabled: true,
      disclosureAccepted: true
    })

    const exactPass = await f.call('POST', '/member/order', f.buyer.token, {
      source: 'cart',
      requestKey: randomUUID(),
      expectedAmountCents: f.skuSmall.priceCents,
      addressId: f.address.id,
      goods: [{ skuId: f.skuSmall.id, count: 1 }]
    })
    assert.equal(exactPass.status, 200)
    const orderId = (exactPass.body.result as { id: string }).id
    assert.ok(orderId)

    // 订单详情携带只读 spending 摘要，待付阶段占入 reservedCents
    const detail = await f.call('GET', `/member/order/${orderId}`, f.buyer.token)
    assert.equal(detail.status, 200)
    const detailSpending = (detail.body.result as { spending: { ruleVersion: number; spentCents: number; remainingBudgetCents: number } }).spending
    assert.equal(detailSpending.ruleVersion, 2)
    assert.equal(detailSpending.spentCents, 0)
    assert.equal(detailSpending.remainingBudgetCents, 0)
  } finally {
    await f.close()
  }
})

test('SG04 月度预算含在途占额与并发拆单，同一时间仅允许总和不超限', async () => {
  const f = await setupFixture()
  try {
    // 设月度预算 8000 分，单笔不限制
    await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      requestKey: randomUUID(),
      expectedVersion: 0,
      monthlyBudgetCents: 8000,
      perOrderLimitCents: null,
      cooldownThresholdCents: null,
      cooldownHours: null,
      enabled: true,
      disclosureAccepted: true
    })

    // 并发发起两笔各 6000 分 buy-now 订单：6000 + 6000 = 12000 > 8000，仅能成功一笔
    const [r1, r2] = await Promise.all([
      f.call('POST', '/member/order', f.buyer.token, {
        source: 'buy-now',
        requestKey: randomUUID(),
        expectedAmountCents: f.skuMedium.priceCents,
        addressId: f.address.id,
        goods: [{ skuId: f.skuMedium.id, count: 1 }]
      }),
      f.call('POST', '/member/order', f.buyer.token, {
        source: 'buy-now',
        requestKey: randomUUID(),
        expectedAmountCents: f.skuMedium.priceCents,
        addressId: f.address.id,
        goods: [{ skuId: f.skuMedium.id, count: 1 }]
      })
    ])
    const statuses = [r1.status, r2.status].sort()
    assert.deepEqual(statuses, [200, 409])
    const failed = r1.status === 409 ? r1 : r2
    assert.equal(failed.body.reason, 'SPENDING_PAUSED')
    assert.equal((failed.body.result as { limitType: string }).limitType, 'monthly_budget')

    const succeeded = r1.status === 200 ? r1 : r2
    const orderId = (succeeded.body.result as { id: string }).id

    // 未支付期间占额 6000，再下单 3000（6000+3000>8000）应被月预算拦下
    const blockedMore = await f.call('POST', '/member/order', f.buyer.token, {
      source: 'buy-now',
      requestKey: randomUUID(),
      expectedAmountCents: f.skuSmall.priceCents,
      addressId: f.address.id,
      goods: [{ skuId: f.skuSmall.id, count: 1 }]
    })
    assert.equal(blockedMore.status, 409)
    assert.equal(blockedMore.body.reason, 'SPENDING_PAUSED')

    // 取消未支付订单释放占额，然后再下单 6000 成功并支付转入 spentCents
    const cancelled = await f.call('PUT', `/member/order/${orderId}/cancel`, f.buyer.token)
    assert.equal(cancelled.status, 200)
    const summaryAfterCancel = await f.call('GET', '/member/spending/summary', f.buyer.token)
    assert.equal((summaryAfterCancel.body.result as { reservedCents: number; spentCents: number; remainingBudgetCents: number }).reservedCents, 0)
    assert.equal((summaryAfterCancel.body.result as { remainingBudgetCents: number }).remainingBudgetCents, 8000)

    const secondOrder = await f.call('POST', '/member/order', f.buyer.token, {
      source: 'buy-now',
      requestKey: randomUUID(),
      expectedAmountCents: f.skuMedium.priceCents,
      addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }]
    })
    assert.equal(secondOrder.status, 200)
    const secondId = (secondOrder.body.result as { id: string }).id
    assert.equal((await f.call('POST', `/member/order/${secondId}/mock-pay`, f.buyer.token, { amountCents: f.skuMedium.priceCents })).status, 200)

    const summaryPaid = await f.call('GET', '/member/spending/summary', f.buyer.token)
    assert.equal((summaryPaid.body.result as { spentCents: number; reservedCents: number; remainingBudgetCents: number }).spentCents, 6000)
    assert.equal((summaryPaid.body.result as { reservedCents: number }).reservedCents, 0)
    assert.equal((summaryPaid.body.result as { remainingBudgetCents: number }).remainingBudgetCents, 2000)
  } finally {
    await f.close()
  }
})

test('SG05 冷静阈值触发待买清单（不建单不扣库存不删购物车）及多入口防绕过、调价重确认与取消', async () => {
  const f = await setupFixture()
  try {
    await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      requestKey: randomUUID(),
      expectedVersion: 0,
      monthlyBudgetCents: null,
      perOrderLimitCents: null,
      cooldownThresholdCents: 6000,
      cooldownHours: 24,
      enabled: true,
      disclosureAccepted: true
    })

    // 低于阈值（3000 < 6000）可直接创建待付订单；同时准备一件购物车商品供测试未删除购物车
    assert.equal((await f.call('POST', '/member/cart', f.buyer.token, { skuId: f.skuMedium.id, count: 1, requestKey: randomUUID() })).status, 200)
    const beforeMediumStock = f.ctx.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', f.skuMedium.id)!.stock

    // 达到阈值（6000 >= 6000）从购物车进入待买清单
    const cartReqKey = randomUUID()
    const enqueued = await f.call('POST', '/member/order', f.buyer.token, {
      source: 'cart',
      requestKey: cartReqKey,
      expectedAmountCents: f.skuMedium.priceCents,
      addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }]
    })
    assert.equal(enqueued.status, 200)
    const wishRes = enqueued.body.result as { wishlistItemId: string; cooldownUntil: number; quotedTotalCents: number; id?: string }
    assert.ok(wishRes.wishlistItemId)
    assert.equal(wishRes.id, undefined)
    assert.equal(wishRes.cooldownUntil, f.getNow() + 24 * HOUR_MS)
    assert.equal(wishRes.quotedTotalCents, 6000)

    // 同一 requestKey 重放返回同待买项，不建单、不扣库存、不删购物车
    const replay = await f.call('POST', '/member/order', f.buyer.token, {
      source: 'cart',
      requestKey: cartReqKey,
      expectedAmountCents: f.skuMedium.priceCents,
      addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }]
    })
    assert.equal(replay.status, 200)
    assert.equal((replay.body.result as { wishlistItemId: string }).wishlistItemId, wishRes.wishlistItemId)
    assert.equal(f.ctx.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', f.skuMedium.id)!.stock, beforeMediumStock)
    assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM orders WHERE owner_id=?', f.buyer.id)!.n, 0)
    assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM carts WHERE user_id=?', f.buyer.id)!.n, 1)

    // 防绕过 1：直接重切 buy-now 再次 POST 同商品被 409 COOLDOWN_ACTIVE 拦截
    const directRetry = await f.call('POST', '/member/order', f.buyer.token, {
      source: 'buy-now',
      requestKey: randomUUID(),
      expectedAmountCents: f.skuMedium.priceCents,
      addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }]
    })
    assert.equal(directRetry.status, 409)
    assert.equal(directRetry.body.reason, 'COOLDOWN_ACTIVE')

    // 防绕过 2：在未到期前调高冷静阈值或彻底停用规则，依然被已有未到期冷静单拦截
    await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      requestKey: randomUUID(),
      expectedVersion: 1,
      monthlyBudgetCents: null,
      perOrderLimitCents: null,
      cooldownThresholdCents: null,
      cooldownHours: null,
      enabled: false,
      disclosureAccepted: false
    })
    const bypassAfterDisable = await f.call('POST', '/member/order', f.buyer.token, {
      source: 'buy-now',
      requestKey: randomUUID(),
      expectedAmountCents: f.skuMedium.priceCents,
      addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }]
    })
    assert.equal(bypassAfterDisable.status, 409)
    assert.equal(bypassAfterDisable.body.reason, 'COOLDOWN_ACTIVE')

    // 未到期提前确认待买项也被拒绝
    const earlyConfirm = await f.call('POST', `/member/spending/wishlist/${wishRes.wishlistItemId}/confirm`, f.buyer.token, {
      requestKey: randomUUID(),
      expectedAmountCents: 6000
    })
    assert.equal(earlyConfirm.status, 409)
    assert.equal(earlyConfirm.body.reason, 'COOLDOWN_ACTIVE')

    // 防绕过 3：取消待买项并马上重下单：先恢复规则再测试取消后重建仍继承原未到期截止时间
    await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      requestKey: randomUUID(),
      expectedVersion: 2,
      monthlyBudgetCents: null,
      perOrderLimitCents: null,
      cooldownThresholdCents: 5000,
      cooldownHours: 1,
      enabled: true,
      disclosureAccepted: true
    })
    f.tick(2 * HOUR_MS) // 原截止还剩 22h，新规则只要 1h
    const cancelledWish = await f.call('POST', `/member/spending/wishlist/${wishRes.wishlistItemId}/cancel`, f.buyer.token)
    assert.equal(cancelledWish.status, 200)
    assert.equal((cancelledWish.body.result as { status: string }).status, 'cancelled')
    assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM orders WHERE owner_id=?', f.buyer.id)!.n, 0)

    const rebuild = await f.call('POST', '/member/order', f.buyer.token, {
      source: 'buy-now',
      requestKey: randomUUID(),
      expectedAmountCents: f.skuMedium.priceCents,
      addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }]
    })
    assert.equal(rebuild.status, 200)
    const rebuiltWish = rebuild.body.result as { wishlistItemId: string; cooldownUntil: number }
    assert.equal(rebuiltWish.cooldownUntil, wishRes.cooldownUntil) // 保留更晚的原截止

    // 到期后商家降价/改价：重登新会话后首次确认抛 409 PRICE_CHANGED 且持久化新报价，再次按新报价确认即真正建单
    f.setNow(rebuiltWish.cooldownUntil)
    const freshToken = f.ctx.accounts.login(f.buyer.account, PASSWORD).token
    f.ctx.db.run('UPDATE skus SET price=5500 WHERE id=?', f.skuMedium.id)

    const changed = await f.call('POST', `/member/spending/wishlist/${rebuiltWish.wishlistItemId}/confirm`, freshToken, {
      requestKey: randomUUID(),
      expectedAmountCents: 6000
    })
    assert.equal(changed.status, 409)
    assert.equal(changed.body.reason, 'PRICE_CHANGED')
    assert.equal((changed.body.result as { totalAmountCents: number }).totalAmountCents, 5500)

    // 确认列表接口反映最新报价
    const detailAfterChange = await f.call('GET', `/member/spending/wishlist/${rebuiltWish.wishlistItemId}`, freshToken)
    assert.equal(detailAfterChange.status, 200)
    assert.equal((detailAfterChange.body.result as { quotedTotalCents: number; readyToConfirm: boolean }).quotedTotalCents, 5500)
    assert.equal((detailAfterChange.body.result as { readyToConfirm: boolean }).readyToConfirm, true)

    // 按新报价 5500 确认下单，且同确认号幂等重试返回同一订单
    const confirmKey = randomUUID()
    const confirmed = await f.call('POST', `/member/spending/wishlist/${rebuiltWish.wishlistItemId}/confirm`, freshToken, {
      requestKey: confirmKey,
      expectedAmountCents: 5500
    })
    assert.equal(confirmed.status, 200)
    const createdOrderId = (confirmed.body.result as { id: string; orderId: string }).id
    assert.ok(createdOrderId)
    assert.equal(f.ctx.db.one<{ amount: number }>('SELECT amount FROM orders WHERE id=?', createdOrderId)!.amount, 5500)

    const confirmReplay = await f.call('POST', `/member/spending/wishlist/${rebuiltWish.wishlistItemId}/confirm`, freshToken, {
      requestKey: confirmKey,
      expectedAmountCents: 5500
    })
    assert.equal(confirmReplay.status, 200)
    assert.equal((confirmReplay.body.result as { id: string }).id, createdOrderId)
  } finally {
    await f.close()
  }
})

test('SG06 发起支付阶段再次校验本人规则与冷静拦截；未知支付维持占额且仅结算一次', async () => {
  let channelState: 'unknown' | 'success' = 'unknown'
  const spyChannel: PaymentChannel = {
    create: () => ({ accepted: true }),
    query: () => channelState === 'unknown'
      ? { state: 'unknown' }
      : { state: 'success', paidAt: Date.UTC(2026, 10, 15, 4, 1, 0), channelTransactionId: 'ch-unknown-ok-1' },
    close: () => ({ state: 'closed' }),
    refund: () => 'success'
  }
  const f = await setupFixture({ paymentChannel: spyChannel })
  try {
    // 买家先在无规则时创建两笔待支付订单（3000 与 6000）
    const orderA = (await f.call('POST', '/member/order', f.buyer.token, {
      source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 3000, addressId: f.address.id,
      goods: [{ skuId: f.skuSmall.id, count: 1 }]
    })).body.result as { id: string }
    const orderB = (await f.call('POST', '/member/order', f.buyer.token, {
      source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 6000, addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }]
    })).body.result as { id: string }

    // 再设月预算 5000 分 -> 两笔待付款总和 9000（orderA 的 reserved 3000 + orderB 的 6000 > 5000）
    await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      requestKey: randomUUID(), expectedVersion: 0,
      monthlyBudgetCents: 5000, perOrderLimitCents: null, cooldownThresholdCents: null, cooldownHours: null,
      enabled: true, disclosureAccepted: true
    })

    // 发起支付 orderB（excludeOrderId=orderB，已占 3000 + 本单 6000 = 9000 > 5000）被拦下
    const blockedPay = await f.call('POST', `/member/order/${orderB.id}/payments`, f.buyer.token, { amountCents: 6000 })
    assert.equal(blockedPay.status, 409)
    assert.equal(blockedPay.body.reason, 'SPENDING_PAUSED')

    // 对未超预算的 orderA（排除自身后占额=6000>5000? 先取消 orderB 让占额=0，orderA=3000<=5000）发起未知支付
    await f.call('PUT', `/member/order/${orderB.id}/cancel`, f.buyer.token)
    const started = await f.call('POST', `/member/order/${orderA.id}/payments`, f.buyer.token, { amountCents: 3000 })
    assert.equal(started.status, 200)
    await f.call('POST', `/member/order/${orderA.id}/payments/refresh`, f.buyer.token)

    // 渠道返回 unknown 期间：订单仍待付，预算保持 reserved 3000、不重复记 spent
    const midSummary = (await f.call('GET', '/member/spending/summary', f.buyer.token)).body.result as { spentCents: number; reservedCents: number }
    assert.equal(midSummary.spentCents, 0)
    assert.equal(midSummary.reservedCents, 3000)

    // 渠道确认成功后，再刷新多次仅结算一次
    channelState = 'success'
    await f.call('POST', `/member/order/${orderA.id}/payments/refresh`, f.buyer.token)
    await f.call('POST', `/member/order/${orderA.id}/payments/refresh`, f.buyer.token)
    const endSummary = (await f.call('GET', '/member/spending/summary', f.buyer.token)).body.result as { spentCents: number; reservedCents: number }
    assert.equal(endSummary.spentCents, 3000)
    assert.equal(endSummary.reservedCents, 0)
  } finally {
    await f.close()
  }
})

test('SG07 北京时间自然月切换与同月退款回补、跨月退款不回补及跨月结算', async () => {
  // 2026-11-30 23:59:59.000 北京时间 = 2026-11-30T15:59:59.000Z
  const novEnd = Date.UTC(2026, 10, 30, 15, 59, 59)
  const decStart = Date.UTC(2026, 10, 30, 16, 0, 0) // 2026-12-01 00:00:00 CST
  const f = await setupFixture({ initialNow: novEnd - 2 * HOUR_MS })
  try {
    await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      requestKey: randomUUID(), expectedVersion: 0,
      monthlyBudgetCents: 10000, perOrderLimitCents: null, cooldownThresholdCents: null, cooldownHours: null,
      enabled: true, disclosureAccepted: true
    })

    // 11 月订单 1：付款 6000 并在同月通过已付取消退款 6000 -> 回补当月额度
    const o1 = ((await f.call('POST', '/member/order', f.buyer.token, {
      source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 6000, addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }]
    })).body.result as { id: string }).id
    await f.call('POST', `/member/order/${o1}/mock-pay`, f.buyer.token, { amountCents: 6000 })
    const cancelReq = await f.call('POST', `/member/order/${o1}/cancel-requests`, f.buyer.token, { requestKey: randomUUID() })
    assert.equal(cancelReq.status, 200)
    const cancelId = (cancelReq.body.result as { cancelRequestId: string }).cancelRequestId
    const approved = await f.call('POST', `/merchant/orders/${o1}/cancel-requests/${cancelId}/resolve`, f.merchant.token, { requestKey: randomUUID(), decision: 'approve' })
    assert.equal(approved.status, 200)

    const novAfterSameMonthRefund = (await f.call('GET', '/member/spending/summary', f.buyer.token)).body.result as { monthKey: string; spentCents: number; remainingBudgetCents: number }
    assert.equal(novAfterSameMonthRefund.monthKey, '2026-11')
    assert.equal(novAfterSameMonthRefund.spentCents, 0)
    assert.equal(novAfterSameMonthRefund.remainingBudgetCents, 10000)

    // 11 月订单 2（3000）与订单 3（23:55 CST 创建待付占额 3000，跨过零点到 12 月 00:00:01 CST 才支付）
    const o2 = ((await f.call('POST', '/member/order', f.buyer.token, {
      source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 3000, addressId: f.address.id,
      goods: [{ skuId: f.skuSmall.id, count: 1 }]
    })).body.result as { id: string }).id
    await f.call('POST', `/member/order/${o2}/mock-pay`, f.buyer.token, { amountCents: 3000 })

    // 验证北京时间 23:55 创建并至 23:59:59 仍属 2026-11
    f.setNow(novEnd - 5 * 60_000)
    const novToken = f.ctx.accounts.login(f.buyer.account, PASSWORD).token
    const o3 = ((await f.call('POST', '/member/order', novToken, {
      source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 3000, addressId: f.address.id,
      goods: [{ skuId: f.skuSmall.id, count: 1 }]
    })).body.result as { id: string }).id
    f.setNow(novEnd)
    const boundaryNov = (await f.call('GET', '/member/spending/summary', novToken)).body.result as { monthKey: string; spentCents: number; reservedCents: number }
    assert.equal(boundaryNov.monthKey, '2026-11')
    assert.equal(boundaryNov.spentCents, 3000)
    assert.equal(boundaryNov.reservedCents, 3000)

    // 跨入 2026-12-01 00:00:00 CST：对 11 月订单 o2 执行取消退款（completed_at 在 12 月），并将 o3 在 12 月支付
    f.setNow(decStart)
    const decBuyerToken = f.ctx.accounts.login(f.buyer.account, PASSWORD).token
    const decMerchantToken = f.ctx.accounts.login(f.merchant.account, PASSWORD).token
    const o2CancelReq = await f.call('POST', `/member/order/${o2}/cancel-requests`, decBuyerToken, { requestKey: randomUUID() })
    assert.equal(o2CancelReq.status, 200)
    const o2CancelId = (o2CancelReq.body.result as { cancelRequestId: string }).cancelRequestId
    const o2Approved = await f.call('POST', `/merchant/orders/${o2}/cancel-requests/${o2CancelId}/resolve`, decMerchantToken, { requestKey: randomUUID(), decision: 'approve' })
    assert.equal(o2Approved.status, 200)

    // 11 月占额记录仍保留 3000（跨月退款未回补 11 月）
    f.setNow(novEnd)
    const novLookback = (await f.call('GET', '/member/spending/summary', novToken)).body.result as { monthKey: string; spentCents: number }
    assert.equal(novLookback.monthKey, '2026-11')
    assert.equal(novLookback.spentCents, 3000)

    // 12 月已花从 0 起算，跨月未付款订单 o3 继续占额 reservedCents=3000（剩余 7000）；支付 o3 后转为已花 3000、占额清零
    f.setNow(decStart + 1000)
    const decBeforePay = (await f.call('GET', '/member/spending/summary', decBuyerToken)).body.result as { monthKey: string; spentCents: number; reservedCents: number; remainingBudgetCents: number }
    assert.equal(decBeforePay.monthKey, '2026-12')
    assert.equal(decBeforePay.spentCents, 0)
    assert.equal(decBeforePay.reservedCents, 3000)
    assert.equal(decBeforePay.remainingBudgetCents, 7000)

    assert.equal((await f.call('POST', `/member/order/${o3}/mock-pay`, decBuyerToken, { amountCents: 3000 })).status, 200)
    const decAfterPay = (await f.call('GET', '/member/spending/summary', decBuyerToken)).body.result as { spentCents: number; reservedCents: number; remainingBudgetCents: number }
    assert.equal(decAfterPay.spentCents, 3000)
    assert.equal(decAfterPay.reservedCents, 0)
    assert.equal(decAfterPay.remainingBudgetCents, 7000)
  } finally {
    await f.close()
  }
})

test('SG08 匿名/商家与跨买家权限隔离，且他人操作不干扰本人的规则与待买清单', async () => {
  const f = await setupFixture()
  try {
    // 匿名 401，商家 403
    assert.equal((await f.call('GET', '/member/spending/summary')).status, 401)
    assert.equal((await f.call('GET', '/member/spending/rules', f.merchant.token)).status, 403)
    assert.equal((await f.call('PUT', '/member/spending/rules', f.merchant.token, {
      requestKey: randomUUID(), expectedVersion: 0,
      monthlyBudgetCents: 1000, perOrderLimitCents: null, cooldownThresholdCents: null, cooldownHours: null,
      enabled: true, disclosureAccepted: true
    })).status, 403)

    // 买家1 产生一条待买记录
    await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      requestKey: randomUUID(), expectedVersion: 0,
      monthlyBudgetCents: null, perOrderLimitCents: null, cooldownThresholdCents: 5000, cooldownHours: 2,
      enabled: true, disclosureAccepted: true
    })
    const wish1 = ((await f.call('POST', '/member/order', f.buyer.token, {
      source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 6000, addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }]
    })).body.result as { wishlistItemId: string }).wishlistItemId

    // 买家2 无权读、取消、确认买家1的待买项（403）
    assert.equal((await f.call('GET', `/member/spending/wishlist/${wish1}`, f.buyer2.token)).status, 403)
    assert.equal((await f.call('POST', `/member/spending/wishlist/${wish1}/cancel`, f.buyer2.token)).status, 403)
    f.tick(3 * HOUR_MS)
    assert.equal((await f.call('POST', `/member/spending/wishlist/${wish1}/confirm`, f.buyer2.token, {
      requestKey: randomUUID(), expectedAmountCents: 6000
    })).status, 403)

    // 买家2 取消自己独立的待买记录，不应影响买家1 的 waiting 记录
    await f.call('PUT', '/member/spending/rules', f.buyer2.token, {
      requestKey: randomUUID(), expectedVersion: 0,
      monthlyBudgetCents: null, perOrderLimitCents: null, cooldownThresholdCents: 5000, cooldownHours: 2,
      enabled: true, disclosureAccepted: true
    })
    const wish2 = ((await f.call('POST', '/member/order', f.buyer2.token, {
      source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 6000, addressId: f.address2.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }]
    })).body.result as { wishlistItemId: string }).wishlistItemId
    assert.equal((await f.call('POST', `/member/spending/wishlist/${wish2}/cancel`, f.buyer2.token)).status, 200)

    const buyer1Detail = await f.call('GET', `/member/spending/wishlist/${wish1}`, f.buyer.token)
    assert.equal((buyer1Detail.body.result as { status: string }).status, 'waiting')
  } finally {
    await f.close()
  }
})

test('SG09 v30旧库升级到v31、备份恢复与规则/占额/待买篡改拦截全闭环', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hdm-spend-backup-'))
  try {
    const f = await setupFixture({ rootDir: root })
    try {
      await f.call('PUT', '/member/spending/rules', f.buyer.token, {
        requestKey: randomUUID(), expectedVersion: 0,
        monthlyBudgetCents: 50000, perOrderLimitCents: 20000, cooldownThresholdCents: 10000, cooldownHours: 12,
        enabled: true, disclosureAccepted: true
      })
      const ord = ((await f.call('POST', '/member/order', f.buyer.token, {
        source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 6000, addressId: f.address.id,
        goods: [{ skuId: f.skuMedium.id, count: 1 }]
      })).body.result as { id: string }).id
      const wish = ((await f.call('POST', '/member/order', f.buyer.token, {
        source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 11000, addressId: f.address.id,
        goods: [{ skuId: f.skuLarge.id, count: 1 }]
      })).body.result as { wishlistItemId: string }).wishlistItemId
      assert.ok(ord && wish)
    } finally {
      await f.ctx.app.close()
    }

    const dbPath = join(root, 'data', 'mall.sqlite')
    const uploadsPath = join(root, 'uploads')

    // 正常备份校验与恢复
    const backup = await createBackup({ databasePath: dbPath, uploadsPath, destination: join(root, 'bak-ok') })
    assert.equal(backup.manifest.schemaVersion, 31)
    assert.equal(backup.counts.spending_rules, 1)
    assert.equal(backup.counts.spending_reservations, 1)
    assert.equal(backup.counts.purchase_wishlist, 1)
    const verified = await verifyBackup(backup.root)
    assert.equal(verified.manifest.schemaVersion, 31)

    const restored = await restoreBackup({ backupPath: backup.root, destination: join(root, 'restored') })
    const restoredDb = new Database(join(restored.root, 'mall.sqlite'))
    try {
      assert.equal(restoredDb.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 31)
      assert.equal(restoredDb.one<{ n: number }>('SELECT COUNT(*) n FROM spending_rules')!.n, 1)
      assert.equal(restoredDb.one<{ n: number }>('SELECT COUNT(*) n FROM spending_reservations')!.n, 1)
      assert.equal(restoredDb.one<{ n: number }>('SELECT COUNT(*) n FROM purchase_wishlist')!.n, 1)
    } finally {
      restoredDb.close()
    }

    // 篡改 spending_reservations.cents 拒绝备份
    const tamperResPath = join(root, 'data', 'tamper-res.sqlite')
    const src1 = new DatabaseSync(dbPath)
    try { src1.exec(`VACUUM INTO '${tamperResPath.replace(/\\/g, '/')}'`) } finally { src1.close() }
    const badRes = new DatabaseSync(tamperResPath)
    try { badRes.exec('UPDATE spending_reservations SET cents=1') } finally { badRes.close() }
    await assert.rejects(
      createBackup({ databasePath: tamperResPath, uploadsPath, destination: join(root, 'bak-bad-res') }),
      /消费预算占额与订单或规则状态不一致/
    )

    // 篡改 purchase_wishlist.goods 为非法空数组拒绝备份
    const tamperWishPath = join(root, 'data', 'tamper-wish.sqlite')
    const src2 = new DatabaseSync(dbPath)
    try { src2.exec(`VACUUM INTO '${tamperWishPath.replace(/\\/g, '/')}'`) } finally { src2.close() }
    const badWish = new DatabaseSync(tamperWishPath)
    try { badWish.exec("UPDATE purchase_wishlist SET goods='[]'") } finally { badWish.close() }
    await assert.rejects(
      createBackup({ databasePath: tamperWishPath, uploadsPath, destination: join(root, 'bak-bad-wish') }),
      /待买清单快照或规则版本归属无效/
    )

    // v30 历史库可自动升到 v31 且保留原有数据
    const legacyV30Path = join(root, 'data', 'legacy-v30.sqlite')
    const src3 = new DatabaseSync(dbPath)
    try { src3.exec(`VACUUM INTO '${legacyV30Path.replace(/\\/g, '/')}'`) } finally { src3.close() }
    const v30Raw = new DatabaseSync(legacyV30Path)
    try {
      v30Raw.exec('DROP TABLE IF EXISTS purchase_wishlist; DROP TABLE IF EXISTS spending_reservations; DROP TABLE IF EXISTS spending_rules; PRAGMA user_version=30;')
    } finally { v30Raw.close() }
    const upgraded = new Database(legacyV30Path)
    try {
      assert.equal(upgraded.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 31)
      assert.equal(upgraded.one<{ n: number }>('SELECT COUNT(*) n FROM spending_rules')!.n, 0)
    } finally {
      upgraded.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SG10 v30历史已付/待付订单升级到031自动回填且幂等不重复入账，跨月仍保持口径', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hdm-spend-legacy-backfill-'))
  try {
    const f = await setupFixture({ rootDir: root })
    let paidOrderId = ''
    let unpaidOrderId = ''
    try {
      paidOrderId = ((await f.call('POST', '/member/order', f.buyer.token, {
        source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 6000, addressId: f.address.id,
        goods: [{ skuId: f.skuMedium.id, count: 1 }]
      })).body.result as { id: string }).id
      assert.equal((await f.call('POST', `/member/order/${paidOrderId}/mock-pay`, f.buyer.token, { amountCents: 6000 })).status, 200)

      unpaidOrderId = ((await f.call('POST', '/member/order', f.buyer.token, {
        source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 3000, addressId: f.address.id,
        goods: [{ skuId: f.skuSmall.id, count: 1 }]
      })).body.result as { id: string }).id
    } finally {
      await f.ctx.app.close()
    }

    const dbPath = join(root, 'data', 'mall.sqlite')
    const raw = new DatabaseSync(dbPath)
    try {
      raw.exec('DROP TABLE purchase_wishlist; DROP TABLE spending_reservations; DROP TABLE spending_rules; PRAGMA user_version=30;')
    } finally {
      raw.close()
    }

    const upgraded1 = new Database(dbPath, { now: () => f.getNow() })
    try {
      assert.equal(upgraded1.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 31)
      const sum1 = spendingSummary(upgraded1, f.buyer.id, f.getNow())
      assert.equal(sum1.spentCents, 6000)
      assert.equal(sum1.reservedCents, 3000)
      assert.equal(upgraded1.one<{ n: number }>('SELECT COUNT(*) n FROM spending_reservations')!.n, 2)
    } finally {
      upgraded1.close()
    }

    // 重复打开并幂等调用回填函数，占额行数与汇总金额不得翻倍
    const upgraded2 = new Database(dbPath, { now: () => f.getNow() })
    try {
      const sum2 = spendingSummary(upgraded2, f.buyer.id, f.getNow())
      assert.equal(sum2.spentCents, 6000)
      assert.equal(sum2.reservedCents, 3000)
      assert.equal(upgraded2.one<{ n: number }>('SELECT COUNT(*) n FROM spending_reservations')!.n, 2)
    } finally {
      upgraded2.close()
    }

    const rawCheck = new DatabaseSync(dbPath)
    try {
      backfillSpendingReservations(rawCheck)
      backfillSpendingReservations(rawCheck)
      assert.equal(Number(rawCheck.prepare('SELECT COUNT(*) n FROM spending_reservations').get()!.n), 2)
    } finally {
      rawCheck.close()
    }

    const backup = await createBackup({ databasePath: dbPath, uploadsPath: join(root, 'uploads'), destination: join(root, 'bak') })
    assert.equal(backup.manifest.schemaVersion, 31)
    assert.equal(backup.counts.spending_reservations, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SG11 跨月未知付款继续占额并拦截新月下单，确认成功后按实付月记账且取消/失败可释放', async () => {
  let channelOutcome: { state: 'unknown' } | { state: 'success'; paidAt: number } | { state: 'fail' } = { state: 'unknown' }
  const channel: PaymentChannel = {
    create: () => ({ accepted: true }),
    query: () => channelOutcome.state === 'success'
      ? { state: 'success', paidAt: channelOutcome.paidAt, channelTransactionId: 'ch-cross-' + channelOutcome.paidAt }
      : channelOutcome,
    close: () => ({ state: 'closed' }),
    refund: () => 'success'
  }
  const novEnd = Date.UTC(2026, 10, 30, 15, 59, 0) // 2026-11-30 23:59 CST
  const f = await setupFixture({ initialNow: novEnd, paymentChannel: channel })
  try {
    await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      requestKey: randomUUID(), expectedVersion: 0,
      monthlyBudgetCents: 6000, perOrderLimitCents: null, cooldownThresholdCents: null, cooldownHours: null,
      enabled: true, disclosureAccepted: true
    })

    const ord1 = ((await f.call('POST', '/member/order', f.buyer.token, {
      source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 6000, addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }]
    })).body.result as { id: string }).id
    assert.equal((await f.call('POST', `/member/order/${ord1}/payments`, f.buyer.token, { amountCents: 6000 })).status, 200)

    // 跨入 2026-12-01 00:00:01 CST：未知付款依然占用新月预算
    f.tick(61_000)
    const decToken = f.ctx.accounts.login(f.buyer.account, PASSWORD).token
    const decSummary = (await f.call('GET', '/member/spending/summary', decToken)).body.result as {
      monthKey: string; spentCents: number; reservedCents: number; remainingBudgetCents: number
    }
    assert.equal(decSummary.monthKey, '2026-12')
    assert.equal(decSummary.spentCents, 0)
    assert.equal(decSummary.reservedCents, 6000)
    assert.equal(decSummary.remainingBudgetCents, 0)

    const blockedSecond = await f.call('POST', '/member/order', decToken, {
      source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 6000, addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }]
    })
    assert.equal(blockedSecond.status, 409)
    assert.equal(blockedSecond.body.reason, 'SPENDING_PAUSED')

    // 渠道最终按 12 月成功结算（重复 refresh 只结算一次）
    channelOutcome = { state: 'success', paidAt: f.getNow() }
    assert.equal((await f.call('POST', `/member/order/${ord1}/payments/refresh`, decToken)).status, 200)
    assert.equal((await f.call('POST', `/member/order/${ord1}/payments/refresh`, decToken)).status, 200)
    const afterSettle = (await f.call('GET', '/member/spending/summary', decToken)).body.result as {
      spentCents: number; reservedCents: number; remainingBudgetCents: number
    }
    assert.equal(afterSettle.spentCents, 6000)
    assert.equal(afterSettle.reservedCents, 0)
    assert.equal(afterSettle.remainingBudgetCents, 0)

    // 若另一单跨月未知后超时失败释放，则新月恢复可用额度
    await f.call('PUT', '/member/spending/rules', decToken, {
      requestKey: randomUUID(), expectedVersion: 1,
      monthlyBudgetCents: 12000, perOrderLimitCents: null, cooldownThresholdCents: null, cooldownHours: null,
      enabled: true, disclosureAccepted: true
    })
    channelOutcome = { state: 'unknown' }
    const ord2 = ((await f.call('POST', '/member/order', decToken, {
      source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 6000, addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }]
    })).body.result as { id: string }).id
    assert.equal((await f.call('POST', `/member/order/${ord2}/payments`, decToken, { amountCents: 6000 })).status, 200)
    f.tick(20 * 60_000) // 超过支付有效期并渠道返回 fail
    channelOutcome = { state: 'fail' }
    const janToken = f.ctx.accounts.login(f.buyer.account, PASSWORD).token
    await f.call('POST', `/member/order/${ord2}/payments/refresh`, janToken)
    const afterRelease = (await f.call('GET', '/member/spending/summary', janToken)).body.result as {
      spentCents: number; reservedCents: number; remainingBudgetCents: number
    }
    assert.equal(afterRelease.spentCents, 6000)
    assert.equal(afterRelease.reservedCents, 0)
    assert.equal(afterRelease.remainingBudgetCents, 6000)
  } finally {
    await f.close()
  }
})

test('SG12 退货限制商品入待买清单后可跨会话沿用未变同意，政策变化则拦截并支持新 token 重确认', async () => {
  const f = await setupFixture()
  try {
    const productRow = f.ctx.db.one<{ product_id: string }>('SELECT product_id FROM skus WHERE id=?', f.skuMedium.id)!
    const productDetail = (await f.call('GET', `/merchant/products/${productRow.product_id}`, f.merchant.token)).body.result as { revision: number }
    assert.equal((await f.call('PUT', `/merchant/products/${productRow.product_id}`, f.merchant.token, {
      requestKey: randomUUID(),
      expectedRevision: productDetail.revision,
      returnPolicy: 'confirm-required',
      returnPolicyReason: 'unsealed',
      returnPolicyNote: ''
    })).status, 200)

    await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      requestKey: randomUUID(), expectedVersion: 0,
      monthlyBudgetCents: null, perOrderLimitCents: null, cooldownThresholdCents: 5000, cooldownHours: 1,
      enabled: true, disclosureAccepted: true
    })

    // 1. 首次确认退货政策后入清单（未变规则即使 25 小时后重新登录，依旧沿用冻结同意并确认成功）
    const needConfirm = await f.call('POST', '/member/order', f.buyer.token, {
      source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 6000, addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }]
    })
    assert.equal(needConfirm.status, 409)
    assert.equal(needConfirm.body.reason, 'RETURN_POLICY_CONFIRM_REQUIRED')
    const tok1 = (needConfirm.body.result as { returnPolicyToken: string }).returnPolicyToken

    const enqueued1 = await f.call('POST', '/member/order', f.buyer.token, {
      source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 6000, addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }],
      returnPolicyConfirmed: true,
      expectedReturnPolicyToken: tok1
    })
    assert.equal(enqueued1.status, 200)
    const wish1Id = (enqueued1.body.result as { wishlistItemId: string }).wishlistItemId

    f.tick(25 * HOUR_MS) // 会话轮转，政策未变
    const nextToken = f.ctx.accounts.login(f.buyer.account, PASSWORD).token
    const confUnchanged = await f.call('POST', `/member/spending/wishlist/${wish1Id}/confirm`, nextToken, {
      requestKey: randomUUID(), expectedAmountCents: 6000
    })
    assert.equal(confUnchanged.status, 200)
    assert.ok((confUnchanged.body.result as { orderId: string }).orderId)

    // 2. 入第二项后商家在冷静期内修改退货说明 -> 必须返回 409 RETURN_POLICY_CHANGED 并要求按新 token 重确认
    const pre2 = (await f.call('GET', `/member/order/pre?skuId=${f.skuMedium.id}&count=1`, nextToken)).body.result as { returnPolicyToken: string }
    const enqueued2 = await f.call('POST', '/member/order', nextToken, {
      source: 'buy-now', requestKey: randomUUID(), expectedAmountCents: 6000, addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }],
      returnPolicyConfirmed: true,
      expectedReturnPolicyToken: pre2.returnPolicyToken
    })
    assert.equal(enqueued2.status, 200)
    const wish2Id = (enqueued2.body.result as { wishlistItemId: string }).wishlistItemId

    const freshMerchantToken = f.ctx.accounts.login(f.merchant.account, PASSWORD).token
    const detailBeforeChange = (await f.call('GET', `/merchant/products/${productRow.product_id}`, freshMerchantToken)).body.result as { revision: number }
    assert.equal((await f.call('PUT', `/merchant/products/${productRow.product_id}`, freshMerchantToken, {
      requestKey: randomUUID(),
      expectedRevision: detailBeforeChange.revision,
      returnPolicy: 'confirm-required',
      returnPolicyReason: 'activated',
      returnPolicyNote: ''
    })).status, 200)

    f.tick(HOUR_MS)
    const changedResp = await f.call('POST', `/member/spending/wishlist/${wish2Id}/confirm`, nextToken, {
      requestKey: randomUUID(), expectedAmountCents: 6000
    })
    assert.equal(changedResp.status, 409)
    assert.equal(changedResp.body.reason, 'RETURN_POLICY_CHANGED')
    const newTok = (changedResp.body.result as { returnPolicyToken: string }).returnPolicyToken
    assert.ok(newTok && newTok !== tok1)

    // 使用旧 token 重试仍被拒绝，必须使用新 token 重新确认才能建单
    const staleAttempt = await f.call('POST', `/member/spending/wishlist/${wish2Id}/confirm`, nextToken, {
      requestKey: randomUUID(), expectedAmountCents: 6000,
      returnPolicyConfirmed: true, expectedReturnPolicyToken: tok1
    })
    assert.equal(staleAttempt.status, 409)
    assert.equal(staleAttempt.body.reason, 'RETURN_POLICY_CHANGED')

    const freshConfirm = await f.call('POST', `/member/spending/wishlist/${wish2Id}/confirm`, nextToken, {
      requestKey: randomUUID(), expectedAmountCents: 6000,
      returnPolicyConfirmed: true, expectedReturnPolicyToken: newTok
    })
    assert.equal(freshConfirm.status, 200)
    assert.ok((freshConfirm.body.result as { orderId: string }).orderId)
  } finally {
    await f.close()
  }
})

test('SG13 发起支付前清扫他人过期普通占额而不释放未知付款占额，且过期本单仍拒绝付款', async () => {
  let createCalls = 0
  const channel: PaymentChannel = {
    mode: 'mock',
    create: async () => {
      createCalls += 1
      return { accepted: true }
    },
    query: async () => ({ state: 'unknown' }),
    close: async () => ({ state: 'closed' }),
    refund: async () => 'success' as const
  }
  const f = await setupFixture({ initialNow: Date.UTC(2026, 10, 30, 15, 59, 0), paymentChannel: channel })
  const saveRule = async (monthlyBudgetCents: number, expectedVersion: number) => {
    const res = await f.call('PUT', '/member/spending/rules', f.buyer.token, {
      requestKey: randomUUID(),
      expectedVersion,
      enabled: true,
      disclosureAccepted: true,
      monthlyBudgetCents,
      perOrderLimitCents: null,
      cooldownThresholdCents: null,
      cooldownHours: null
    })
    assert.equal(res.status, 200)
  }
  const createMediumOrder = async () => {
    const res = await f.call('POST', '/member/order', f.buyer.token, {
      source: 'buy-now',
      requestKey: randomUUID(),
      expectedAmountCents: 6000,
      addressId: f.address.id,
      goods: [{ skuId: f.skuMedium.id, count: 1 }]
    })
    assert.equal(res.status, 200)
    return (res.body.result as { id: string }).id
  }
  try {
    await saveRule(12000, 0)
    const staleId = await createMediumOrder() // expires t + 15m
    f.tick(14 * 60_000)
    const liveId = await createMediumOrder() // expires t + 29m
    await saveRule(6000, 1)
    f.tick(61_000) // t + 15m + 1s: stale 已过期且未有任何清扫

    const staleBefore = f.ctx.db.one<{ state: string }>('SELECT state FROM spending_reservations WHERE order_id=?', staleId)
    assert.equal(staleBefore?.state, 'reserved')

    // 未提前读取 summary，直接支付 liveId：必须清扫 stale 占额并通过（200）
    const livePay = await f.call('POST', `/member/order/${liveId}/payments`, f.buyer.token, { amountCents: 6000 })
    assert.equal(livePay.status, 200)
    assert.equal(createCalls, 1)
    const staleAfter = f.ctx.db.one<{ state: string; release_reason: string | null }>(
      'SELECT state, release_reason FROM spending_reservations WHERE order_id=?', staleId
    )
    assert.equal(staleAfter?.state, 'released')
    assert.equal(staleAfter?.release_reason, 'expired')
    assert.equal(f.ctx.db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', staleId)?.state, 6)

    // 反向断言：liveId 存在未知确认中的 pending 付款，即使超过订单过期时间仍保留占额并拦截 live2 付款
    await saveRule(12000, 2)
    f.tick(10 * 60_000) // t + 25m + 1s
    const live2Id = await createMediumOrder() // expires t + 40m + 1s
    await saveRule(6000, 3)
    f.tick(5 * 60_000) // t + 30m + 1s: liveId 已超 29m 过期线但仍在 pending 确认中

    const blockedPay = await f.call('POST', `/member/order/${live2Id}/payments`, f.buyer.token, { amountCents: 6000 })
    assert.equal(blockedPay.status, 409)
    assert.equal(blockedPay.body.reason, 'SPENDING_PAUSED')
    assert.equal(createCalls, 1)
    const liveReservation = f.ctx.db.one<{ state: string }>('SELECT state FROM spending_reservations WHERE order_id=?', liveId)
    assert.equal(liveReservation?.state, 'reserved')

    // 直接发起已过期普通单的付款仍返回 409 订单已超时且释放该单占额
    const expiredPay = await f.call('POST', `/member/order/${staleId}/payments`, f.buyer.token, { amountCents: 6000 })
    assert.equal(expiredPay.status, 409)
    assert.match(String(expiredPay.body.msg ?? ''), /订单已超时/)
    assert.equal(createCalls, 1)

    f.tick(10 * 60_000) // t + 40m + 1s: live2Id 也自然过期后再次单独尝试付款也必须 409 订单已超时
    const expiredLive2Pay = await f.call('POST', `/member/order/${live2Id}/payments`, f.buyer.token, { amountCents: 6000 })
    assert.equal(expiredLive2Pay.status, 409)
    assert.match(String(expiredLive2Pay.body.msg ?? ''), /订单已超时/)
    assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM spending_reservations WHERE order_id=?', live2Id)?.state, 'released')
    assert.equal(createCalls, 1)
  } finally {
    await f.close()
  }
})
