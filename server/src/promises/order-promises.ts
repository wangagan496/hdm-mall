import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { isStoreOwner, requireBuyer, restrictOwnStore, type User } from '../accounts.ts'
import type { Database } from '../database.ts'
import { ensure } from '../errors.ts'
import { currentPromisePublication, presentPromisePublication, type PromiseSnapshot } from './publication.ts'
import { materialById, productMaterialSources, saleBatch, sourceAvailability } from '../source-verification/materials.ts'
import type { PromiseMaterialSource, SourceRecord } from '../source-verification/generated.ts'

export const promiseItemRefSchema = z.strictObject({ skuId: z.string().min(1).max(100), fieldId: z.string().min(1).max(100) })
export const promiseCheckSchema = promiseItemRefSchema.extend({ result: z.enum(['matches', 'mismatch']) })
type PromiseItemRef = z.infer<typeof promiseItemRefSchema>
type PromiseCheck = z.infer<typeof promiseCheckSchema>
interface PromiseCheckRow extends PromiseCheck { id: string }
interface OrderForCheck { owner_id: string; state: number; received_at: number | null }

export function freezeOrderItemPromise(db: Database, orderId: string, skuId: string, productId: string, now: number) {
  const current = currentPromisePublication(db, productId)
  if (!current) return
  const snapshot = presentPromisePublication(current)
  db.run('INSERT INTO order_item_promise_snapshots(order_id,sku_id,receipt_id,snapshot) VALUES(?,?,?,?)',
    orderId, skuId, current.receipt_id, JSON.stringify(snapshot))
  const batch = saleBatch(db, productId)
  for (const { fieldId, record } of productMaterialSources(db, productId, snapshot.entries, now)) {
    db.run('INSERT INTO order_item_source_records(order_id,sku_id,field_id,material_id,order_batch,snapshot) VALUES(?,?,?,?,?,?)',
      orderId, skuId, fieldId, record.materialId, batch, JSON.stringify(record))
  }
}

export function orderPromises(db: Database, orderId: string, now: number) {
  const snapshots = db.all<{ skuId: string; snapshot: string }>(`SELECT sku_id skuId,snapshot FROM order_item_promise_snapshots WHERE order_id=?`, orderId)
  const checks = db.all<PromiseCheckRow>(`SELECT id,sku_id skuId,field_id fieldId,result FROM order_promise_checks
    WHERE order_id=? AND rowid IN (SELECT MAX(rowid) FROM order_promise_checks WHERE order_id=? GROUP BY sku_id,field_id)`, orderId, orderId)
  const rows = db.all<{ sku_id: string; field_id: string; material_id: string; order_batch: string | null; snapshot: string }>(
    'SELECT sku_id,field_id,material_id,order_batch,snapshot FROM order_item_source_records WHERE order_id=? ORDER BY field_id', orderId)
  const sources = new Map<string, PromiseMaterialSource[]>()
  for (const row of rows) {
    const record = JSON.parse(row.snapshot) as SourceRecord
    const material = materialById(db, row.material_id)
    const entries = sources.get(row.sku_id) ?? []
    entries.push({ fieldId: row.field_id, record,
      currentAvailability: material ? sourceAvailability(material, saleBatch(db, material.product_id), now) : 'withdrawn' })
    sources.set(row.sku_id, entries)
  }
  return { snapshots: new Map(snapshots.map(row => [row.skuId, JSON.parse(row.snapshot) as PromiseSnapshot])), checks, sources }
}

export function canCheckOrderPromises(db: Database, user: User, order: OrderForCheck) {
  return user.identity === 'buyer' && user.id === order.owner_id && [4, 5].includes(order.state) &&
    order.received_at !== null && !isStoreOwner(db, user.id)
}

function checkedField(db: Database, orderId: string, ref: PromiseItemRef) {
  const row = db.one<{ snapshot: string }>('SELECT snapshot FROM order_item_promise_snapshots WHERE order_id=? AND sku_id=?', orderId, ref.skuId)
  const snapshot = row ? JSON.parse(row.snapshot) as PromiseSnapshot : null
  const field = snapshot?.entries.find(entry => entry.fieldId === ref.fieldId && entry.status === 'known')
  ensure(snapshot && field && field.quote, 400, '这条承诺没有可核对的原文')
  return { receiptId: snapshot.receiptId, label: field.label, quote: field.quote }
}

function latestCheck(db: Database, orderId: string, ref: PromiseItemRef) {
  return db.one<PromiseCheckRow>(`SELECT id,sku_id skuId,field_id fieldId,result FROM order_promise_checks
    WHERE order_id=? AND sku_id=? AND field_id=? ORDER BY rowid DESC LIMIT 1`, orderId, ref.skuId, ref.fieldId)
}

export function checkOrderPromise(db: Database, user: User, orderId: string, check: PromiseCheck, now: number) {
  requireBuyer(user)
  return db.transaction(() => {
    const order = db.one<OrderForCheck>('SELECT owner_id,state,received_at FROM orders WHERE id=?', orderId)
    ensure(order, 404, '订单不存在')
    ensure(order.owner_id === user.id, 403, '只有下单人可以核对商品承诺')
    restrictOwnStore(db, user.id)
    ensure(canCheckOrderPromises(db, user, order), 409, '确认收货后才能核对承诺')
    checkedField(db, orderId, check)
    if (latestCheck(db, orderId, check)?.result !== check.result) {
      db.run(`INSERT INTO order_promise_checks(id,order_id,sku_id,field_id,actor_id,acting_identity,result,checked_at)
        VALUES(?,?,?,?,?,?,?,?)`, randomUUID(), orderId, check.skuId, check.fieldId, user.id, user.identity, check.result, now)
    }
    return check
  })
}

export function attachPromiseMismatch(db: Database, afterSaleId: string, orderId: string, ref: PromiseItemRef) {
  checkedField(db, orderId, ref)
  const check = latestCheck(db, orderId, ref)
  ensure(check?.result === 'mismatch', 409, '请先在订单里标记这条承诺不符')
  db.run('INSERT INTO after_sale_promise_links(after_sale_id,check_id) VALUES(?,?)', afterSaleId, check.id)
}

export function afterSalePromiseMismatch(db: Database, afterSaleId: string) {
  const check = db.one<{ orderId: string } & PromiseItemRef>(`SELECT c.order_id orderId,c.sku_id skuId,c.field_id fieldId
    FROM after_sale_promise_links l JOIN order_promise_checks c ON c.id=l.check_id WHERE l.after_sale_id=?`, afterSaleId)
  return check ? { skuId: check.skuId, fieldId: check.fieldId, ...checkedField(db, check.orderId, check) } : null
}
