import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { invoiceSchema } from './invoices.ts'
import { localAvatarPath } from './avatar.ts'
import { historicalIdentity } from './identity-backup.ts'

export function inspectServices(db: DatabaseSync, version: number) {
  const held = historicalIdentity(db, version)
  for (const invoice of db.prepare('SELECT * FROM invoices').iterate()) {
    invoiceSchema.parse({ titleType: invoice.title_type, title: invoice.title, taxId: invoice.tax_id || undefined, email: invoice.email })
    if (invoice.status === 'issued' && !held(invoice.issued_by, 'merchant', invoice.issued_at)) throw new Error('开票操作人无效')
    if (!db.prepare("SELECT id FROM audit_log WHERE action='invoice.request' AND order_id=?").get(invoice.order_id!)) throw new Error('开票登记审计缺失')
    if (invoice.status === 'issued' && !db.prepare("SELECT id FROM audit_log WHERE action='invoice.issued' AND order_id=?").get(invoice.order_id!)) throw new Error('开票标记审计缺失')
  }
  for (const row of db.prepare('SELECT order_id,hidden_by,hidden_at FROM review_moderation').iterate()) {
    if(version>=26 && db.prepare(`SELECT 1 FROM evaluations e JOIN review_dispute_actions a ON a.review_id=e.public_id
      JOIN review_dispute_conclusions c ON c.action_id=a.id WHERE e.order_id=? AND c.hidden=1 AND a.actor_id=? AND a.created=?`)
      .get(row.order_id!,row.hidden_by!,row.hidden_at!)) continue
    if (!held(row.hidden_by, 'merchant', row.hidden_at)) throw new Error('评价隐藏操作人无效')
  }
  for (const thread of db.prepare(`SELECT t.buyer_id,t.created, (t.buyer_read_id=0 OR EXISTS
    (SELECT 1 FROM service_messages m WHERE m.id=t.buyer_read_id AND m.buyer_id=t.buyer_id)) read_valid FROM service_threads t`).iterate()) {
    if (thread.read_valid !== 1 || !held(thread.buyer_id, 'buyer', thread.created)) throw new Error('留言会话或已读位置无效')
  }
  for (const row of db.prepare('SELECT m.*,o.owner_id FROM service_messages m LEFT JOIN orders o ON o.id=m.order_id').iterate()) {
    if (!held(row.sender_id, row.sender_kind, row.created) || row.sender_kind === 'buyer' && row.sender_id !== row.buyer_id || row.order_id !== null && row.owner_id !== row.buyer_id) throw new Error('留言操作人或关联订单无效')
    const images = db.prepare('SELECT path FROM service_images WHERE message_id=? ORDER BY path').all(row.id!).map(image => String(image.path))
    if (images.length > 3) throw new Error('留言照片超过三张')
    const hash = createHash('sha256').update(JSON.stringify({ buyerId: row.buyer_id, content: row.content, orderId: row.order_id, images })).digest('hex')
    if (row.request_hash !== hash) throw new Error('留言幂等回执无效')
  }
  if (db.prepare(`SELECT i.image_id FROM service_images i JOIN service_messages m ON m.id=i.message_id
    WHERE i.buyer_id<>m.buyer_id OR i.uploader_id<>m.sender_id`).get()) throw new Error('留言照片归属无效')
  return db.prepare('SELECT image_id,path,sha256 FROM service_images').all().map(row => {
    const path = localAvatarPath(row.path)
    if (!path || path !== '/uploads/' + row.image_id + '.jpg' || !/^[a-f0-9]{64}$/.test(String(row.sha256))) throw new Error('留言照片登记无效')
    return { path: path.slice(1), imageId: String(row.image_id), sha256: String(row.sha256) }
  })
}
