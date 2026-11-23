import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { Database } from './database.ts'
import type { User } from './accounts.ts'
import { appendAudit } from './audit.ts'
import { ensure } from './errors.ts'
import { checkPublicContent } from './content-filter.ts'
import { evaluationPage } from './evaluation-page.ts'
import { localAvatarPath } from './avatar.ts'

const reasonSchema = z.object({ reason: z.enum(['广告', '辱骂', '无关内容', '泄露隐私', '其他']) })
export function replyToReview(db: Database, user: User, id: string, input: unknown, now: number) {
  ensure(user.identity==='merchant',403,'需要商家身份')
  const {content}=z.strictObject({content:z.string().trim().min(1).max(500)}).parse(input)
  checkPublicContent(content)
  const compact=content.replace(/[\s，。！、,.!?]/g,'')
  const incentive=/(补偿|退款|红包|返现|返款|返钱|优惠|赠品|赔偿|转账)/
  const alteration=/(删.{0,4}评|改.{0,4}评|撤.{0,4}评|好评)/
  ensure(!(incentive.test(compact)&&alteration.test(compact)),400,'不得以补偿换取删评或改评')
  return db.transaction(()=>{
    const row=db.one<{order_id:string}>('SELECT order_id FROM evaluations WHERE public_id=?',id)
    ensure(row,404,'评价不存在')
    const previous=db.one<{content:string}>('SELECT content FROM merchant_evaluation_replies WHERE order_id=?',row.order_id)
    if(previous) {ensure(previous.content===content,409,'这条评价已经回复');return {content}}
    db.run('INSERT INTO merchant_evaluation_replies VALUES(?,?,?,?)',row.order_id,user.id,content,now)
    return {content}
  })
}

export function merchantReviews(db: Database, user: User, productId: string, input: unknown) {
  ensure(user.identity === 'merchant', 403, '需要商家权限')
  const query = z.object({ page: z.coerce.number().int().min(1).max(1_000_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).parse(input)
  return evaluationPage(db,productId,query,user.id)
}

export function resetAvatar(db: Database, user: User, buyerId: string, input: unknown, now: number) {
  ensure(user.identity === 'merchant', 403, '需要商家权限')
  const { reason } = reasonSchema.parse(input)
  return db.transaction(() => {
    const buyer = db.one<Pick<User,'profile'|'status'>>(`SELECT u.profile,u.status FROM users u WHERE u.id=?
      AND EXISTS(SELECT 1 FROM user_identities g WHERE g.user_id=u.id AND g.identity='buyer' AND g.granted_at<=? AND g.revoked_at IS NULL)`, buyerId, now)
    ensure(buyer && buyer.status !== 'deleted', 404, '买家不存在')
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
