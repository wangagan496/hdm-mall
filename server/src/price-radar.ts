import { createHash, randomUUID } from 'node:crypto'
import type { Database } from './database.ts'
import { orderRefundableBalance } from './balance.ts'
import { currentPromotion } from './promotions.ts'
import {
  computeOrderCompensation,
  extractReturnedHash,
  loadPriceHistoryAudits,
  type OrderLineRow,
  type PolicyForCalc,
  type PriceHistoryAuditRow,
  type SkuPriceInfo
} from './compensation-calc.ts'

const DAY_MS = 86_400_000
const DRAFT_TTL_MS = 48 * 3600_000
export const RADAR_INTERVAL_MS = 5 * 60_000

interface CandidateOrderRow {
  id: string
  owner_id: string
  amount: number
  created: number
  paid_at: number
  promotion: string | null
}

interface PublishedPolicyRow extends PolicyForCalc {
  merchant_id: string
  effective_at: number
  published_at: number
}

interface PriceEventCandidateRow {
  id: string
  merchant_id: string
  goods_id: string
  sku_id: string | null
  observed_at: number
}

interface ActiveDraftRow {
  id: string
  order_id: string
  policy_id: string
  price_event_id: string
  merchant_id: string
  buyer_id: string
  capped_cents: number
  expires_at: number
  status: 'pending' | 'pending_budget'
  condition_hash: string | null
}

export interface RadarScanSummary {
  created: number
  activatedFromBudget: number
  recalculated: number
  cancelled: number
  pendingBudget: number
  expired: number
}

export function radarIdempotencyKey(orderId: string, policyId: string, priceEventId: string): string {
  return createHash('sha256').update(`${orderId}:${policyId}:${priceEventId}`).digest('hex')
}

function selectActivePolicyForTime(policies: PublishedPolicyRow[], paidAt: number): PublishedPolicyRow | null {
  for (const policy of policies) {
    if (policy.effective_at <= paidAt) return policy
  }
  return null
}

function policyRemainingBudget(db: Database, policyId: string, totalBudgetCents: number, now: number): number {
  const used = db.one<{ total: number }>(
    "SELECT COALESCE(SUM(confirmed_cents),0) AS total FROM compensation_receipts WHERE policy_id=? AND channel_status<>'failed'",
    policyId
  )!.total
  const reserved = db.one<{ total: number }>(
    "SELECT COALESCE(SUM(capped_cents),0) AS total FROM compensation_drafts WHERE policy_id=? AND status='pending' AND expires_at>?",
    policyId, now
  )!.total
  return Math.max(0, totalBudgetCents - used - reserved)
}

function invalidateDraft(db: Database, draftId: string): void {
  db.run(
    "UPDATE compensation_drafts SET status='cancelled' WHERE id=? AND status IN ('pending','pending_budget')",
    draftId
  )
}

