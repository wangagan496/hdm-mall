import type { DatabaseSync } from 'node:sqlite'
import { returnAddressSchema } from './after-sales.ts'

// Cross-table checks supplement SQLite CHECK/FK constraints; backups may be externally modified.
export function inspectAfterSales(db: DatabaseSync): string[] {
  const invalid = new Set<string>()
  const sales = db.prepare(`SELECT a.*,o.owner_id,o.state AS order_state,o.received_at,o.paid_by,o.paid_at,o.amount AS order_amount,
    p.order_id AS payment_order,p.payer_id,p.amount AS payment_amount,p.state AS payment_state,p.channel_paid_at,
    r.reason AS refund_reason,r.amount AS refund_amount,r.after_sale_id AS refund_sale,r.payment_id AS refund_payment,r.state AS refund_state
    FROM after_sales a JOIN orders o ON o.id=a.order_id JOIN payments p ON p.id=a.payment_id LEFT JOIN refunds r ON r.id=a.refund_id`).all()
  for (const sale of sales) {
    let valid = sale.requested_by === sale.owner_id && [4,5].includes(Number(sale.order_state)) && sale.received_at !== null &&
      sale.payment_order === sale.order_id && sale.payer_id === sale.paid_by && sale.payment_amount === sale.order_amount &&
      sale.payment_state === 'succeeded' && sale.channel_paid_at === sale.paid_at
    const items = db.prepare(`SELECT a.*,i.price,i.count AS bought FROM after_sale_items a LEFT JOIN order_items i ON i.order_id=? AND i.sku_id=a.sku_id WHERE a.after_sale_id=?`).all(sale.order_id!,sale.id!)
    valid &&= items.length > 0 && items.every(i => i.price !== null && Number(i.count) <= Number(i.bought)) && items.reduce((sum,i) => sum + Number(i.price) * Number(i.count),0) === sale.amount
    for (const item of items) {
      const movement = db.prepare('SELECT * FROM inventory_movements WHERE business_key=?').get(`return:${sale.id}:${item.sku_id}`)
      if (Number(item.restock_count) > 0) valid &&= !!movement && movement.kind === 'return' && movement.sku_id === item.sku_id && movement.order_id === sale.order_id && movement.delta === item.restock_count && movement.actor_id === sale.resolved_by
      else valid &&= !movement
    }
    if (sale.return_address !== null) valid &&= returnAddressSchema.safeParse(JSON.parse(String(sale.return_address))).success
    if (sale.refund_id !== null) valid &&= sale.refund_reason === 'after-sale' && sale.refund_sale === sale.id && sale.refund_payment === sale.payment_id && sale.refund_amount === sale.amount && (sale.state === 'refunded') === (sale.refund_state === 'succeeded')
    const actions = db.prepare('SELECT a.*,u.role FROM after_sale_actions a LEFT JOIN users u ON u.id=a.actor_id WHERE after_sale_id=? ORDER BY a.rowid').all(sale.id!)
    valid &&= actions.filter(a=>a.action==='request').length === 1 && actions[0]?.action === 'request'
    const transitions: Record<string,[string,string]> = { request:['','pending'],withdraw:['pending','withdrawn'],reject:['pending','rejected'],
      approve:['pending',sale.kind==='refund-missing'?'refunding':'awaiting-return'], 'auto-approve':['pending',sale.kind==='refund-missing'?'refunding':'awaiting-return'],
      'ship-back':['awaiting-return','returned'],inspect:['returned','refunding'],'auto-refund':['returned','refunding'],close:['awaiting-return','closed'],'refund-reject':['returned','refund-rejected'] }
    let current = ''
    for (const action of actions) {
      const transition = transitions[String(action.action)], body = JSON.parse(String(action.request_body)), result = JSON.parse(String(action.result))
      valid &&= !!transition && (transition[0] === current || action.action === 'withdraw' && current === 'awaiting-return')
      current = transition?.[1] ?? ''
      const system = ['auto-approve','auto-refund','close'].includes(String(action.action)), owner = ['request','withdraw','ship-back'].includes(String(action.action))
      valid &&= system ? action.actor_id === null : owner ? action.actor_id === sale.requested_by : action.role === 'merchant'
      valid &&= body?.action === action.action && (action.action === 'request' ? body?.orderId === sale.order_id : body?.afterSaleId === sale.id) &&
        result?.id === action.id && result?.afterSaleId === sale.id && result?.orderId === sale.order_id && result?.appliedState === current && result?.appliedAt === action.created &&
        result?.refundId === (current === 'refunding' ? sale.refund_id : null)
    }
    valid &&= current === (sale.state === 'refunded' ? 'refunding' : sale.state)
    const images = db.prepare('SELECT * FROM after_sale_images WHERE after_sale_id=?').all(sale.id!)
    valid &&= images.length <= 3 && (images.length === 0 || sale.kind === 'return-quality') && images.every(i => i.actor_id === sale.requested_by && i.order_id === sale.order_id && i.application_key === actions[0]?.request_key)
    if (!valid) invalid.add(String(sale.order_id))
  }
  for (const row of db.prepare(`SELECT s.order_id,i.sku_id FROM after_sale_items i JOIN after_sales s ON s.id=i.after_sale_id JOIN order_items o ON o.order_id=s.order_id AND o.sku_id=i.sku_id
    WHERE s.state NOT IN ('rejected','withdrawn','closed') GROUP BY s.order_id,i.sku_id HAVING SUM(i.count)>MAX(o.count)`).all()) invalid.add(String(row.order_id))
  for (const row of db.prepare(`SELECT order_id FROM after_sales WHERE state IN ('pending','awaiting-return','returned','refunding') GROUP BY order_id HAVING COUNT(*)>1`).all()) invalid.add(String(row.order_id))
  for (const row of db.prepare(`SELECT p.order_id FROM refunds r JOIN payments p ON p.id=r.payment_id GROUP BY p.id HAVING SUM(r.amount)>MAX(p.amount)`).all()) invalid.add(String(row.order_id))
  for (const row of db.prepare(`SELECT p.order_id FROM refunds r JOIN payments p ON p.id=r.payment_id LEFT JOIN after_sales a ON a.id=r.after_sale_id WHERE r.reason='after-sale' AND (a.id IS NULL OR a.refund_id<>r.id)`).all()) invalid.add(String(row.order_id))
  for (const row of db.prepare(`SELECT i.order_id FROM after_sale_images i JOIN orders o ON o.id=i.order_id WHERE i.actor_id<>o.owner_id`).all()) invalid.add(String(row.order_id))
  for (const row of db.prepare(`SELECT order_id FROM after_sale_images GROUP BY actor_id,application_key HAVING COUNT(*)>3`).all()) invalid.add(String(row.order_id))
  return [...invalid].sort()
}
