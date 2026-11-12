import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Database } from './database.ts'
import type { User } from './accounts.ts'
import type { Clock } from './clock.ts'
import { ensure } from './errors.ts'

const messageSchema = z.object({ requestKey: z.string().uuid(), content: z.string().trim().refine(value => Array.from(value).length >= 1 && Array.from(value).length <= 500),
  orderId: z.string().uuid().optional(), images: z.array(z.string().regex(/^\/uploads\/[a-f0-9-]{36}\.jpg$/)).max(3).default([]) })
  .refine(data => new Set(data.images).size === data.images.length)
interface MessageRow { id: number; buyer_id: string; sender_id: string; sender_kind: string; order_id: string | null; content: string; created: number; request_hash: string }

export class ServiceMessages {
  readonly db: Database
  readonly clock: Clock
  constructor(db: Database, clock: Clock) { this.db = db; this.clock = clock }
  private authorize(user: User, buyerId: string) {
    ensure(user.id === buyerId || user.role === 'merchant', 403, '只能查看自己的留言')
  }
  private present(row: MessageRow) {
    const images = this.db.all<{ path: string }>('SELECT path FROM service_images WHERE message_id=? ORDER BY created,image_id', row.id).map(image => image.path)
    // 买家和商家看到的是“哪件商品、哪天下的单”，不是订单编号。
    const order = row.order_id ? this.db.one<{ name: string | null; created: number }>(
      'SELECT (SELECT name FROM order_items WHERE order_id=o.id ORDER BY rowid LIMIT 1) name,o.created FROM orders o WHERE o.id=?', row.order_id) : undefined
    return { id: row.id, buyerId: row.buyer_id, sender: row.sender_kind, orderId: row.order_id, orderName: order?.name ?? null,
      orderCreatedAt: order?.created ?? null, content: row.content, createdAt: row.created, images }
  }
  send(user: User, buyerId: string, input: unknown) {
    this.authorize(user, buyerId)
    ensure(user.role === 'buyer' || user.id !== buyerId, 400, '请选择需要回复的买家')
    const data = messageSchema.parse(input)
    const hash = createHash('sha256').update(JSON.stringify({ buyerId, content: data.content, orderId: data.orderId ?? null, images: [...data.images].sort() })).digest('hex')
    return this.db.transaction(() => {
      const existing = this.db.one<MessageRow>('SELECT * FROM service_messages WHERE sender_id=? AND request_key=?', user.id, data.requestKey)
      if (existing) {
        ensure(existing.request_hash === hash, 409, '同一次发送不能修改内容，请重新发送')
        return this.present(existing)
      }
      if (data.orderId) {
        const order = this.db.one<{ owner_id: string }>('SELECT owner_id FROM orders WHERE id=?', data.orderId)
        ensure(order?.owner_id === buyerId, 403, '只能关联这位买家自己的订单')
      }
      for (const path of data.images) {
        const image = this.db.one<{ buyer_id: string; uploader_id: string; message_id: number | null }>('SELECT buyer_id,uploader_id,message_id FROM service_images WHERE path=?', path)
        ensure(image?.buyer_id === buyerId && image.uploader_id === user.id, 403, '只能使用自己上传的留言照片')
        ensure(image.message_id === null, 409, '这张照片已用于其他留言，请重新上传')
      }
      const now = this.clock.now()
      if (user.role === 'merchant') ensure(this.db.one('SELECT buyer_id FROM service_threads WHERE buyer_id=?', buyerId), 404, '买家还没有留言')
      this.db.run('INSERT INTO service_threads(buyer_id,created,updated) VALUES(?,?,?) ON CONFLICT(buyer_id) DO UPDATE SET updated=excluded.updated', buyerId, now, now)
      const saved = this.db.run('INSERT INTO service_messages(buyer_id,sender_id,sender_kind,order_id,content,created,request_key,request_hash) VALUES(?,?,?,?,?,?,?,?)',
        buyerId, user.id, user.role, data.orderId ?? null, data.content, now, data.requestKey, hash)
      for (const path of data.images) this.db.run('UPDATE service_images SET message_id=? WHERE path=?', saved.lastInsertRowid, path)
      const retention = new Date(now)
      retention.setUTCFullYear(retention.getUTCFullYear() + 3)
      this.db.run('UPDATE service_threads SET retain_until=MAX(retain_until,?) WHERE buyer_id=? AND retain_until IS NOT NULL', retention.getTime(), buyerId)
      return this.present(this.db.one<MessageRow>('SELECT * FROM service_messages WHERE id=?', saved.lastInsertRowid)!)
    })
  }
  upload(user: User, buyerId: string, requestKey: string, image: Buffer, uploadsPath: string) {
    this.authorize(user, buyerId)
    z.string().uuid().parse(requestKey)
    ensure(image.length <= 512 * 1024, 413, '照片不能超过512KB')
    ensure(image[0] === 255 && image[1] === 216 && image[2] === 255, 400, '仅支持JPEG照片')
    const hash = createHash('sha256').update(image).digest('hex')
    const existing = this.db.one<{ path: string; buyer_id: string; sha256: string }>('SELECT path,buyer_id,sha256 FROM service_images WHERE uploader_id=? AND request_key=?', user.id, requestKey)
    if (existing) {
      ensure(existing.buyer_id === buyerId && existing.sha256 === hash, 409, '同一次上传不能更换照片')
      return { path: existing.path }
    }
    const imageId = randomUUID(), path = '/uploads/' + imageId + '.jpg'
    mkdirSync(uploadsPath, { recursive: true })
    writeFileSync(join(uploadsPath, imageId + '.jpg'), image, { flag: 'wx', mode: 0o600 })
    try {
      this.db.run('INSERT INTO service_images(image_id,path,buyer_id,uploader_id,request_key,sha256,created) VALUES(?,?,?,?,?,?,?)', imageId, path, buyerId, user.id, requestKey, hash, this.clock.now())
    } catch (error) {
      unlinkSync(join(uploadsPath, imageId + '.jpg'))
      throw error
    }
    return { path }
  }
  canReadImage(user: User, imageId: string) {
    const image = this.db.one<{ buyer_id: string }>('SELECT buyer_id FROM service_images WHERE image_id=?', imageId)
    ensure(image, 404, '图片不存在')
    this.authorize(user, image.buyer_id)
  }
  history(user: User, buyerId: string, input: unknown) {
    this.authorize(user, buyerId)
    const query = z.object({ beforeId: z.coerce.number().int().positive().safe().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(input)
    const rows = this.db.all<MessageRow>('SELECT * FROM service_messages WHERE buyer_id=? AND id<? ORDER BY id DESC LIMIT ?', buyerId, query.beforeId ?? Number.MAX_SAFE_INTEGER, query.limit + 1)
    const hasMore = rows.length > query.limit
    const items = rows.slice(0, query.limit).reverse().map(row => this.present(row))
    const buyer = this.db.one<{ nickname: string; status: string }>('SELECT nickname,status FROM users WHERE id=?', buyerId)
    return { items, hasMore, beforeId: items[0]?.id ?? null, unreadCount: this.unread(buyerId).count,
      buyerName: buyer?.status === 'deleted' ? '已注销用户' : buyer?.nickname ?? '' }
  }
  unread(buyerId: string) {
    return { count: this.db.one<{ n: number }>(`SELECT COUNT(*) n FROM service_messages m JOIN service_threads t ON t.buyer_id=m.buyer_id
      WHERE m.buyer_id=? AND m.sender_kind='merchant' AND m.id>t.buyer_read_id`, buyerId)!.n }
  }
  read(user: User, input: unknown) {
    const { throughId } = z.object({ throughId: z.number().int().positive().safe() }).parse(input)
    ensure(this.db.one('SELECT id FROM service_messages WHERE id=? AND buyer_id=?', throughId, user.id), 403, '只能标记自己的留言')
    this.db.run('UPDATE service_threads SET buyer_read_id=MAX(buyer_read_id,?) WHERE buyer_id=?', throughId, user.id)
    return this.unread(user.id)
  }
  list(user: User, input: unknown) {
    ensure(user.role === 'merchant', 403, '需要商家权限')
    const query = z.object({ state: z.enum(['pending', 'all']).default('pending'), page: z.coerce.number().int().min(1).max(1_000_000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20) }).parse(input)
    const pending = `COALESCE((SELECT MAX(id) FROM service_messages WHERE buyer_id=t.buyer_id AND sender_kind='buyer'),0)>
      COALESCE((SELECT MAX(id) FROM service_messages WHERE buyer_id=t.buyer_id AND sender_kind='merchant'),0)`
    const from = `FROM service_threads t JOIN users u ON u.id=t.buyer_id ${query.state === 'pending' ? 'WHERE ' + pending : ''}`
    const counts = this.db.one<{ n: number }>(`SELECT COUNT(*) n ${from}`)!.n
    const items = this.db.all(`SELECT t.buyer_id buyerId,t.updated updatedAt,CASE WHEN u.status='deleted' THEN '已注销用户' ELSE u.nickname END buyerName,
      (${pending}) awaitingReply,(SELECT content FROM service_messages WHERE buyer_id=t.buyer_id ORDER BY id DESC LIMIT 1) lastMessage ${from}
      ORDER BY t.updated DESC,t.buyer_id ASC LIMIT ? OFFSET ?`, query.pageSize, (query.page - 1) * query.pageSize)
    return { items, counts, pages: Math.ceil(counts / query.pageSize), page: query.page, pageSize: query.pageSize }
  }
}
