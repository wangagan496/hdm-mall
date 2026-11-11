import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { discountShares } from './promotions.ts'

const ruleSchema = z.object({ thresholdCents: z.number().int().min(1).max(2147483647),
  discountCents: z.number().int().positive().max(2147483646), enabled: z.boolean(), revision: z.number().int().positive().safe()
}).strict().refine(rule => rule.discountCents < rule.thresholdCents)

export function inspectPromotionShipping(db: DatabaseSync) {
  const rules = db.prepare('SELECT threshold thresholdCents,discount discountCents,enabled,revision FROM promotions').all()
  if (rules.length !== 1 || ![0, 1].includes(Number(rules[0]!.enabled))) throw new Error('满减规则无效')
  ruleSchema.parse({ ...rules[0], enabled: rules[0]!.enabled === 1 })
  for (const order of db.prepare('SELECT id,amount,discount,promotion FROM orders').iterate()) {
    const items = db.prepare('SELECT price,count,discount_share FROM order_items WHERE order_id=? ORDER BY rowid').all(order.id!)
    const amounts = items.map(item => Number(item.price) * Number(item.count))
    const total = amounts.reduce((sum, amount) => sum + amount, 0)
    if (Number(order.amount) + Number(order.discount) !== total) throw new Error('订单满减金额不一致')
    if (order.promotion === null) {
      if (order.discount !== 0 || items.some(item => item.discount_share !== 0)) throw new Error('旧订单不应有满减')
    } else {
      const rule = ruleSchema.parse(JSON.parse(String(order.promotion)))
      const discount = rule.enabled && total >= rule.thresholdCents ? rule.discountCents : 0
      if (order.discount !== discount) throw new Error('订单满减快照不一致')
      const shares = discountShares(amounts, discount, items.map(item => Number(item.count)))
      if (items.some((item, index) => item.discount_share !== shares[index])) throw new Error('订单满减分摊不一致')
    }
  }
  for (const sale of db.prepare('SELECT * FROM after_sales').iterate()) {
    if (sale.shipping_amount === null) {
      if ([sale.shipping_image_id, sale.shipping_compensation, sale.shipping_adjustment_reason, sale.shipping_refund_id].some(value => value !== null)) throw new Error('运费补偿缺少实付运费')
      continue
    }
    if (sale.kind === 'refund-missing' || sale.returned_at === null || !Number.isSafeInteger(sale.shipping_amount) || Number(sale.shipping_amount) < 1 || Number(sale.shipping_amount) > 10000) throw new Error('寄回运费无效')
    const image = db.prepare('SELECT * FROM after_sale_images WHERE image_id=?').get(sale.shipping_image_id!)
    const action = db.prepare("SELECT * FROM after_sale_actions WHERE after_sale_id=? AND action='ship-back'").get(sale.id!)
    if (!image || !action || image.after_sale_id !== sale.id || image.order_id !== sale.order_id || image.actor_id !== sale.requested_by || image.application_key !== action.request_key) throw new Error('运单截图归属无效')
    const body = JSON.parse(String(action.request_body))
    if (body.shippingAmountCents !== sale.shipping_amount || body.shippingImageId !== image.image_id) throw new Error('寄回运费回执不一致')
    if (sale.shipping_compensation === null) {
      if (sale.shipping_refund_id !== null || sale.shipping_adjustment_reason !== null) throw new Error('未补偿运费存在退款')
      continue
    }
    const amount = Number(sale.shipping_compensation), reason = String(sale.shipping_adjustment_reason ?? '').trim()
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > Number(sale.shipping_amount) || amount < Number(sale.shipping_amount) && (reason.length < 5 || reason.length > 200)) throw new Error('运费调整无效')
    const refund = db.prepare('SELECT * FROM refunds WHERE id=?').get(sale.shipping_refund_id!)
    if (amount > 0 ? !refund || refund.reason !== 'shipping' || refund.after_sale_id !== sale.id || refund.payment_id !== sale.payment_id || refund.amount !== amount : !!refund) throw new Error('运费退款不一致')
  }
  if (db.prepare("SELECT r.id FROM refunds r LEFT JOIN after_sales s ON s.id=r.after_sale_id WHERE r.reason='shipping' AND (s.id IS NULL OR s.shipping_refund_id IS NOT r.id)").get()) throw new Error('运费退款缺少售后关联')
}
