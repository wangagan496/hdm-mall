import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { Database } from './database.ts'
import { requireBuyer, type User } from './accounts.ts'
import { appendAudit } from './audit.ts'
import { AppError, ensure } from './errors.ts'
import type {
  SpendingPauseDetail,
  SpendingRule,
  SpendingSummary
} from './spending-guard/generated.ts'

export const CST_OFFSET_MS = 8 * 3600_000
export const MONTH_DISCLOSURE = '按北京时间自然月计算，本月已付计已花，待付/待确认计在途占额；同月成功退款回补当月额度，跨月退款不回补上月额度。'

export const spendingRuleInputSchema = z.object({
  requestKey: z.string().min(1).max(100),
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  monthlyBudgetCents: z.number().int().min(1).max(2147483647).nullable(),
  perOrderLimitCents: z.number().int().min(1).max(2147483647).nullable(),
  cooldownThresholdCents: z.number().int().min(1).max(2147483647).nullable(),
  cooldownHours: z.number().int().min(1).max(72).nullable(),
  enabled: z.boolean(),
  disclosureAccepted: z.boolean()
}).strict()

export type SpendingRuleInputData = z.infer<typeof spendingRuleInputSchema>

interface RuleRow {
  id: string
  user_id: string
  version: number
  monthly_budget_cents: number | null
  per_order_limit_cents: number | null
  cooldown_threshold_cents: number | null
  cooldown_hours: number | null
  enabled: number
  request_key: string
  created_at: number
}

interface ReservationRow {
  order_id: string
  user_id: string
  month_key: string
  cents: number
  rule_version: number | null
  state: 'reserved' | 'settled' | 'released'
}

export type EvaluationResult =
  | { decision: 'pass'; rule: SpendingRule; summary: SpendingSummary }
  | { decision: 'pause'; rule: SpendingRule; summary: SpendingSummary; pauseDetail: SpendingPauseDetail; message: string }
  | { decision: 'cooldown'; rule: SpendingRule; summary: SpendingSummary; cooldownHours: number }

