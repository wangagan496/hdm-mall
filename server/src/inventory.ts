import type { User } from './accounts.ts'
import { Database } from './database.ts'
import { systemClock, type Clock } from './clock.ts'
import { ensure } from './errors.ts'

type Movement = { skuId: string; delta: number } & (
  { kind: 'opening' } |
  { kind: 'reserve' | 'cancel'; orderId: string; actorId: string } |
  { kind: 'expire'; orderId: string }
)

// 与库存更新共用调用者的事务；流水写入失败必须让整笔业务回滚。
export function recordStockMovement(db: Database, movement: Movement, clock: Clock = systemClock) {
  const stock = db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', movement.skuId)
  ensure(stock, 404, '商品规格不存在')
  const orderId = movement.kind === 'opening' ? null : movement.orderId
  const actorId = movement.kind === 'reserve' || movement.kind === 'cancel' ? movement.actorId : null
  const businessKey = movement.kind === 'opening' ? `opening:${movement.skuId}` :
    `${movement.kind === 'reserve' ? 'reserve' : 'release'}:${orderId}:${movement.skuId}`
  db.run('INSERT INTO inventory_movements(sku_id,order_id,actor_id,kind,delta,balance,business_key,created) VALUES(?,?,?,?,?,?,?,?)',
    movement.skuId, orderId, actorId, movement.kind, movement.delta, stock.stock, businessKey, clock.now())
}

interface PageQuery { page: number; pageSize: number }

export function inventoryPage(db: Database, user: User, query: PageQuery & { skuId?: string }) {
  ensure(user.role === 'merchant', 403, '需要商家权限')
  const where = query.skuId ? 'WHERE s.id=?' : ''
  const values = query.skuId ? [query.skuId] : []
  const counts = db.one<{ count: number }>(`SELECT COUNT(*) AS count FROM skus s ${where}`, ...values)!.count
  const items = db.all(`SELECT s.id AS skuId,p.name,s.spec,s.stock,
    COALESCE((SELECT SUM(m.delta) FROM inventory_movements m WHERE m.sku_id=s.id),0) AS recordedStock,
    s.stock-COALESCE((SELECT SUM(m.delta) FROM inventory_movements m WHERE m.sku_id=s.id),0) AS difference,
    COALESCE((SELECT SUM(i.count) FROM order_items i JOIN orders o ON o.id=i.order_id
      JOIN payments p ON p.order_id=o.id AND p.state='pending' WHERE i.sku_id=s.id AND o.state=1),0) AS confirmingCount
    FROM skus s JOIN products p ON p.id=s.product_id ${where} ORDER BY s.id LIMIT ? OFFSET ?`,
    ...values, query.pageSize, (query.page - 1) * query.pageSize)
  return { items, counts, pages: Math.ceil(counts / query.pageSize), ...query }
}

export function stockMovements(db: Database, user: User, skuId: string, query: PageQuery) {
  ensure(user.role === 'merchant', 403, '需要商家权限')
  ensure(db.one('SELECT id FROM skus WHERE id=?', skuId), 404, '商品规格不存在')
  const counts = db.one<{ count: number }>('SELECT COUNT(*) AS count FROM inventory_movements WHERE sku_id=?', skuId)!.count
  const items = db.all(`SELECT id,sku_id AS skuId,order_id AS orderId,actor_id AS actorId,kind,delta,balance,
    business_key AS businessKey,created AS createdAt,reason FROM inventory_movements WHERE sku_id=? ORDER BY id DESC LIMIT ? OFFSET ?`,
    skuId, query.pageSize, (query.page - 1) * query.pageSize)
  return { items, counts, pages: Math.ceil(counts / query.pageSize), ...query }
}

export interface StockAdjustment { requestKey: string; delta: number; expectedStock: number; reason: string }
interface AdjustmentReceipt { id: number; skuId: string; delta: number; balance: number; reason: string; createdAt: number }

function findAdjustment(db: Database, user: User, requestKey: string) {
  return db.one<AdjustmentReceipt>(`SELECT id,sku_id AS skuId,delta,balance,reason,created AS createdAt
    FROM inventory_movements WHERE business_key=? AND actor_id=? AND kind='adjust'`, `adjust:${user.id}:${requestKey}`, user.id)
}

export function adjustmentReceipt(db: Database, user: User, requestKey: string) {
  ensure(user.role === 'merchant', 403, '需要商家权限')
  const receipt = findAdjustment(db, user, requestKey)
  ensure(receipt, 404, '尚未找到本次调整记录')
  return receipt
}

export function adjustStock(db: Database, user: User, skuId: string, data: StockAdjustment, clock: Clock = systemClock) {
  ensure(user.role === 'merchant', 403, '需要商家权限')
  return db.transaction(() => {
    const existing = findAdjustment(db, user, data.requestKey)
    if (existing) {
      ensure(existing.skuId === skuId && existing.delta === data.delta && existing.reason === data.reason &&
        existing.balance - existing.delta === data.expectedStock, 409, '同一次调整不能更改内容，请查询原结果')
      return existing
    }
    const sku = db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', skuId)
    ensure(sku, 404, '商品规格不存在')
    ensure(sku.stock === data.expectedStock, 409, '库存已变化，请刷新后重新确认')
    const recorded = db.one<{ total: number }>('SELECT COALESCE(SUM(delta),0) AS total FROM inventory_movements WHERE sku_id=?', skuId)!.total
    ensure(recorded === sku.stock, 409, '库存与流水存在差异，请先核查记录')
    const balance = sku.stock + data.delta
    ensure(Number.isSafeInteger(balance) && balance >= 0 && balance <= 2147483647, 409, '调整后库存超出允许范围')
    db.run('UPDATE skus SET stock=? WHERE id=?', balance, skuId)
    db.run(`INSERT INTO inventory_movements(sku_id,actor_id,kind,delta,balance,business_key,created,reason)
      VALUES(?,?,'adjust',?,?,?,?,?)`, skuId, user.id, data.delta, balance, `adjust:${user.id}:${data.requestKey}`, clock.now(), data.reason)
    return findAdjustment(db, user, data.requestKey)!
  })
}
