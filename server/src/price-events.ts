import { randomUUID } from 'node:crypto'
import type { Database } from './database.ts'

export type PriceEventSource = 'merchant_edit' | 'promotion_add' | 'promotion_remove' | 'promotion_change'

export interface PriceEventRecord {
  id: string
  merchantId: string
  goodsId: string
  skuId: string | null
  oldPriceCents: number
  newPriceCents: number
  promotionRuleId: string | null
  observedAt: number
  source: PriceEventSource
}

interface PriceEventRow {
  id: string
  merchant_id: string
  goods_id: string
  sku_id: string | null
  old_price_cents: number
  new_price_cents: number
  promotion_rule_id: string | null
  observed_at: number
  source: PriceEventSource
}

function presentEvent(row: PriceEventRow): PriceEventRecord {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    goodsId: row.goods_id,
    skuId: row.sku_id,
    oldPriceCents: row.old_price_cents,
    newPriceCents: row.new_price_cents,
    promotionRuleId: row.promotion_rule_id,
    observedAt: row.observed_at,
    source: row.source
  }
}

/** 仅在商品或活动引起明确降价（newCents < oldCents 且均为正整数分）时记录降价事件。 */
export function recordPriceEvent(
  db: Database,
  merchantId: string,
  goodsId: string,
  skuId: string | null,
  oldCents: number,
  newCents: number,
  source: PriceEventSource,
  promotionRuleId: string | null,
  now: number
): PriceEventRecord | null {
  if (!Number.isSafeInteger(oldCents) || !Number.isSafeInteger(newCents) ||
    oldCents <= 0 || newCents <= 0 || newCents >= oldCents) {
    return null
  }
  const id = randomUUID()
  db.run(
    `INSERT INTO price_events(id,merchant_id,goods_id,sku_id,old_price_cents,new_price_cents,promotion_rule_id,observed_at,source)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    id, merchantId, goodsId, skuId, oldCents, newCents, promotionRuleId, now, source
  )
  return {
    id,
    merchantId,
    goodsId,
    skuId,
    oldPriceCents: oldCents,
    newPriceCents: newCents,
    promotionRuleId,
    observedAt: now,
    source
  }
}

export function listRecentPriceEvents(db: Database, merchantId: string, sinceMs: number): PriceEventRecord[] {
  return db.all<PriceEventRow>(
    'SELECT * FROM price_events WHERE merchant_id=? AND observed_at>=? ORDER BY observed_at ASC, rowid ASC',
    merchantId, sinceMs
  ).map(presentEvent)
}
