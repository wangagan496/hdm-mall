import { z } from 'zod'
import type { Database } from './database.ts'
import type { User } from './accounts.ts'
import { appendAudit } from './audit.ts'
import { ensure } from './errors.ts'

export const invoiceSchema = z.object({ titleType: z.enum(['individual', 'company']), title: z.string().trim().min(1).max(100),
  taxId: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{15,20}$/).optional(), email: z.email().max(254) })
  .refine(value => value.titleType !== 'company' || Boolean(value.taxId), { message: '单位抬头需要税号' })
export type InvoiceInput = z.infer<typeof invoiceSchema>
export const issueInvoiceSchema = z.object({ requestKey: z.string().uuid(), number: z.string().trim().max(100).default('') })

export function invoiceDetail(db: Database, orderId: string) {
  return db.one<{ titleType: string; title: string; taxId: string; email: string; status: string; number: string; requestedAt: number; issuedAt: number | null }>(
    'SELECT title_type titleType,title,tax_id taxId,email,status,number,requested_at requestedAt,issued_at issuedAt FROM invoices WHERE order_id=?', orderId) ?? null
}

export function requestInvoice(db: Database, user: User, orderId: string, input: InvoiceInput, now: number) {
  const data = invoiceSchema.parse(input)
  ensure(!db.one('SELECT order_id FROM invoices WHERE order_id=?', orderId), 409, '这笔订单已经登记开票信息')
  db.run('INSERT INTO invoices(order_id,title_type,title,tax_id,email,requested_at) VALUES(?,?,?,?,?,?)',
    orderId, data.titleType, data.title, data.titleType === 'company' ? data.taxId! : '', data.email, now)
  appendAudit(db, { created: now, actor: user, action: 'invoice.request', targetType: 'order', targetId: orderId, orderId,
    summary: { after: 'requested' } })
  return invoiceDetail(db, orderId)
}

export function issueInvoice(db: Database, user: User, orderId: string, input: unknown, now: number) {
  ensure(user.role === 'merchant', 403, '需要商家权限')
  const data = issueInvoiceSchema.parse(input)
  return db.transaction(() => {
    const order = db.one<{ state: number }>('SELECT state FROM orders WHERE id=?', orderId)
    ensure(order, 404, '订单不存在')
    const invoice = db.one<{ status: string; issue_key: string | null; number: string }>('SELECT status,issue_key,number FROM invoices WHERE order_id=?', orderId)
    ensure(invoice, 409, '买家尚未登记开票信息')
    if (invoice.status === 'issued') {
      ensure(invoice.issue_key === data.requestKey && invoice.number === data.number, 409, '这笔订单已经标记已开票')
      return invoiceDetail(db, orderId)
    }
    ensure([2, 3, 4, 5].includes(order.state), 409, '订单尚未付款或已取消')
    db.run("UPDATE invoices SET status='issued',number=?,issued_at=?,issued_by=?,issue_key=? WHERE order_id=?", data.number, now, user.id, data.requestKey, orderId)
    appendAudit(db, { created: now, actor: user, action: 'invoice.issued', targetType: 'order', targetId: orderId, orderId,
      requestKey: data.requestKey, summary: { after: 'issued' } })
    return invoiceDetail(db, orderId)
  })
}

export function registerCompletedInvoice(db: Database, user: User, orderId: string, input: unknown, now: number) {
  const data = invoiceSchema.parse(input)
  return db.transaction(() => {
    const order = db.one<{ owner_id: string; state: number }>('SELECT owner_id,state FROM orders WHERE id=?', orderId)
    ensure(order, 404, '订单不存在')
    ensure(order.owner_id === user.id, 403, '只有下单人可以登记开票信息')
    ensure([4, 5].includes(order.state), 409, '确认收货后可以补登记开票信息')
    const existing = invoiceDetail(db, orderId)
    if (existing && existing.titleType === data.titleType && existing.title === data.title && existing.email === data.email &&
      existing.taxId === (data.titleType === 'company' ? data.taxId : '')) return existing
    return requestInvoice(db, user, orderId, data, now)
  })
}
