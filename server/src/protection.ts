import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Database } from './database.ts'
import type { User } from './accounts.ts'
import { ensure } from './errors.ts'
import { appendAudit } from './audit.ts'

export interface PolicyBrief {
  policyId: string
  windowDays: number
  budgetPerOrderCents: number
  effectiveAt: number
  announcedAt: number
  receiptId: string
}

interface PolicyRow {
  id: string; version: number; merchant_id: string; acting_identity: string
  window_days: number; budget_per_order_cents: number; total_budget_cents: number
  announced_at: number; effective_at: number; request_key: string
}
interface ConfirmRow {
  token_hash: string; policy_id: string; merchant_id: string; acting_identity: string
  identity_subject: string; policy_hash: string; created_at: number; expires_at: number; used_at: number | null
}
interface PublicationRow {
  receipt_id: string; token_hash: string; policy_id: string; merchant_id: string
  acting_identity: string; request_key: string; published_at: number
}

const CONFIRM_WINDOW_MS = 15 * 60_000

function requireMerchant(user: User) { ensure(user.identity === 'merchant', 403, '需要商家权限') }

function policyHash(row: { window_days: number; budget_per_order_cents: number; total_budget_cents: number; effective_at: number; announced_at: number }): string {
  return createHash('sha256').update(JSON.stringify([
    row.window_days, row.budget_per_order_cents, row.total_budget_cents, row.effective_at, row.announced_at
  ])).digest('hex')
}

function identitySubject(user: User): string {
  return createHash('sha256').update(JSON.stringify(['protection', user.id, user.identity, user.identityRevision])).digest('hex')
}

export const draftSchema = z.object({
  requestKey: z.string().uuid(),
  windowDays: z.number().int().min(1).max(90),
  budgetPerOrderCents: z.number().int().min(1).max(2147483647),
  totalBudgetCents: z.number().int().min(1).max(2147483647),
  effectiveAtOffset: z.number().int().min(86400).max(30 * 86400),
}).strict().refine(v => v.totalBudgetCents >= v.budgetPerOrderCents, { message: '总预算不得低于单笔上限' })

export const confirmSchema = z.object({
  policyId: z.string().uuid(),
  policyHash: z.string().length(64),
}).strict()

export const publishSchema = z.object({
  token: z.string().uuid(),
  policyId: z.string().uuid(),
  requestKey: z.string().uuid(),
}).strict()

export function draftPolicy(db: Database, user: User, input: unknown, now: number): { policyId: string; policyHash: string } {
  requireMerchant(user)
  const data = draftSchema.parse(input)
  const existing = db.one<PolicyRow>('SELECT * FROM price_protection_policies WHERE merchant_id=? AND request_key=?', user.id, data.requestKey)
  if (existing) return { policyId: existing.id, policyHash: policyHash(existing) }
  const prevVersion = db.one<{ version: number }>('SELECT MAX(version) AS version FROM price_protection_policies WHERE merchant_id=?', user.id)
  const version = (prevVersion?.version ?? 0) + 1
  const id = randomUUID()
  const announcedAt = now
  const effectiveAt = now + data.effectiveAtOffset * 1000
  db.run(
    'INSERT INTO price_protection_policies(id,version,merchant_id,acting_identity,window_days,budget_per_order_cents,total_budget_cents,announced_at,effective_at,request_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
    id, version, user.id, user.identity, data.windowDays, data.budgetPerOrderCents, data.totalBudgetCents, announcedAt, effectiveAt, data.requestKey
  )
  const row = db.one<PolicyRow>('SELECT * FROM price_protection_policies WHERE id=?', id)!
  return { policyId: id, policyHash: policyHash(row) }
}

export function issueConfirmToken(db: Database, user: User, input: unknown, now: number): { token: string } {
  requireMerchant(user)
  const data = confirmSchema.parse(input)
  const policy = db.one<PolicyRow>('SELECT * FROM price_protection_policies WHERE id=?', data.policyId)
  ensure(policy, 404, '价保政策不存在')
  ensure(policy.merchant_id === user.id, 403, '无权操作该政策')
  ensure(policyHash(policy) === data.policyHash, 409, '政策内容已变化，请重新核对')
  ensure(!db.one('SELECT 1 FROM price_protection_publications WHERE policy_id=?', data.policyId), 409, '该版本已发布')
  const token = randomUUID()
  const tokenHashHex = createHash('sha256').update(token).digest('hex')
  db.run(
    'INSERT INTO price_protection_confirmations(token_hash,policy_id,merchant_id,acting_identity,identity_subject,policy_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',
    tokenHashHex, data.policyId, user.id, user.identity, identitySubject(user), data.policyHash, now, now + CONFIRM_WINDOW_MS
  )
  return { token }
}

