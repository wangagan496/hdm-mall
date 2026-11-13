import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { Database } from './database.ts'
import type { User } from './accounts.ts'
import type { Clock } from './clock.ts'
import type { Payments } from './payments.ts'
import { ensure } from './errors.ts'
import { appendAudit, type AuditAction } from './audit.ts'
import { canReturnNoReason, requiresCondition, type PolicyRow } from './return-policy.ts'
import { inspectionState, pendingReturnInspection } from './inventory.ts'

const DAY = 86400000
const active = ['pending', 'awaiting-return', 'returned', 'refunding']
export const returnAddressSchema = z.object({ receiver: z.string().trim().min(1).max(50), contact: z.string().regex(/^\d{6,20}$/), address: z.string().trim().min(1).max(300) }).strict()
export const afterSaleRequestSchema = z.object({ requestKey: z.string().uuid(), kind: z.enum(['return-no-reason', 'return-quality', 'refund-missing']),
  description: z.string().trim().max(200).default(''), items: z.array(z.object({ skuId: z.string().min(1).max(100), count: z.number().int().min(1).max(999),conditionDeclared:z.enum(['sealed','unsealed']).optional() }).strict()).min(1).max(100),
  imageIds: z.array(z.string().uuid()).max(3).default([]) }).strict()
export const afterSaleActionSchema = z.object({ requestKey: z.string().uuid(), reason: z.string().trim().min(5).max(200).optional(),
  shippingAmountCents: z.number().int().min(1).max(10000).optional(), shippingImageId: z.string().uuid().optional(),
  shippingCompensationCents: z.number().int().min(0).max(10000).optional(), shippingAdjustmentReason: z.string().trim().min(5).max(200).optional(),
  returnAddress: returnAddressSchema.optional(), carrier: z.string().trim().min(1).max(50).optional(), trackingNo: z.string().trim().regex(/^[A-Za-z0-9-]{5,60}$/).optional(),
  items: z.array(z.object({ skuId: z.string().min(1).max(100), restockCount: z.number().int().min(0).max(999) }).strict()).min(1).max(100).optional() }).strict()
type ActionData = z.infer<typeof afterSaleActionSchema>
type ReturnAddress = z.infer<typeof returnAddressSchema>
interface Order { id: string; owner_id: string; paid_by: string; state: number; received_at: number | null; address: string }
interface Sale { id: string; order_id: string; sequence: number; requested_by: string; payment_id: string; kind: string; description: string; state: string; amount: number;
  created: number; review_deadline: number; approved_at: number | null; return_deadline: number | null; returned_at: number | null; inspect_deadline: number | null;
  resolved_at: number | null; return_address: string | null; carrier: string | null; tracking_no: string | null; reject_reason: string | null; refund_id: string | null;
  shipping_amount: number | null; shipping_image_id: string | null; shipping_compensation: number | null; shipping_adjustment_reason: string | null; shipping_refund_id: string | null }
interface Item extends PolicyRow { sku_id: string; name: string; spec: string; price: number; count: number; discount_share: number }
interface Receipt { id: string; orderId: string; afterSaleId: string; action: string; appliedState: string; appliedAt: number; refundId: string | null }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
  return JSON.stringify(value)
}

