import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { Database } from './database.ts'
import type { User } from './accounts.ts'
import { appendAudit } from './audit.ts'
import { ensure } from './errors.ts'
import { localAvatarPath } from './avatar.ts'

const reasonSchema = z.object({ reason: z.enum(['广告', '辱骂', '无关内容', '泄露隐私', '其他']) })
export function hideReview(db: Database, user: User, orderId: string, input: unknown, now: number) {
  ensure(user.role === 'merchant', 403, '需要商家权限')
  const { reason } = reasonSchema.parse(input)
  return db.transaction(() => {
    ensure(db.one('SELECT order_id FROM evaluations WHERE order_id=?', orderId), 404, '评价不存在')
    const current = db.one<{ reason: string }>('SELECT reason FROM review_moderation WHERE order_id=?', orderId)
    if (current?.reason === reason) return { orderId, hiddenReason: reason }
    db.run(`INSERT INTO review_moderation(order_id,reason,hidden_at,hidden_by) VALUES(?,?,?,?)
      ON CONFLICT(order_id) DO UPDATE SET reason=excluded.reason,hidden_at=excluded.hidden_at,hidden_by=excluded.hidden_by`, orderId, reason, now, user.id)
    appendAudit(db, { created: now, actor: user, action: 'review.hide', targetType: 'order', targetId: orderId, orderId, summary: { reason } })
    return { orderId, hiddenReason: reason }
  })
}

export function merchantReviews(db: Database, user: User, productId: string, input: unknown) {
  ensure(user.role === 'merchant', 403, '需要商家权限')
  const query = z.object({ page: z.coerce.number().int().min(1).max(1_000_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).parse(input)
  const from = `FROM evaluations e JOIN orders o ON o.id=e.order_id JOIN users u ON u.id=o.owner_id
    LEFT JOIN review_moderation m ON m.order_id=e.order_id
    WHERE EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=e.order_id AND i.product_id=?)`
  const counts = db.one<{ n: number }>(`SELECT COUNT(*) n ${from}`, productId)!.n
  const items = db.all(`SELECT e.order_id id,e.score,e.content,e.created createdAt,o.owner_id buyerId,
    CASE WHEN u.status='deleted' THEN '已注销用户' ELSE u.nickname END nickname,
    COALESCE(json_extract(u.profile,'$.avatar'),'') avatar,m.reason hiddenReason ${from}
    ORDER BY e.created DESC,e.order_id ASC LIMIT ? OFFSET ?`, productId, query.pageSize, (query.page - 1) * query.pageSize)
  return { items, counts, pages: Math.ceil(counts / query.pageSize), ...query }
}

export function resetAvatar(db: Database, user: User, buyerId: string, input: unknown, now: number) {
  ensure(user.role === 'merchant', 403, '需要商家权限')
  const { reason } = reasonSchema.parse(input)
  return db.transaction(() => {
    const buyer = db.one<User>('SELECT * FROM users WHERE id=?', buyerId)
    ensure(buyer && buyer.status !== 'deleted' && buyer.role === 'buyer', 404, '买家不存在')
    const profile = JSON.parse(buyer.profile)
    if (!profile.avatar) return { avatar: '' }
    const path = localAvatarPath(profile.avatar)
    if (path) db.run('INSERT OR IGNORE INTO account_file_deletions VALUES(?,?)', path, now)
    profile.avatar = ''
    db.run('UPDATE users SET profile=? WHERE id=?', JSON.stringify(profile), buyerId)
    db.run('INSERT INTO account_notices VALUES(?,?,?,?)', randomUUID(), buyerId, `头像已恢复默认：${reason}，你可以重新上传合适的头像`, now)
    appendAudit(db, { created: now, actor: user, action: 'avatar.reset', targetType: 'settings', targetId: buyerId, summary: { reason } })
    return { avatar: '' }
  })
}