/** 扫描活跃价保政策、每单自身保护窗口内已付订单及降价事件；统一重算、扣减已占额并及时使旧草稿失效。 */
export function runRadar(db: Database, now: number = Date.now()): RadarScanSummary {
  return db.transaction(() => {
    const expiredRes = db.run(
      "UPDATE compensation_drafts SET status='expired' WHERE status IN ('pending','pending_budget') AND expires_at<=?",
      now
    )
    const expired = Number(expiredRes.changes)

    let created = 0
    let activatedFromBudget = 0
    let recalculated = 0
    let cancelled = 0
    let pendingBudget = 0

    // 预加载已发布政策（按 published_at DESC, version DESC 排序以与 activePolicy 一致）
    const policies = db.all<PublishedPolicyRow>(
      `SELECT p.id,p.version,p.merchant_id,p.window_days,p.budget_per_order_cents,p.total_budget_cents,p.effective_at,pub.published_at
       FROM price_protection_publications pub
       JOIN price_protection_policies p ON p.id=pub.policy_id
       WHERE p.effective_at <= ?
       ORDER BY pub.published_at DESC, p.version DESC`,
      now
    )
    if (!policies.length) {
      db.run('UPDATE compensation_radar_state SET last_scan_at=MAX(last_scan_at,?) WHERE id=1', now)
      return { created, activatedFromBudget, recalculated, cancelled, pendingBudget, expired }
    }
    const policyMap = new Map(policies.map(p => [p.id, p]))
    const maxWindowDays = policies.reduce((max, p) => Math.max(max, p.window_days), 1)
    const promo = currentPromotion(db)
    const skuRows = db.all<{ id: string } & SkuPriceInfo>('SELECT id,price,enabled FROM skus')
    const skuMap = new Map<string, SkuPriceInfo>(skuRows.map(s => [s.id, { price: s.price, enabled: s.enabled }]))

    // 1. 先检查并重算所有尚未确认、未过期的存量草稿（pending / pending_budget）：
    //    若发生部分/全部退货、退件释放限制或历史凭据缺口，使旧草稿失效并按最新条件签发新草稿或停止自动签发。
    const activeDrafts = db.all<ActiveDraftRow>(
      `SELECT id,order_id,policy_id,price_event_id,merchant_id,buyer_id,capped_cents,expires_at,status,condition_hash
       FROM compensation_drafts
       WHERE status IN ('pending','pending_budget') AND expires_at > ?
       ORDER BY created_at ASC, id ASC`,
      now
    )
    let cachedAuditRows: PriceHistoryAuditRow[] | undefined
    const getAuditRows = () => {
      if (!cachedAuditRows) {
        cachedAuditRows = loadPriceHistoryAudits(db, { maxCreated: now })
      }
      return cachedAuditRows
    }

    for (const draft of activeDrafts) {
      const order = db.one<CandidateOrderRow>(
        'SELECT id,owner_id,amount,created,paid_at,promotion FROM orders WHERE id=? AND state IN (2,3,4,5) AND paid_at IS NOT NULL',
        draft.order_id
      )
      const policy = policyMap.get(draft.policy_id)
      if (!order || !policy) {
        invalidateDraft(db, draft.id)
        cancelled++
        continue
      }

      const comp = computeOrderCompensation(db, order, policy, now, {
        promo, skuMap, excludeDraftId: draft.id, auditRows: getAuditRows()
      })
      const storedReturnedHash = extractReturnedHash(draft.condition_hash)
      const returnedChanged = storedReturnedHash !== null
        ? storedReturnedHash !== comp.returnedHash
        : comp.returnedHash !== createHash('sha256').update('[]').digest('hex').slice(0, 16)
      const stale = returnedChanged || Boolean(comp.insufficientHistory) || comp.cappedCents < draft.capped_cents

      if (stale) {
        invalidateDraft(db, draft.id)
        cancelled++
        if (!comp.insufficientHistory && comp.cappedCents > 0) {
          const remainingBudget = policyRemainingBudget(db, policy.id, policy.total_budget_cents, now)
          const nextStatus = comp.cappedCents <= remainingBudget ? 'pending' : 'pending_budget'
          const newId = randomUUID()
          db.run(
            `INSERT INTO compensation_drafts(
              id,order_id,policy_id,price_event_id,merchant_id,buyer_id,
              basket_delta_cents,capped_cents,per_line,idempotency_key,created_at,expires_at,status,condition_hash
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            newId, order.id, policy.id, draft.price_event_id, draft.merchant_id, draft.buyer_id,
            Math.max(comp.cappedCents, comp.marginalBasketDeltaCents), comp.cappedCents,
            JSON.stringify(comp.perLine), radarIdempotencyKey(order.id, policy.id, draft.price_event_id),
            now, now + DRAFT_TTL_MS, nextStatus, comp.conditionHash
          )
          recalculated++
          if (nextStatus === 'pending_budget') pendingBudget++
        }
        continue
      }

      if (draft.status === 'pending_budget') {
        const remainingBudget = policyRemainingBudget(db, policy.id, policy.total_budget_cents, now)
        if (draft.capped_cents <= remainingBudget) {
          db.run(
            "UPDATE compensation_drafts SET status='pending', expires_at=? WHERE id=? AND status='pending_budget'",
            now + DRAFT_TTL_MS, draft.id
          )
          activatedFromBudget++
        }
      }
    }

    // 2. 索引裁剪候选订单与事件：只扫“曾有未扫描事件”或“当前保护窗口与 [last_scan_at, now] 相交”的已付订单
    const stateRow = db.one<{ last_scan_at: number }>('SELECT last_scan_at FROM compensation_radar_state WHERE id=1')
    const lastScanAt = stateRow?.last_scan_at ?? 0
    const earliestNewEvent = db.one<{ min_obs: number | null }>(
      'SELECT MIN(observed_at) AS min_obs FROM price_events WHERE observed_at >= ? AND observed_at <= ?',
      lastScanAt, now
    )?.min_obs
    const hasAnyEvents = earliestNewEvent !== null && earliestNewEvent !== undefined
      ? true
      : Boolean(db.one('SELECT 1 FROM price_events WHERE observed_at <= ? LIMIT 1', now))

    if (!hasAnyEvents) {
      db.run('UPDATE compensation_radar_state SET last_scan_at=? WHERE id=1', now)
      return { created, activatedFromBudget, recalculated, cancelled, pendingBudget, expired }
    }

    // 若上次扫描前已有事件未消费，或者上次停机跨窗，回退到 earliestUnconsumed；稳态下仅扫近 maxWindowDays 天订单
    const lookbackAnchor = Math.min(lastScanAt > 0 ? lastScanAt : (earliestNewEvent ?? now), earliestNewEvent ?? now)
    const minPaidAt = Math.max(0, lookbackAnchor - maxWindowDays * DAY_MS)

    const orders = db.all<CandidateOrderRow>(
      `SELECT id,owner_id,amount,created,paid_at,promotion FROM orders
       WHERE state IN (2,3,4,5) AND paid_at IS NOT NULL AND paid_at >= ?
       ORDER BY paid_at ASC, id ASC`,
      minPaidAt
    )

    if (orders.length > 0) {
      // 预取所有在窗口范围内的价格事件（按 observed_at ASC）
      const minOrderPaid = orders[0]!.paid_at
      const allEvents = db.all<PriceEventCandidateRow>(
        'SELECT id,merchant_id,goods_id,sku_id,observed_at FROM price_events WHERE observed_at >= ? AND observed_at <= ? ORDER BY observed_at ASC, rowid ASC',
        minOrderPaid, now
      )

      if (allEvents.length > 0) {
        for (const order of orders) {
          // 依据订单支付时生效的最新政策与订单自己的 window_days 判定窗口（不把 window_days 当作政策寿命）
          const policy = selectActivePolicyForTime(policies, order.paid_at)
          if (!policy) continue
          const orderWindowEnd = order.paid_at + policy.window_days * DAY_MS
          if (orderWindowEnd <= order.paid_at) continue

          const items = db.all<OrderLineRow>(
            'SELECT sku_id,product_id,price,count,discount_share FROM order_items WHERE order_id=? ORDER BY rowid ASC',
            order.id
          )
          if (!items.length) continue

          const matchedEvents = allEvents.filter(event => {
            if (event.merchant_id !== policy.merchant_id) return false
            if (event.observed_at < order.paid_at || event.observed_at >= orderWindowEnd || event.observed_at > now) return false
            return event.sku_id
              ? items.some(item => item.sku_id === event.sku_id)
              : items.some(item => item.product_id === event.goods_id)
          })
          if (!matchedEvents.length) continue

          // 先检出最新未落盘事件并查幂等 live 草稿，已存在活跃草稿时跳过重复按件重算；且避免同一订单重算两遍
          let candidateEvent: PriceEventCandidateRow | null = null
          for (let i = matchedEvents.length - 1; i >= 0; i--) {
            const event = matchedEvents[i]!
            const idempotencyKey = radarIdempotencyKey(order.id, policy.id, event.id)
            const liveExists = db.one<{ id: string }>(
              "SELECT id FROM compensation_drafts WHERE idempotency_key=? AND status<>'cancelled'",
              idempotencyKey
            )
            if (liveExists) break
            candidateEvent = event
            break
          }
          if (!candidateEvent) continue

          const bal = orderRefundableBalance(db, order.id)
          const comp = computeOrderCompensation(db, order, policy, now, { promo, skuMap, items, balance: bal, auditRows: getAuditRows() })
          if (comp.insufficientHistory || comp.cappedCents <= 0 || comp.perLine.length === 0) continue

          const idempotencyKey = radarIdempotencyKey(order.id, policy.id, candidateEvent.id)

          const remainingBudget = policyRemainingBudget(db, policy.id, policy.total_budget_cents, now)
          const status = comp.cappedCents <= remainingBudget ? 'pending' : 'pending_budget'
          if (status === 'pending_budget') pendingBudget++
          else created++

          db.run(
            `INSERT INTO compensation_drafts(
              id,order_id,policy_id,price_event_id,merchant_id,buyer_id,
              basket_delta_cents,capped_cents,per_line,idempotency_key,created_at,expires_at,status,condition_hash
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            randomUUID(), order.id, policy.id, candidateEvent.id, policy.merchant_id, order.owner_id,
            Math.max(comp.cappedCents, comp.marginalBasketDeltaCents), comp.cappedCents,
            JSON.stringify(comp.perLine), idempotencyKey, now, now + DRAFT_TTL_MS, status, comp.conditionHash
          )
        }
      }
    }

    db.run('UPDATE compensation_radar_state SET last_scan_at=? WHERE id=1', now)
    return { created, activatedFromBudget, recalculated, cancelled, pendingBudget, expired }
  })
}

export function scheduledRadarTick(db: Database, now: number = Date.now()): RadarScanSummary {
  return runRadar(db, now)
}
