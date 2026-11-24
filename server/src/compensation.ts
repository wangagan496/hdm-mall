import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { User } from './accounts.ts'
import { appendAudit } from './audit.ts'
import { orderRefundableBalance } from './balance.ts'
import { computeOrderCompensation, extractReturnedHash, type PerLineDelta } from './compensation-calc.ts'
import type { Database } from './database.ts'
import { AppError, ensure } from './errors.ts'
import { radarIdempotencyKey } from './price-radar.ts'

const DRAFT_TTL_MS = 48 * 3600_000

export const confirmSchema = z.object({
  draftId: z.string().uuid(),
  requestKey: z.string().uuid(),
  confirmedCents: z.number().int().min(1).max(2147483647),
}).strict()

interface DraftJoinRow {
  id: string
  order_id: string
  policy_id: string
  price_event_id: string
  merchant_id: string
  buyer_id: string
  basket_delta_cents: number
  capped_cents: number
  per_line: string
  idempotency_key: string
  created_at: number
  expires_at: number
  status: 'pending' | 'pending_budget' | 'confirmed' | 'expired' | 'cancelled'
  condition_hash: string | null
  policy_version: number
  window_days: number
  budget_per_order_cents: number
  total_budget_cents: number
}

interface ReceiptRow {
  receipt_id: string
  draft_id: string
  order_id: string
  policy_id: string
  buyer_id: string
  confirmed_cents: number
  request_key: string
  confirmed_at: number
  channel_status: 'pending' | 'executed' | 'failed' | 'unknown'
  channel_ref: string | null
}

export interface CompensationDraftBrief {
  draftId: string
  orderId: string
  policyId: string
  policyVersion: number
  windowDays: number
  budgetPerOrderCents: number
  basketDeltaCents: number
  cappedCents: number
  perLine: PerLineDelta[]
  createdAt: number
  expiresAt: number
  status: string
}

export interface CompensationReceiptView {
  receiptId: string
  draftId: string
  orderId: string
  policyId: string
  policyVersion: number
  windowDays: number
  confirmedCents: number
  confirmedAt: number
  channelStatus: 'pending' | 'executed' | 'failed' | 'unknown'
  channelRef: string | null
  statusLabel: string
}

export function compensationStatusLabel(status: ReceiptRow['channel_status']): string {
  if (status === 'executed') return '补差已到账'
  if (status === 'failed') return '补差执行失败'
  if (status === 'unknown') return '待执行（渠道结果待核实）'
  return '补差已登记，渠道处理中'
}

function presentDraft(row: DraftJoinRow): CompensationDraftBrief {
  return {
    draftId: row.id,
    orderId: row.order_id,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    windowDays: row.window_days,
    budgetPerOrderCents: row.budget_per_order_cents,
    basketDeltaCents: row.basket_delta_cents,
    cappedCents: row.capped_cents,
    perLine: JSON.parse(row.per_line) as PerLineDelta[],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status
  }
}

