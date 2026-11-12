import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { invoiceSchema } from './invoices.ts'
import { localAvatarPath } from './avatar.ts'

export function inspectServices(db: DatabaseSync) {
  for (const invoice of db.prepare('SELECT i.*,u.role FROM invoices i LEFT JOIN users u ON u.id=i.issued_by').iterate()) {
    invoiceSchema.parse({ titleType: invoice.title_type, title: invoice.title, taxId: invoice.tax_id || undefined, email: invoice.email })
    if (invoice.status === 'issued' && invoice.role !== 'merchant') throw new Error('开票操作人无效')
    if (!db.prepare("SELECT id FROM audit_log WHERE action='invoice.request' AND order_id=?").get(invoice.order_id!)) throw new Error('开票登记审计缺失')
    if (invoice.status === 'issued' && !db.prepare("SELECT id FROM audit_log WHERE action='invoice.issued' AND order_id=?").get(invoice.order_id!)) throw new Error('开票标记审计缺失')
  }
  if (db.prepare("SELECT m.order_id FROM review_moderation m JOIN users u ON u.id=m.hidden_by WHERE u.role<>'merchant'").get()) throw new Error('评价隐藏操作人无效')
  if (db.prepare(`SELECT t.buyer_id FROM service_threads t JOIN users u ON u.id=t.buyer_id WHERE u.role<>'buyer' OR
    (t.buyer_read_id<>0 AND NOT EXISTS(SELECT 1 FROM service_messages m WHERE m.id=t.buyer_read_id AND m.buyer_id=t.buyer_id))`).get()) throw new Error('留言会话或已读位置无效')
  for (const row of db.prepare(`SELECT m.*,u.role,o.owner_id FROM service_messages m JOIN users u ON u.id=m.sender_id
    LEFT JOIN orders o ON o.id=m.order_id`).iterate()) {
    if (row.role !== row.sender_kind || row.sender_kind === 'buyer' && row.sender_id !== row.buyer_id || row.order_id !== null && row.owner_id !== row.buyer_id) throw new Error('留言操作人或关联订单无效')
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