export class AfterSales {
  readonly db: Database; readonly payments: Payments; readonly clock: Clock
  constructor(db: Database, payments: Payments, clock: Clock) { this.db = db; this.payments = payments; this.clock = clock }
  private order(id: string) { const row = this.db.one<Order>('SELECT * FROM orders WHERE id=?', id); ensure(row, 404, '订单不存在'); return row }
  private sale(id: string) { const row = this.db.one<Sale>('SELECT * FROM after_sales WHERE id=?', id); ensure(row, 404, '售后申请不存在'); return row }
  private merchant(user: User) { ensure(user.role === 'merchant', 403, '需要商家权限') }
  private owner(user: User, order: Order) { ensure(order.owner_id === user.id, 403, '只有下单人可以操作售后') }
  private address() { const row = this.db.one<{ return_address: string }>('SELECT return_address FROM merchant_settings WHERE id=1'); return row ? JSON.parse(row.return_address) as ReturnAddress : null }
  getAddress(user: User) { this.merchant(user); return this.address() }
  private storeAddress(user: User, address: ReturnAddress) {
    if(canonical(this.address())!==canonical(address))appendAudit(this.db,{created:this.clock.now(),actor:user,action:'settings.return_address',targetType:'settings',targetId:'return-address',summary:{note:'已修改'}})
    this.db.run('INSERT INTO merchant_settings(id,return_address,updated_by,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET return_address=excluded.return_address,updated_by=excluded.updated_by,updated_at=excluded.updated_at', JSON.stringify(address), user.id, this.clock.now())
  }
  async setAddress(user: User, value: unknown) {
    this.merchant(user); const address = returnAddressSchema.parse(value)
    this.db.transaction(() => this.storeAddress(user, address)); await this.processDue()
    return address
  }
  private deadline(receivedAt: number, kind: string) {
    // China calendar day: seven full days starting the day after receipt, exclusive upper bound.
    return kind === 'return-no-reason' ? Math.floor((receivedAt + 8 * 3600000) / DAY) * DAY - 8 * 3600000 + 8 * DAY : receivedAt + 15 * DAY
  }
  private remaining(orderId: string) {
    return this.db.all<Item & { remaining: number }>(`SELECT i.*, i.count-COALESCE((SELECT SUM(a.count) FROM after_sale_items a JOIN after_sales s ON s.id=a.after_sale_id
      WHERE s.order_id=i.order_id AND a.sku_id=i.sku_id AND s.state NOT IN ('rejected','withdrawn','closed')),0) AS remaining FROM order_items i WHERE i.order_id=?`, orderId)
  }
  private replay(user: User | undefined, key: string, body: string) {
    const row = this.db.one<{ actor_id: string | null; request_body: string; result: string }>('SELECT * FROM after_sale_actions WHERE request_key=?', key)
    if (!row) return undefined
    ensure(row.actor_id === (user?.id ?? null) && row.request_body === body, 409, '本次操作内容已变化，请先确认原结果')
    return JSON.parse(row.result) as Receipt
  }
  private receipt(sale: Sale, user: User | undefined, action: string, key: string, body: string): Receipt {
    const result = { id: randomUUID(), orderId: sale.order_id, afterSaleId: sale.id, action, appliedState: sale.state, appliedAt: this.clock.now(), refundId: sale.refund_id }
    this.db.run('INSERT INTO after_sale_actions(id,after_sale_id,actor_id,action,request_key,request_body,result,created) VALUES(?,?,?,?,?,?,?,?)', result.id, sale.id, user?.id ?? null, action, key, body, JSON.stringify(result), result.appliedAt)
    const actions:Record<string,AuditAction>={approve:'aftersale.approve',reject:'aftersale.reject',inspect:'aftersale.inspect','refund-reject':'aftersale.refund_reject','auto-approve':'aftersale.auto_approve',close:'aftersale.auto_close','auto-refund':'aftersale.auto_refund'}
    const auditAction=actions[action]
    if(auditAction)appendAudit(this.db,{created:result.appliedAt,actor:user,action:auditAction,targetType:'after_sale',targetId:sale.id,orderId:sale.order_id,requestKey:key,
      summary:{...(sale.reject_reason?{reason:sale.reject_reason}:{}),...(action==='inspect'?{items:this.db.all<{skuId:string;spec:string;restockCount:number}>('SELECT a.sku_id skuId,i.spec,a.restock_count restockCount FROM after_sale_items a JOIN order_items i ON i.sku_id=a.sku_id AND i.order_id=? WHERE a.after_sale_id=?',sale.order_id,sale.id)}:{})}})
    return result
  }
  async request(user: User, orderId: string, input: unknown) {
    const data = afterSaleRequestSchema.parse(input)
    const body = canonical({ orderId, action: 'request', ...data, items: [...data.items].sort((a,b) => a.skuId.localeCompare(b.skuId)), imageIds: [...data.imageIds].sort() })
    await this.processDue()
    return this.db.transaction(() => {
      const order = this.order(orderId); this.owner(user, order)
      const replay = this.replay(user, data.requestKey, body); if (replay) return replay
      ensure([3,4,5].includes(order.state), 409, '发货后才能申请售后')
      const now = this.clock.now(), received = order.received_at ?? now
      ensure(now < this.deadline(received, data.kind), 409, '已超过售后期，如有问题请联系客服')
      ensure(!this.db.one("SELECT id FROM after_sales WHERE order_id=? AND state IN ('pending','awaiting-return','returned','refunding')", orderId), 409, '请先完成当前售后')
      ensure(data.kind === 'return-no-reason' || data.description.length >= 5, 400, '请填写5到200字的问题说明')
      ensure(data.kind === 'return-quality' || data.imageIds.length === 0, 400, '仅质量问题可以上传照片')
      ensure(new Set(data.items.map(i => i.skuId)).size === data.items.length && new Set(data.imageIds).size === data.imageIds.length, 400, '请勿重复选择商品或照片')
      const available = this.remaining(orderId)
      const shares = new Map<string, number>()
      let amount = 0
      for (const item of data.items) {
        const original = available.find(i => i.sku_id === item.skuId)
        ensure(original && item.count <= original.remaining, 409, '申请数量超过可售后数量，请刷新')
        if(data.kind==='return-no-reason'){
          ensure(canReturnNoReason(original),409,'该商品不适用七日无理由退货，如有质量问题请选择质量问题退货')
          if(requiresCondition(original)){
            ensure(item.conditionDeclared!==undefined,400,'请如实选择商品是否已拆封或激活')
            ensure(item.conditionDeclared==='sealed',409,'已拆封或激活的该商品不支持七日无理由退货，如有质量问题请选择质量问题退货')
          }
        }
        const consumed = original.count - original.remaining
        const share = Math.floor(original.discount_share * (consumed + item.count) / original.count) - Math.floor(original.discount_share * consumed / original.count)
        shares.set(item.skuId, share)
        amount += original.price * item.count - share
      }
      ensure(Number.isSafeInteger(amount) && amount >= 0, 400, '退款金额不正确')
      const payment = this.payments.effectivePaymentId(orderId)
      ensure(payment, 409, '付款记录异常，请联系客服')
      const id = randomUUID(), sequence = this.db.one<{ n: number }>('SELECT COALESCE(MAX(sequence),0)+1 n FROM after_sales WHERE order_id=?', orderId)!.n
      this.db.run("INSERT INTO after_sales(id,order_id,sequence,requested_by,payment_id,kind,description,state,amount,created,review_deadline) VALUES(?,?,?,?,?,?,?,'pending',?,?,?)", id, orderId, sequence, user.id, payment, data.kind, data.description, amount, now, now + 2 * DAY)
      for (const item of data.items) this.db.run('INSERT INTO after_sale_items(after_sale_id,sku_id,count,condition_declared,discount_share) VALUES(?,?,?,?,?)', id, item.skuId, item.count,data.kind==='return-no-reason'&&requiresCondition(available.find(i=>i.sku_id===item.skuId)!)?item.conditionDeclared!:null,shares.get(item.skuId)!)
      for (const imageId of data.imageIds) {
        const changed = this.db.run('UPDATE after_sale_images SET after_sale_id=? WHERE image_id=? AND actor_id=? AND order_id=? AND application_key=? AND after_sale_id IS NULL', id, imageId, user.id, orderId, data.requestKey)
        ensure(changed.changes === 1, 400, '请选择本人为本次申请上传的照片')
      }
      if (order.state === 3) this.db.run('UPDATE orders SET state=4,received_by=?,received_at=? WHERE id=? AND state=3', user.id, now, orderId)
      return this.receipt(this.sale(id), user, 'request', data.requestKey, body)
    })
  }
  private refund(sale: Sale, user?: User, data?: ActionData) {
    const refundId = sale.amount > 0 ? this.payments.createAfterSaleRefund(sale.order_id, sale.payment_id, sale.id, sale.amount, this.clock.now(),user) : null
    if (sale.shipping_amount !== null) {
      const compensation = data?.shippingCompensationCents ?? sale.shipping_amount
      ensure(compensation <= sale.shipping_amount, 400, '补偿不能超过买家填写的运费')
      ensure(compensation === sale.shipping_amount || data?.shippingAdjustmentReason, 400, '下调运费请填写5到200字的原因')
      const reason = compensation < sale.shipping_amount ? data!.shippingAdjustmentReason! : null
      this.db.run('UPDATE after_sales SET shipping_compensation=?,shipping_adjustment_reason=? WHERE id=?', compensation, reason, sale.id)
      if (compensation > 0) {
        const shippingId = this.payments.createShippingRefund(sale.order_id, sale.payment_id, sale.id, compensation, this.clock.now(), user)
        this.db.run('UPDATE after_sales SET shipping_refund_id=? WHERE id=?', shippingId, sale.id)
      }
      appendAudit(this.db, { created: this.clock.now(), actor: user, action: 'aftersale.shipping_comp', targetType: 'after_sale', targetId: sale.id,
        orderId: sale.order_id, summary: { before: sale.shipping_amount, after: compensation, ...(reason ? { reason } : {}) } })
    }
    this.db.run("UPDATE after_sales SET state=?,approved_at=COALESCE(approved_at,?),refund_id=?,resolved_at=?,resolved_by=? WHERE id=?", sale.amount === 0 ? 'completed' : 'refunding', this.clock.now(), refundId, this.clock.now(), user?.id ?? null, sale.id)
  }
  private approve(sale: Sale, address: ReturnAddress | null, user?: User) {
    if (sale.kind === 'refund-missing') this.refund(sale, user)
    else {
      ensure(address, 400, '请先填写退货地址')
      this.db.run("UPDATE after_sales SET state='awaiting-return',approved_at=?,return_deadline=?,return_address=? WHERE id=?", this.clock.now(), this.clock.now() + 7 * DAY, JSON.stringify(address), sale.id)
    }
  }
  async act(user: User, id: string, action: string, input: unknown) {
    const data = afterSaleActionSchema.parse(input)
    const allowed: Record<string, string[]> = { withdraw: [], approve: ['returnAddress'], reject: ['reason'], 'ship-back': ['carrier','trackingNo','shippingAmountCents','shippingImageId'], inspect: ['items','shippingCompensationCents','shippingAdjustmentReason'], 'refund-reject': ['reason'] }
    ensure(allowed[action], 400, '操作不支持')
    ensure(Object.keys(data).every(k => k === 'requestKey' || allowed[action]!.includes(k)), 400, '操作参数不正确')
    const body = canonical({ afterSaleId: id, action, ...data, ...(data.items ? { items: [...data.items].sort((a,b) => a.skuId.localeCompare(b.skuId)) } : {}) })
    const sale = this.sale(id)
    if (['withdraw','ship-back'].includes(action)) this.owner(user, this.order(sale.order_id)); else this.merchant(user)
    await this.processDue()
    const refundIds: string[] = []
    const result = this.db.transaction(() => {
      const replay = this.replay(user, data.requestKey, body); if (replay) return replay
      const current = this.sale(id), now = this.clock.now()
      if (action === 'withdraw' || action === 'reject') {
        ensure(current.state === 'pending' || action === 'withdraw' && current.state === 'awaiting-return', 409, '售后进度已变化，请刷新')
        ensure(action !== 'reject' || data.reason, 400, '请填写5到200字的原因')
        this.db.run('UPDATE after_sales SET state=?,resolved_at=?,resolved_by=?,reject_reason=? WHERE id=?', action === 'withdraw' ? 'withdrawn' : 'rejected', now, user.id, data.reason ?? null, id)
      } else if (action === 'approve') {
        ensure(current.state === 'pending', 409, '售后进度已变化，请刷新')
        if (data.returnAddress) this.storeAddress(user, data.returnAddress)
        this.approve(current, data.returnAddress ?? this.address(), user)
      } else if (action === 'ship-back') {
        ensure(current.state === 'awaiting-return', 409, '售后进度已变化，请刷新')
        ensure(data.carrier && data.trackingNo, 400, '请填写快递公司和单号')
        ensure(data.shippingAmountCents !== undefined && data.shippingImageId, 400, '请填写实付运费并上传1张运单截图')
        const image = this.db.run('UPDATE after_sale_images SET after_sale_id=? WHERE image_id=? AND actor_id=? AND order_id=? AND application_key=? AND after_sale_id IS NULL', id, data.shippingImageId, user.id, current.order_id, data.requestKey)
        ensure(image.changes === 1, 400, '请上传本人本次寄回的运单截图')
        this.db.run("UPDATE after_sales SET state='returned',carrier=?,tracking_no=?,returned_at=?,inspect_deadline=?,shipping_amount=?,shipping_image_id=? WHERE id=?", data.carrier, data.trackingNo, now, now + 10 * DAY, data.shippingAmountCents, data.shippingImageId, id)
      } else {
        const lateInspection = action === 'inspect' && ['refunding','refunded','completed'].includes(current.state) &&
          !!this.db.one("SELECT id FROM after_sale_actions WHERE after_sale_id=? AND action='auto-refund'", id)
        ensure((current.state === 'returned' || lateInspection) && inspectionState(this.db, id) === 'pending', 409, '售后进度已变化，请刷新')
        if (lateInspection) ensure(data.shippingCompensationCents === undefined && data.shippingAdjustmentReason === undefined, 409, '退款已处理，补验收只记录入库数量')
        if (action === 'refund-reject') {
          ensure(current.kind === 'return-no-reason', 409, '仅无理由退货可因商品不完好拒绝退款')
          ensure(data.reason, 400, '请填写5到200字的原因')
          this.db.run("UPDATE after_sales SET state='refund-rejected',reject_reason=?,resolved_at=?,resolved_by=? WHERE id=?", data.reason, now, user.id, id)
        } else this.inspect(current, user, data, !lateInspection)
      }
      const updated = this.sale(id)
      // A late inspection changes only physical stock; refund retries keep their own schedule.
      if (updated.refund_id && !current.refund_id) refundIds.push(updated.refund_id)
      if (updated.shipping_refund_id && !current.shipping_refund_id) refundIds.push(updated.shipping_refund_id)
      return this.receipt(updated, user, action, data.requestKey, body)
    })
    if (refundIds.length) await this.payments.reconcile(this.clock.now(), { refundIds })
    if (action === 'approve' && data.returnAddress) await this.processDue()
    return result
  }
  private inspect(sale: Sale, user: User, data: ActionData, refund = true) {
    const items = this.db.all<{ sku_id: string; count: number }>('SELECT * FROM after_sale_items WHERE after_sale_id=?', sale.id)
    ensure(data.items && data.items.length === items.length && new Set(data.items.map(i => i.skuId)).size === items.length, 400, '请逐项填写合格入库数量')
    for (const item of data.items) {
      const original = items.find(i => i.sku_id === item.skuId)
      ensure(original && item.restockCount <= original.count, 400, '合格入库数量不能超过退回数量')
      this.db.run('UPDATE after_sale_items SET restock_count=? WHERE after_sale_id=? AND sku_id=?', item.restockCount, sale.id, item.skuId)
      if (item.restockCount === 0) continue
      const stock = this.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', item.skuId)!.stock
      const balance = this.db.one<{ n: number }>('SELECT COALESCE(SUM(delta),0) n FROM inventory_movements WHERE sku_id=?', item.skuId)!.n
      ensure(balance === stock && stock + item.restockCount <= 2147483647, 409, '库存与流水存在差异，请核查记录')
      this.db.run('UPDATE skus SET stock=stock+? WHERE id=?', item.restockCount, item.skuId)
      this.db.run("INSERT INTO inventory_movements(sku_id,order_id,actor_id,kind,delta,balance,business_key,created) VALUES(?,?,?,'return',?,?,?,?)", item.skuId, sale.order_id, user.id, item.restockCount, stock + item.restockCount, `return:${sale.id}:${item.skuId}`, this.clock.now())
    }
    if (refund) this.refund(sale, user, data)
  }
  async processDue() {
    const now = this.clock.now(), failed: string[] = [], refundIds: string[] = []
    const due = this.db.all<Sale>("SELECT * FROM after_sales WHERE (state='pending' AND review_deadline<=?) OR (state='awaiting-return' AND return_deadline<=?) OR (state='returned' AND inspect_deadline<=?) ORDER BY created,id", now, now, now)
    for (const candidate of due) {
      try { const refundId = this.db.transaction(() => {
        const sale = this.sale(candidate.id), address = this.address()
        let action: string
        if (sale.state === 'pending' && sale.review_deadline <= now) {
          if (sale.kind !== 'refund-missing' && !address) return
          action = 'auto-approve'; this.approve(sale, address)
        } else if (sale.state === 'awaiting-return' && sale.return_deadline! <= now) {
          action = 'close'; this.db.run("UPDATE after_sales SET state='closed',resolved_at=? WHERE id=?", now, sale.id)
        } else if (sale.state === 'returned' && sale.inspect_deadline! <= now) {
          action = 'auto-refund'; this.refund(sale)
        } else return
        const updated = this.sale(sale.id)
        if (updated.shipping_refund_id) refundIds.push(updated.shipping_refund_id)
        this.receipt(updated, undefined, action, `${action}:${sale.id}`, canonical({ afterSaleId: sale.id, action }))
        return updated.refund_id
      }); if (refundId) refundIds.push(refundId) } catch { failed.push(candidate.id) }
    }
    if (refundIds.length) await this.payments.reconcile(this.clock.now(), { refundIds })
    return { failed }
  }
  private present(sale: Sale, details: boolean) {
    const inspection = inspectionState(this.db, sale.id)
    const payer = this.db.one<{ account: string }>("SELECT CASE WHEN u.status='deleted' THEN '已注销用户' ELSE u.account END account FROM payments p JOIN users u ON u.id=p.payer_id WHERE p.id=?", sale.payment_id)!.account
    const refund = sale.refund_id ? this.db.one<{ state: string; review_at: number | null }>('SELECT state,review_at FROM refunds WHERE id=?', sale.refund_id) : undefined
    return { id: sale.id, orderId: sale.order_id, sequence: sale.sequence, kind: sale.kind, state: sale.state, amountCents: sale.amount, amountMessage: sale.amount === 0 ? '货款 0 元，无需退款' : '', payerAccount: payer,
      shippingAmountCents: sale.shipping_amount, shippingCompensationCents: sale.shipping_compensation, shippingAdjustmentReason: sale.shipping_adjustment_reason ?? '',
      shippingRefundId: sale.shipping_refund_id,
      shippingRefundState: sale.shipping_refund_id ? this.db.one<{state:string}>('SELECT state FROM refunds WHERE id=?',sale.shipping_refund_id)?.state ?? '' : '',
      createdAt: sale.created, reviewDeadline: sale.review_deadline, returnDeadline: sale.return_deadline, inspectDeadline: sale.inspect_deadline,
      refundId: sale.refund_id, refundState: refund?.state ?? '', refundReview: refund?.review_at !== undefined && refund.review_at !== null,
      ...(details ? { description: sale.description, returnAddress: sale.return_address ? JSON.parse(sale.return_address) as ReturnAddress : null,
        shippingImage: sale.shipping_image_id ? this.db.one<{imageId:string;path:string}>('SELECT image_id imageId,path FROM after_sale_images WHERE image_id=?',sale.shipping_image_id) : null,
        carrier: sale.carrier ?? '', trackingNo: sale.tracking_no ?? '', rejectReason: sale.reject_reason ?? '',
        inspectionState: inspection, inspectionPending: inspection === 'pending',
        items: this.db.all<{ skuId: string; name: string; spec: string; priceCents: number; count: number; restockCount: number;conditionDeclared:string|null;returnPolicyReason:string }>(`SELECT a.sku_id AS skuId,i.name,i.spec,i.price AS priceCents,a.count,a.restock_count AS restockCount,a.condition_declared conditionDeclared,i.return_policy_reason returnPolicyReason FROM after_sale_items a JOIN order_items i ON i.order_id=? AND i.sku_id=a.sku_id WHERE a.after_sale_id=?`, sale.order_id, sale.id)
          .map(item => ({ ...item, pendingInspectionCount: inspection === 'pending' ? item.count : 0, rejectedCount: ['inspected','rejected'].includes(inspection) ? item.count - item.restockCount : 0 })),
        images: this.db.all<{ imageId: string; path: string }>('SELECT image_id AS imageId,path FROM after_sale_images WHERE after_sale_id=? AND image_id IS NOT ?', sale.id, sale.shipping_image_id),
        needsReturnAddress: sale.state === 'pending' && sale.kind !== 'refund-missing' && this.clock.now() >= sale.review_deadline && !this.address()
      } : {}) }
  }
  orderFields(orderId: string, user: User) {
    const order = this.order(orderId), owner = order.owner_id === user.id, now = this.clock.now()
    const sales = this.db.all<Sale>('SELECT * FROM after_sales WHERE order_id=? ORDER BY sequence DESC', orderId)
    const received = order.received_at ?? now, remaining = this.remaining(orderId)
    const kinds = ['return-no-reason','return-quality','refund-missing'].filter(kind => now < this.deadline(received, kind))
    const allowed=remaining.map(i=>({skuId:i.sku_id,count:i.remaining,kinds:kinds.filter(kind=>kind!=='return-no-reason'||canReturnNoReason(i))}))
    const hasActive = sales.some(s => active.includes(s.state))
    return { afterSales: owner || order.paid_by === user.id ? sales.map(s => this.present(s, owner)) : [], afterSaleActive: hasActive,
      canApplyAfterSale: owner && [3,4,5].includes(order.state) && kinds.length > 0 && !hasActive && remaining.some(i => i.remaining > 0),
      afterSaleKinds: owner ? kinds.filter(kind=>allowed.some(i=>i.count>0&&i.kinds.includes(kind))) : [], afterSaleDeadline: this.deadline(received, 'return-quality'), noReasonDeadline: this.deadline(received, 'return-no-reason'),
      afterSaleNotice: owner && [4,5].includes(order.state) && kinds.length === 0 ? '已超过售后期，如有问题请联系客服' : '',
      afterSaleRemaining: owner ? allowed : [] }
  }
  async list(user: User, state: string, page: number, pageSize: number) {
    this.merchant(user); await this.processDue()
    const where = state === 'all' ? '' : state === 'returned' ? `WHERE ${pendingReturnInspection}` : 'WHERE s.state=?'
    const params = state === 'all' || state === 'returned' ? [] : [state]
    const counts = this.db.one<{ n: number }>(`SELECT COUNT(*) n FROM after_sales s ${where}`, ...params)!.n
    const rows = this.db.all<Sale>(`SELECT s.* FROM after_sales s ${where} ORDER BY s.created DESC,s.id LIMIT ? OFFSET ?`, ...params, pageSize, (page-1)*pageSize)
    const stateCounts = this.db.one<{ pending: number; returned: number; all: number }>(`SELECT COUNT(*) AS 'all',COUNT(CASE WHEN s.state='pending' THEN 1 END) AS pending,COUNT(CASE WHEN ${pendingReturnInspection} THEN 1 END) AS returned FROM after_sales s`)!
    return { items: rows.map(s => ({ ...this.present(s,true), buyerAccount: this.db.one<{account:string}>('SELECT account FROM users WHERE id=?',s.requested_by)!.account, serverNow: this.clock.now() })), stateCounts, counts, pages: Math.ceil(counts/pageSize), page, pageSize }
  }
  uploadImage(user: User, orderId: string, applicationKey: string, requestKey: string, bytes: Buffer, uploadsPath: string) {
    const order = this.order(orderId); this.owner(user, order)
    ensure(bytes.length <= 512 * 1024, 413, '图片过大，请换一张')
    ensure(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff, 400, '请选择JPEG照片')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    return this.db.transaction(() => {
      const existing = this.db.one<{ image_id: string; sha256: string; path: string; actor_id: string; order_id: string; application_key: string }>('SELECT * FROM after_sale_images WHERE request_key=?', requestKey)
      if (existing) {
        ensure(existing.actor_id === user.id && existing.order_id === orderId && existing.application_key === applicationKey && existing.sha256 === sha256, 409, '同一次上传不能更换照片')
        return { imageId: existing.image_id, path: existing.path }
      }
      const returning = this.db.one('SELECT id FROM after_sales WHERE order_id=? AND state=\'awaiting-return\' AND return_deadline>?', orderId, this.clock.now())
      ensure([3,4,5].includes(order.state) && (returning || this.clock.now() < this.deadline(order.received_at ?? this.clock.now(), 'return-quality')), 409, '已超过售后期，如有问题请联系客服')
      ensure(!this.db.one('SELECT id FROM after_sale_actions WHERE request_key=?', applicationKey), 409, '申请已提交，不能再添加照片')
      ensure(this.db.one<{ n: number }>('SELECT COUNT(*) n FROM after_sale_images WHERE actor_id=? AND application_key=?', user.id, applicationKey)!.n < (returning ? 1 : 3), 400, returning ? '只能上传1张运单截图' : '最多上传3张照片')
      const imageId = randomUUID(), path = '/uploads/' + imageId + '.jpg'
      mkdirSync(uploadsPath, { recursive: true }); writeFileSync(join(uploadsPath, imageId + '.jpg'), bytes, { flag: 'wx' })
      this.db.run('INSERT INTO after_sale_images(image_id,actor_id,order_id,application_key,request_key,sha256,path,created) VALUES(?,?,?,?,?,?,?,?)', imageId, user.id, orderId, applicationKey, requestKey, sha256, path, this.clock.now())
      return { imageId, path }
    })
  }
  canReadImage(user: User, imageId: string) {
    const image = this.db.one<{ actor_id: string; after_sale_id: string | null }>('SELECT actor_id,after_sale_id FROM after_sale_images WHERE image_id=?', imageId)
    ensure(image && (image.actor_id === user.id || user.role === 'merchant' && image.after_sale_id !== null), 403, '无权查看售后照片')
  }
}
