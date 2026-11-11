import type { Database } from './database.ts'
import { z } from 'zod'
import type { User } from './accounts.ts'
import { ensure } from './errors.ts'
import { appendAudit } from './audit.ts'

export interface Promotion {
  thresholdCents: number
  discountCents: number
  enabled: boolean
  revision: number
}

export function currentPromotion(db: Database): Promotion {
  const row = db.one<{ threshold: number; discount: number; enabled: number; revision: number }>('SELECT * FROM promotions WHERE id=1')!
  return { thresholdCents: row.threshold, discountCents: row.discount, enabled: row.enabled === 1, revision: row.revision }
}

export function promotionQuote(db: Database, subtotal: number) {
  const rule = currentPromotion(db)
  const discountCents = rule.enabled && subtotal >= rule.thresholdCents ? rule.discountCents : 0
  return { rule, discountCents, amountCents: subtotal - discountCents,
    remainingCents: rule.enabled ? Math.max(0, rule.thresholdCents - subtotal) : 0 }
}

export function discountShares(amounts: number[], discount: number, counts: number[] = amounts.map(() => 1)): number[] {
  const total = amounts.reduce((sum, amount) => sum + amount, 0)
  let cumulative = 0, allocated = 0
  const shares = amounts.map((amount, index) => {
    cumulative += amount
    const next = index === amounts.length - 1 ? discount : Number(BigInt(cumulative) * BigInt(discount) / BigInt(total))
    const share = next - allocated
    allocated = next
    return share
  })
  const limits = amounts.map((amount, index) => Math.max(0, amount - (counts[index] ?? 1)))
  let excess = 0
  for (let index = 0; index < shares.length; index++) {
    if (shares[index]! > limits[index]!) {
      excess += shares[index]! - limits[index]!
      shares[index] = limits[index]!
    }
  }
  const priority = amounts.map((amount, index) => ({ amount, index })).sort((a, b) => b.amount - a.amount || a.index - b.index)
  for (const row of priority) {
    const added = Math.min(excess, limits[row.index]! - shares[row.index]!)
    shares[row.index]! += added
    excess -= added
  }
  for (const row of priority) {
    if (!excess) break
    const added = Math.min(excess, amounts[row.index]! - shares[row.index]!)
    shares[row.index]! += added
    excess -= added
  }
  return shares
}

const editSchema = z.object({ requestKey: z.string().uuid(), expectedRevision: z.number().int().positive().safe(),
  thresholdCents: z.number().int().min(1).max(2147483647), discountCents: z.number().int().positive().max(2147483646), enabled: z.boolean()
}).strict().refine(value => value.discountCents < value.thresholdCents)

export function editPromotion(db: Database, user: User, input: unknown, now: number): Promotion {
  ensure(user.role === 'merchant', 403, '需要商家权限')
  const data = editSchema.parse(input)
  const body = JSON.stringify(data)
  return db.transaction(() => {
    const previous = db.one<{ actor_id: string; request_body: string; result: string }>('SELECT * FROM promotion_changes WHERE request_key=?', data.requestKey)
    if (previous) {
      ensure(previous.actor_id === user.id && previous.request_body === body, 409, '本次修改内容已变化，请刷新后重试')
      return JSON.parse(previous.result) as Promotion
    }
    const current = currentPromotion(db)
    ensure(current.revision === data.expectedRevision, 409, '满减规则已更新，请刷新后再修改')
    db.run('UPDATE promotions SET threshold=?,discount=?,enabled=?,revision=revision+1 WHERE id=1', data.thresholdCents, data.discountCents, Number(data.enabled))
    const result = currentPromotion(db)
    db.run('INSERT INTO promotion_changes VALUES(?,?,?,?,?)', data.requestKey, user.id, body, JSON.stringify(result), now)
    appendAudit(db, { created: now, actor: user, action: 'promotion.edit', targetType: 'settings', targetId: 'promotion', requestKey: data.requestKey,
      summary: { before: JSON.stringify(current), after: JSON.stringify(result) } })
    return result
  })
}