function presentReceipt(row: ReceiptRow, policyVersion: number, windowDays: number): CompensationReceiptView {
  return {
    receiptId: row.receipt_id,
    draftId: row.draft_id,
    orderId: row.order_id,
    policyId: row.policy_id,
    policyVersion,
    windowDays,
    confirmedCents: row.confirmed_cents,
    confirmedAt: row.confirmed_at,
    channelStatus: row.channel_status,
    channelRef: row.channel_ref,
    statusLabel: compensationStatusLabel(row.channel_status)
  }
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

/** 买家一键确认补差：事务内校验身份/状态/过期/金额/实时退件与价格条件绑定/R+C+U<=F 余额，条件变化时落库失效并拒绝旧金额。 */
export function confirmCompensation(
  db: Database,
  user: User,
  draftId: string,
  requestKey: string,
  confirmedCents: number,
  now: number
): CompensationReceiptView {
  ensure(user.identity === 'buyer', 403, '需要买家身份')
  const parsed = confirmSchema.parse({ draftId, requestKey, confirmedCents })

  const outcome = db.transaction((): { receipt: CompensationReceiptView } | { error: AppError } => {
    const draft = db.one<DraftJoinRow>(
      `SELECT d.*, p.version AS policy_version, p.window_days, p.budget_per_order_cents, p.total_budget_cents
       FROM compensation_drafts d
       JOIN price_protection_policies p ON p.id=d.policy_id
       WHERE d.id=?`,
      parsed.draftId
    )
    ensure(draft, 404, '补差草稿不存在')
    ensure(draft.buyer_id === user.id, 403, '只有订单买家本人可以确认补差')

    const existing = db.one<ReceiptRow>(
      'SELECT * FROM compensation_receipts WHERE order_id=? AND request_key=?',
      draft.order_id, parsed.requestKey
    )
    if (existing) {
      ensure(
        existing.buyer_id === user.id && existing.draft_id === draft.id && existing.confirmed_cents === parsed.confirmedCents,
        409,
        '本次确认参数与原请求不一致'
      )
      return { receipt: presentReceipt(existing, draft.policy_version, draft.window_days) }
    }

    ensure(draft.status !== 'pending_budget', 409, '价保总预算不足，暂不可确认')
    if (draft.status === 'expired' || draft.expires_at <= now) {
      if (draft.status === 'pending') {
        db.run("UPDATE compensation_drafts SET status='expired' WHERE id=?", draft.id)
      }
      return { error: new AppError(403, '补差草稿已过期，请刷新重算', 'COMPENSATION_DRAFT_EXPIRED') }
    }
    ensure(draft.status === 'pending', 409, '该补差草稿已确认或已失效')
    ensure(parsed.confirmedCents === draft.capped_cents, 400, '补差金额已变化，请刷新重算')

    const order = db.one<{ id: string; owner_id: string; state: number; amount: number; created: number; paid_at: number | null; promotion: string | null }>(
      'SELECT id,owner_id,state,amount,created,paid_at,promotion FROM orders WHERE id=?',
      draft.order_id
    )
    ensure(order && order.owner_id === user.id && [2, 3, 4, 5].includes(order.state) && order.paid_at !== null, 409, '订单当前状态不可补差')

    // 事务内重验实付/退款/退件/历史凭据链路/政策版本条件绑定：退件或历史缺口导致旧金额不成立时撤销旧草稿并提示重确认或人工核对
    const bal = orderRefundableBalance(db, order.id)
    const fresh = computeOrderCompensation(
      db,
      order,
      {
        id: draft.policy_id,
        version: draft.policy_version,
        window_days: draft.window_days,
        budget_per_order_cents: draft.budget_per_order_cents,
        total_budget_cents: draft.total_budget_cents
      },
      now,
      { excludeDraftId: draft.id, balance: bal }
    )
    if (fresh.insufficientHistory) {
      db.run("UPDATE compensation_drafts SET status='cancelled' WHERE id=? AND status='pending'", draft.id)
      return { error: new AppError(409, '历史价格或优惠凭证不足，暂不可自动确认，已转人工核对', 'COMPENSATION_CONDITION_CHANGED') }
    }
    const storedReturnedHash = extractReturnedHash(draft.condition_hash)
    const emptyReturnedHash = createHash('sha256').update('[]').digest('hex').slice(0, 16)
    const returnedChanged = storedReturnedHash !== null
      ? storedReturnedHash !== fresh.returnedHash
      : fresh.returnedHash !== emptyReturnedHash
    if (returnedChanged || fresh.cappedCents < draft.capped_cents) {
      db.run("UPDATE compensation_drafts SET status='cancelled' WHERE id=? AND status='pending'", draft.id)
      if (fresh.cappedCents > 0 && fresh.perLine.length > 0) {
        const remainingBudget = policyRemainingBudget(db, draft.policy_id, draft.total_budget_cents, now)
        const nextStatus = fresh.cappedCents <= remainingBudget ? 'pending' : 'pending_budget'
        const ikey = radarIdempotencyKey(order.id, draft.policy_id, draft.price_event_id)
        const live = db.one<{ id: string }>(
          "SELECT id FROM compensation_drafts WHERE idempotency_key=? AND status<>'cancelled'",
          ikey
        )
        if (!live) {
          db.run(
            `INSERT INTO compensation_drafts(
              id,order_id,policy_id,price_event_id,merchant_id,buyer_id,
              basket_delta_cents,capped_cents,per_line,idempotency_key,created_at,expires_at,status,condition_hash
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            randomUUID(), order.id, draft.policy_id, draft.price_event_id, draft.merchant_id, draft.buyer_id,
            Math.max(fresh.cappedCents, fresh.marginalBasketDeltaCents), fresh.cappedCents,
            JSON.stringify(fresh.perLine), ikey, now, Math.max(draft.expires_at, now + DRAFT_TTL_MS), nextStatus, fresh.conditionHash
          )
        }
      }
      return { error: new AppError(409, '订单商品或价格条件已变化，已为您重算补差金额，请刷新后确认', 'COMPENSATION_CONDITION_CHANGED') }
    }

    // 同一核心事务强制 R + C + U + 本次补差 <= F 且同单非失败补差总额不超过单笔上限（退件不释放上限）
    ensure(draft.capped_cents <= bal.remainingCents, 409, '补差金额超过订单可退余额')
    ensure(bal.compensatedCents + draft.capped_cents <= draft.budget_per_order_cents, 409, '补差金额超过本单累计价保上限')

    const policyUsed = db.one<{ total: number }>(
      "SELECT COALESCE(SUM(confirmed_cents),0) AS total FROM compensation_receipts WHERE policy_id=? AND channel_status<>'failed'",
      draft.policy_id
    )!.total
    ensure(policyUsed + draft.capped_cents <= draft.total_budget_cents, 409, '价保活动总预算已用尽')

    const receiptId = randomUUID()
    db.run(
      `INSERT INTO compensation_receipts(receipt_id,draft_id,order_id,policy_id,buyer_id,confirmed_cents,request_key,confirmed_at,channel_status,channel_ref)
       VALUES(?,?,?,?,?,?,?,?,'pending',NULL)`,
      receiptId, draft.id, draft.order_id, draft.policy_id, user.id, draft.capped_cents, parsed.requestKey, now
    )
    const updated = db.run("UPDATE compensation_drafts SET status='confirmed' WHERE id=? AND status='pending'", draft.id)
    ensure(updated.changes === 1, 409, '该补差草稿状态已变更，请刷新')

    appendAudit(db, {
      created: now,
      actor: user,
      action: 'compensation.confirm',
      targetType: 'order',
      targetId: draft.order_id,
      orderId: draft.order_id,
      requestKey: parsed.requestKey,
      summary: { amountCents: draft.capped_cents, note: `买家确认价保补差 draft=${draft.id}` }
    })

    const saved = db.one<ReceiptRow>('SELECT * FROM compensation_receipts WHERE receipt_id=?', receiptId)!
    return { receipt: presentReceipt(saved, draft.policy_version, draft.window_days) }
  })

  if ('error' in outcome) throw outcome.error
  return outcome.receipt
}

export function listBuyerDrafts(db: Database, userId: string, orderId?: string, now: number = Date.now()): CompensationDraftBrief[] {
  if (orderId) {
    const order = db.one<{ owner_id: string }>('SELECT owner_id FROM orders WHERE id=?', orderId)
    ensure(order, 404, '订单不存在')
    ensure(order.owner_id === userId, 403, '无权查看他人订单的补差草稿')
    return db.all<DraftJoinRow>(
      `SELECT d.*, p.version AS policy_version, p.window_days, p.budget_per_order_cents, p.total_budget_cents
       FROM compensation_drafts d
       JOIN price_protection_policies p ON p.id=d.policy_id
       WHERE d.buyer_id=? AND d.order_id=? AND d.status='pending' AND d.expires_at>?
       ORDER BY d.created_at DESC, d.id DESC`,
      userId, orderId, now
    ).map(presentDraft)
  }
  return db.all<DraftJoinRow>(
    `SELECT d.*, p.version AS policy_version, p.window_days, p.budget_per_order_cents, p.total_budget_cents
     FROM compensation_drafts d
     JOIN price_protection_policies p ON p.id=d.policy_id
     WHERE d.buyer_id=? AND d.status='pending' AND d.expires_at>?
     ORDER BY d.created_at DESC, d.id DESC`,
    userId, now
  ).map(presentDraft)
}

export function getDraftDetail(db: Database, userId: string, draftId: string): CompensationDraftBrief {
  const row = db.one<DraftJoinRow>(
    `SELECT d.*, p.version AS policy_version, p.window_days, p.budget_per_order_cents, p.total_budget_cents
     FROM compensation_drafts d
     JOIN price_protection_policies p ON p.id=d.policy_id
     WHERE d.id=?`,
    draftId
  )
  ensure(row, 404, '补差草稿不存在')
  ensure(row.buyer_id === userId, 403, '无权查看该补差草稿')
  return presentDraft(row)
}

export function getReceipt(db: Database, userId: string, receiptId: string): CompensationReceiptView {
  const row = db.one<ReceiptRow & { policy_version: number; window_days: number }>(
    `SELECT r.*, p.version AS policy_version, p.window_days
     FROM compensation_receipts r
     JOIN price_protection_policies p ON p.id=r.policy_id
     WHERE r.receipt_id=?`,
    receiptId
  )
  ensure(row, 404, '补差回执不存在')
  ensure(row.buyer_id === userId, 403, '无权查看该补差回执')
  return presentReceipt(row, row.policy_version, row.window_days)
}

export function listOrderCompensationReceipts(db: Database, userId: string, orderId: string): CompensationReceiptView[] {
  return db.all<ReceiptRow & { policy_version: number; window_days: number }>(
    `SELECT r.*, p.version AS policy_version, p.window_days
     FROM compensation_receipts r
     JOIN price_protection_policies p ON p.id=r.policy_id
     WHERE r.order_id=? AND r.buyer_id=?
     ORDER BY r.confirmed_at DESC, r.receipt_id DESC`,
    orderId, userId
  ).map(row => presentReceipt(row, row.policy_version, row.window_days))
}