export function monthKey(now: number): string {
  const shifted = new Date(now + CST_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

/** 幂等回填迁移前历史订单到 spending_reservations；重复执行不覆盖已有占额记录。 */
export function backfillSpendingReservations(connection: DatabaseSync): void {
  const orders = connection.prepare(`
    SELECT o.id, o.owner_id, o.state, o.amount, o.created, o.paid_at
    FROM orders o
    WHERE NOT EXISTS (SELECT 1 FROM spending_reservations sr WHERE sr.order_id = o.id)
  `).all() as Array<{
    id: string
    owner_id: string
    state: number
    amount: number
    created: number
    paid_at: number | null
  }>
  if (!orders.length) return
  const insert = connection.prepare(`
    INSERT OR IGNORE INTO spending_reservations(
      order_id, user_id, month_key, cents, rule_version, state, release_reason, created_at, updated_at
    ) VALUES(?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `)
  for (const order of orders) {
    const orderState = Number(order.state)
    let state: 'reserved' | 'settled' | 'released'
    let mk: string
    let releaseReason: string | null = null
    let updatedAt = order.created
    if (orderState === 1) {
      state = 'reserved'
      mk = monthKey(order.created)
    } else if ([2, 3, 4, 5].includes(orderState)) {
      state = 'settled'
      const effectivePaidAt = order.paid_at ?? order.created
      mk = monthKey(effectivePaidAt)
      updatedAt = effectivePaidAt
    } else {
      if (order.paid_at !== null) {
        state = 'settled'
        mk = monthKey(order.paid_at)
        updatedAt = order.paid_at
      } else {
        state = 'released'
        mk = monthKey(order.created)
        releaseReason = 'cancelled'
      }
    }
    insert.run(order.id, order.owner_id, mk, order.amount, state, releaseReason, order.created, updatedAt)
  }
}

function presentRule(row: RuleRow): SpendingRule {
  return {
    id: row.id,
    version: row.version,
    monthlyBudgetCents: row.monthly_budget_cents,
    perOrderLimitCents: row.per_order_limit_cents,
    cooldownThresholdCents: row.cooldown_threshold_cents,
    cooldownHours: row.cooldown_hours,
    enabled: row.enabled === 1,
    monthDisclosure: MONTH_DISCLOSURE,
    createdAt: row.created_at
  }
}

export function currentRule(db: Database, userId: string): SpendingRule {
  const row = db.one<RuleRow>('SELECT * FROM spending_rules WHERE user_id=? ORDER BY version DESC LIMIT 1', userId)
  if (!row) {
    return {
      id: null,
      version: 0,
      monthlyBudgetCents: null,
      perOrderLimitCents: null,
      cooldownThresholdCents: null,
      cooldownHours: null,
      enabled: false,
      monthDisclosure: MONTH_DISCLOSURE,
      createdAt: 0
    }
  }
  return presentRule(row)
}

export function listRules(db: Database, user: User): { current: SpendingRule; history: SpendingRule[] } {
  requireBuyer(user)
  const rows = db.all<RuleRow>('SELECT * FROM spending_rules WHERE user_id=? ORDER BY version DESC', user.id)
  const history = rows.map(presentRule)
  return { current: history[0] ?? currentRule(db, user.id), history }
}

export function saveRule(db: Database, user: User, rawInput: unknown, now: number): SpendingRule {
  requireBuyer(user)
  const data = spendingRuleInputSchema.parse(rawInput)
  return db.transaction(() => {
    const existing = db.one<RuleRow>('SELECT * FROM spending_rules WHERE user_id=? AND request_key=?', user.id, data.requestKey)
    if (existing) {
      const same = existing.monthly_budget_cents === data.monthlyBudgetCents &&
        existing.per_order_limit_cents === data.perOrderLimitCents &&
        existing.cooldown_threshold_cents === data.cooldownThresholdCents &&
        existing.cooldown_hours === data.cooldownHours &&
        (existing.enabled === 1) === data.enabled
      ensure(same, 409, '同一次保存请求不能修改规则参数')
      return presentRule(existing)
    }

    const latest = currentRule(db, user.id)
    if (latest.version !== data.expectedVersion) {
      throw new AppError(409, '消费保护规则已更新，请刷新后再保存', 'SPENDING_RULE_VERSION_CHANGED', latest)
    }

    if (data.cooldownThresholdCents !== null) {
      ensure(data.cooldownHours !== null && data.cooldownHours >= 1 && data.cooldownHours <= 72, 400, '设置冷静阈值时请选择 1 至 72 小时的冷静时长')
    } else {
      ensure(data.cooldownHours === null, 400, '设置冷静时长前请先设置冷静触发金额')
    }

    if (data.enabled) {
      ensure(data.disclosureAccepted, 400, '启用前请先阅读并确认本月花费与跨月退款不回补说明')
      ensure(
        data.monthlyBudgetCents !== null || data.perOrderLimitCents !== null || data.cooldownThresholdCents !== null,
        400,
        '请至少设置月度预算、单笔限额或冷静阈值中的一项'
      )
    }

    const nextVersion = latest.version + 1
    const id = randomUUID()
    db.run(
      `INSERT INTO spending_rules(
        id,user_id,version,monthly_budget_cents,per_order_limit_cents,
        cooldown_threshold_cents,cooldown_hours,enabled,request_key,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      id, user.id, nextVersion, data.monthlyBudgetCents, data.perOrderLimitCents,
      data.cooldownThresholdCents, data.cooldownHours, Number(data.enabled), data.requestKey, now
    )
    appendAudit(db, {
      created: now,
      actor: user,
      action: 'spending.rule',
      targetType: 'settings',
      targetId: 'spending-guard',
      requestKey: data.requestKey,
      summary: {
        after: `v${nextVersion}`,
        note: data.enabled ? '启用或更新消费保护规则' : '停用消费保护规则'
      }
    })
    return presentRule(db.one<RuleRow>('SELECT * FROM spending_rules WHERE id=?', id)!)
  })
}

export function spendingSummary(
  db: Database,
  userId: string,
  now: number,
  options?: { excludeOrderId?: string }
): SpendingSummary {
  const mk = monthKey(now)
  const rule = currentRule(db, userId)
  const settledRows = db.all<ReservationRow>(
    "SELECT order_id,user_id,month_key,cents,rule_version,state FROM spending_reservations WHERE user_id=? AND month_key=? AND state='settled'",
    userId, mk
  )
  // 待付款或渠道结果未知的订单在结算或释放前跨月继续占额，防止越过月初时释放额度导致叠加超预算
  const reservedRows = db.all<ReservationRow>(
    "SELECT order_id,user_id,month_key,cents,rule_version,state FROM spending_reservations WHERE user_id=? AND month_key<=? AND state='reserved'",
    userId, mk
  )

  let reservedCents = 0
  let spentCents = 0

  for (const row of reservedRows) {
    if (options?.excludeOrderId && row.order_id === options.excludeOrderId) continue
    reservedCents += row.cents
  }

  for (const row of settledRows) {
    if (options?.excludeOrderId && row.order_id === options.excludeOrderId) continue
    const refundedRows = db.all<{ amount: number; completed_at: number }>(
      `SELECT r.amount, r.completed_at
       FROM refunds r
       JOIN payments p ON p.id=r.payment_id
       WHERE p.order_id=? AND r.reason IN ('cancelled','after-sale') AND r.state='succeeded' AND r.completed_at IS NOT NULL`,
      row.order_id
    )
    let sameMonthRefundCents = 0
    for (const ref of refundedRows) {
      if (monthKey(ref.completed_at) === mk) {
        sameMonthRefundCents += ref.amount
      }
    }
    spentCents += Math.max(0, row.cents - sameMonthRefundCents)
  }

  const remainingBudgetCents = rule.monthlyBudgetCents === null
    ? null
    : Math.max(0, rule.monthlyBudgetCents - spentCents - reservedCents)
  const waitingWishlistCount = db.one<{ count: number }>(
    "SELECT COUNT(*) AS count FROM purchase_wishlist WHERE user_id=? AND status='waiting'",
    userId
  )!.count

  return {
    monthKey: mk,
    ruleVersion: rule.version,
    enabled: rule.enabled,
    monthlyBudgetCents: rule.monthlyBudgetCents,
    perOrderLimitCents: rule.perOrderLimitCents,
    cooldownThresholdCents: rule.cooldownThresholdCents,
    cooldownHours: rule.cooldownHours,
    spentCents,
    reservedCents,
    remainingBudgetCents,
    waitingWishlistCount,
    monthDisclosure: MONTH_DISCLOSURE
  }
}

export function evaluate(
  db: Database,
  userId: string,
  amountCents: number,
  now: number,
  options?: { hardOnly?: boolean; excludeOrderId?: string }
): EvaluationResult {
  const rule = currentRule(db, userId)
  const summary = spendingSummary(db, userId, now, { excludeOrderId: options?.excludeOrderId })
  if (!rule.enabled) {
    return { decision: 'pass', rule, summary }
  }

  // 判定顺序固定：1. 单笔限额 → 2. 月度预算 → 3. 冷静阈值
  if (rule.perOrderLimitCents !== null && amountCents > rule.perOrderLimitCents) {
    return {
      decision: 'pause',
      rule,
      summary,
      pauseDetail: {
        limitType: 'per_order',
        amountCents,
        limitCents: rule.perOrderLimitCents,
        ruleVersion: rule.version,
        monthKey: summary.monthKey,
        spentCents: summary.spentCents,
        reservedCents: summary.reservedCents,
        remainingBudgetCents: summary.remainingBudgetCents
      },
      message: '本次下单金额已超过本人设定的单笔限额，已暂停下单'
    }
  }

  if (rule.monthlyBudgetCents !== null && summary.spentCents + summary.reservedCents + amountCents > rule.monthlyBudgetCents) {
    return {
      decision: 'pause',
      rule,
      summary,
      pauseDetail: {
        limitType: 'monthly_budget',
        amountCents,
        limitCents: rule.monthlyBudgetCents,
        ruleVersion: rule.version,
        monthKey: summary.monthKey,
        spentCents: summary.spentCents,
        reservedCents: summary.reservedCents,
        remainingBudgetCents: summary.remainingBudgetCents
      },
      message: '本月已花与在途订单加上本次金额已超出月度预算，已暂停下单'
    }
  }

  if (!options?.hardOnly && rule.cooldownThresholdCents !== null && rule.cooldownHours !== null && amountCents >= rule.cooldownThresholdCents) {
    return {
      decision: 'cooldown',
      rule,
      summary,
      cooldownHours: rule.cooldownHours
    }
  }

  return { decision: 'pass', rule, summary }
}

export function reserve(
  db: Database,
  orderId: string,
  userId: string,
  cents: number,
  ruleVersion: number | null,
  now: number
): void {
  const mk = monthKey(now)
  db.run(
    `INSERT OR IGNORE INTO spending_reservations(order_id,user_id,month_key,cents,rule_version,state,release_reason,created_at,updated_at)
     VALUES(?,?,?,?,?,'reserved',NULL,?,?)`,
    orderId, userId, mk, cents, ruleVersion, now, now
  )
}

export function settle(db: Database, orderId: string, paidAt: number, now: number = paidAt): void {
  const mk = monthKey(paidAt)
  db.run(
    "UPDATE spending_reservations SET state='settled', month_key=?, updated_at=? WHERE order_id=? AND state='reserved'",
    mk, now, orderId
  )
}

export function release(db: Database, orderId: string, reason: string, now: number): void {
  db.run(
    "UPDATE spending_reservations SET state='released', release_reason=?, updated_at=? WHERE order_id=? AND state='reserved'",
    reason, now, orderId
  )
}

export function orderSpendingOverview(db: Database, userId: string, now: number) {
  const summary = spendingSummary(db, userId, now)
  return {
    monthKey: summary.monthKey,
    ruleVersion: summary.ruleVersion,
    enabled: summary.enabled,
    monthlyBudgetCents: summary.monthlyBudgetCents,
    spentCents: summary.spentCents,
    remainingBudgetCents: summary.remainingBudgetCents
  }
}