export function publishPolicy(db: Database, user: User, input: unknown, now: number): { receiptId: string; policyId: string; publishedAt: number } {
  requireMerchant(user)
  const data = publishSchema.parse(input)
  return db.transaction(() => {
    const existing = db.one<PublicationRow>('SELECT * FROM price_protection_publications WHERE merchant_id=? AND request_key=?', user.id, data.requestKey)
    if (existing) return { receiptId: existing.receipt_id, policyId: existing.policy_id, publishedAt: existing.published_at }
    const tokenHashHex = createHash('sha256').update(data.token).digest('hex')
    const conf = db.one<ConfirmRow>('SELECT * FROM price_protection_confirmations WHERE token_hash=?', tokenHashHex)
    ensure(conf, 403, '确认凭据无效')
    ensure(conf.merchant_id === user.id, 403, '无权使用该凭据')
    ensure(conf.acting_identity === 'merchant', 403, '需要商家身份')
    ensure(conf.identity_subject === identitySubject(user), 403, '身份已变更，请重新发起确认')
    ensure(conf.policy_id === data.policyId, 409, '凭据与政策不匹配')
    ensure(conf.used_at === null, 409, '凭据已使用')
    ensure(now < conf.expires_at, 403, '确认凭据已过期，请重新发起')
    ensure(!db.one('SELECT 1 FROM price_protection_publications WHERE policy_id=?', data.policyId), 409, '该版本已发布')
    const receiptId = randomUUID()
    db.run('UPDATE price_protection_confirmations SET used_at=? WHERE token_hash=?', now, tokenHashHex)
    db.run(
      'INSERT INTO price_protection_publications(receipt_id,token_hash,policy_id,merchant_id,acting_identity,request_key,published_at) VALUES(?,?,?,?,?,?,?)',
      receiptId, tokenHashHex, data.policyId, user.id, user.identity, data.requestKey, now
    )
    appendAudit(db, { created: now, actor: user, action: 'promotion.edit', targetType: 'settings', targetId: 'price-protection',
      requestKey: data.requestKey, summary: { note: `发布价保版本 policy_id=${data.policyId}` } })
    return { receiptId, policyId: data.policyId, publishedAt: now }
  })
}

export function activePolicy(db: Database, now: number): (PolicyRow & { receipt_id: string }) | null {
  return db.one<PolicyRow & { receipt_id: string }>(
    `SELECT p.*, pub.receipt_id FROM price_protection_publications pub
     JOIN price_protection_policies p ON p.id=pub.policy_id
     WHERE p.effective_at <= ? ORDER BY pub.published_at DESC, p.version DESC LIMIT 1`, now
  ) ?? null
}

export function policyBrief(policy: PolicyRow & { receipt_id: string }): PolicyBrief {
  return { policyId: policy.id, windowDays: policy.window_days,
    budgetPerOrderCents: policy.budget_per_order_cents,
    effectiveAt: policy.effective_at, announcedAt: policy.announced_at, receiptId: policy.receipt_id }
}

export function merchantPolicyList(db: Database, user: User): Array<{ policyId: string; version: number; windowDays: number; budgetPerOrderCents: number; totalBudgetCents: number; announcedAt: number; effectiveAt: number; published: boolean; receiptId: string | null }> {
  requireMerchant(user)
  const rows = db.all<PolicyRow & { receipt_id: string | null }>(
    `SELECT p.*, pub.receipt_id FROM price_protection_policies p
     LEFT JOIN price_protection_publications pub ON pub.policy_id=p.id
     WHERE p.merchant_id=? ORDER BY p.version DESC LIMIT 10`, user.id
  )
  return rows.map(r => ({ policyId: r.id, version: r.version, windowDays: r.window_days,
    budgetPerOrderCents: r.budget_per_order_cents, totalBudgetCents: r.total_budget_cents,
    announcedAt: r.announced_at, effectiveAt: r.effective_at,
    published: r.receipt_id !== null, receiptId: r.receipt_id }))
}
