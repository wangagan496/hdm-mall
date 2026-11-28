import { createHash } from 'node:crypto'
import type { Database } from './database.ts'

export interface OrderBalanceSnapshot {
  paidCents: number
  refundedCents: number
  compensatedCents: number
  remainingCents: number
}

export interface OrderLineForUnitComp {
  sku_id: string
  price: number
  count: number
  discount_share: number
}

export interface UnitCompensationSnapshot {
  unitPaidBySku: Map<string, number[]>
  unitReceiptedBySku: Map<string, number[]>
  unitPendingBySku: Map<string, number[]>
  unitPeakTargetBySku: Map<string, number[]>
  afterSaleSlices: Map<string, Map<string, { start: number; end: number }>>
}

export function allocateDeltaAcrossLines(amounts: number[], totalDelta: number): number[] {
  const totalAmount = amounts.reduce((sum, v) => sum + v, 0)
  if (totalAmount <= 0 || totalDelta <= 0) return amounts.map(() => 0)
  const clampedTotal = Math.min(totalDelta, totalAmount)
  const totalBig = BigInt(totalAmount)
  const targetBig = BigInt(clampedTotal)
  const shares = amounts.map(amount => {
    if (amount <= 0) return 0
    return Number(BigInt(amount) * targetBig / totalBig)
  })
  let remainder = clampedTotal - shares.reduce((sum, s) => sum + s, 0)
  while (remainder > 0) {
    let progressed = false
    for (let i = 0; i < amounts.length && remainder > 0; i++) {
      if (shares[i]! < amounts[i]!) {
        shares[i]! += 1
        remainder -= 1
        progressed = true
      }
    }
    if (!progressed) break
  }
  return shares
}

export function extractReturnedHash(conditionHash: string | null | undefined): string | null {
  if (!conditionHash) return null
  const colon = conditionHash.indexOf(':')
  return colon > 0 ? conditionHash.slice(0, colon) : null
}

export function computeReturnedHash(returnedMap: Map<string, number>): string {
  const returnedPairs = [...returnedMap.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
  return createHash('sha256').update(JSON.stringify(returnedPairs)).digest('hex').slice(0, 16)
}

/** 统一核心余额规则：F - R - (C + U)，pending/unknown 补差继续占额。 */
export function orderRefundableBalance(db: Database, orderId: string): OrderBalanceSnapshot {
  const order = db.one<{ amount: number }>('SELECT amount FROM orders WHERE id=?', orderId)
  const paidCents = order?.amount ?? 0
  const refundedCents = db.one<{ total: number }>(
    `SELECT COALESCE(SUM(r.amount),0) AS total
     FROM refunds r
     JOIN payments p ON p.id=r.payment_id
     WHERE p.order_id=? AND r.reason IN ('cancelled','after-sale')`,
    orderId
  )!.total
  const compensatedCents = db.one<{ total: number }>(
    `SELECT COALESCE(SUM(confirmed_cents),0) AS total
     FROM compensation_receipts
     WHERE order_id=? AND channel_status<>'failed'`,
    orderId
  )!.total
  return {
    paidCents,
    refundedCents,
    compensatedCents,
    remainingCents: Math.max(0, paidCents - refundedCents - compensatedCents)
  }
}

function unitPaidShares(item: OrderLineForUnitComp): number[] {
  const shares: number[] = []
  for (let u = 0; u < item.count; u++) {
    const discountUnit = Math.floor(item.discount_share * (u + 1) / item.count)
      - Math.floor(item.discount_share * u / item.count)
    shares.push(Math.max(0, item.price - discountUnit))
  }
  return shares
}

/** 按单据时间与条件指纹还原每次补差在各 SKU 具体件位上的分摊，避免退件已领补差转嫁给留件或漏扣退件退款。 */
export function orderCompensationByUnit(
  db: Database,
  orderId: string,
  options?: {
    items?: OrderLineForUnitComp[]
    now?: number
    excludeDraftId?: string
    includePending?: boolean
  }
): UnitCompensationSnapshot {
  const items = [...(options?.items ?? db.all<OrderLineForUnitComp>(
    'SELECT sku_id,price,count,discount_share FROM order_items WHERE order_id=? ORDER BY sku_id ASC, rowid ASC',
    orderId
  ))].sort((a, b) => (a.sku_id < b.sku_id ? -1 : a.sku_id > b.sku_id ? 1 : 0))
  const unitPaidBySku = new Map<string, number[]>()
  const unitReceiptedBySku = new Map<string, number[]>()
  const unitPendingBySku = new Map<string, number[]>()
  const unitPeakTargetBySku = new Map<string, number[]>()
  const livePendingBaselineBySku = new Map<string, number[]>()
  const itemMap = new Map<string, OrderLineForUnitComp>()

  for (const item of items) {
    itemMap.set(item.sku_id, item)
    unitPaidBySku.set(item.sku_id, unitPaidShares(item))
    unitReceiptedBySku.set(item.sku_id, new Array(item.count).fill(0))
    unitPendingBySku.set(item.sku_id, new Array(item.count).fill(0))
    unitPeakTargetBySku.set(item.sku_id, new Array(item.count).fill(0))
    livePendingBaselineBySku.set(item.sku_id, new Array(item.count).fill(0))
  }

  // 所有占用可退件序的售后（含 refund-rejected）按申请顺序分配件区间 [start, end)
  const saleRows = db.all<{ id: string; state: string; created: number; sku_id: string; count: number }>(
    `SELECT s.id, s.state, s.created, a.sku_id, a.count
     FROM after_sales s
     JOIN after_sale_items a ON a.after_sale_id=s.id
     WHERE s.order_id=? AND s.state NOT IN ('rejected','withdrawn','closed')
     ORDER BY s.created ASC, s.sequence ASC, s.id ASC, a.rowid ASC`,
    orderId
  )

  const consumedSoFar = new Map<string, number>()
  const afterSaleSlices = new Map<string, Map<string, { start: number; end: number }>>()
  const compReturnCount = new Map<string, number>()
  const timeline: Array<{ created: number; counts: Map<string, number>; returnedHash: string }> = [
    { created: -1, counts: new Map(), returnedHash: computeReturnedHash(new Map()) }
  ]

  let currentSaleId: string | null = null
  let currentSaleCreated = 0
  let currentSaleCountsForComp = false
  let currentSaleItems: Array<{ sku_id: string; count: number }> = []

  const flushSale = () => {
    if (!currentSaleId) return
    if (currentSaleCountsForComp) {
      for (const row of currentSaleItems) {
        compReturnCount.set(row.sku_id, (compReturnCount.get(row.sku_id) ?? 0) + row.count)
      }
      timeline.push({
        created: currentSaleCreated,
        counts: new Map(compReturnCount),
        returnedHash: computeReturnedHash(compReturnCount)
      })
    }
    currentSaleId = null
    currentSaleItems = []
  }

  for (const row of saleRows) {
    const start = consumedSoFar.get(row.sku_id) ?? 0
    const end = start + row.count
    consumedSoFar.set(row.sku_id, end)
    let sliceMap = afterSaleSlices.get(row.id)
    if (!sliceMap) {
      sliceMap = new Map()
      afterSaleSlices.set(row.id, sliceMap)
    }
    sliceMap.set(row.sku_id, { start, end })

    if (row.id !== currentSaleId) {
      flushSale()
      currentSaleId = row.id
      currentSaleCreated = row.created
      currentSaleCountsForComp = row.state !== 'refund-rejected'
    }
    currentSaleItems.push({ sku_id: row.sku_id, count: row.count })
  }
  flushSale()

  interface DraftReceiptRow {
    draft_id: string
    created_at: number
    expires_at: number
    per_line: string
    condition_hash: string | null
    capped_cents: number
    status: string
    receipt_id: string | null
    confirmed_cents: number | null
    channel_status: string | null
  }

  const draftRows = db.all<DraftReceiptRow>(
    `SELECT d.id AS draft_id, d.created_at, d.expires_at, d.per_line, d.condition_hash,
            d.capped_cents, d.status,
            r.receipt_id, r.confirmed_cents, r.channel_status
     FROM compensation_drafts d
     LEFT JOIN compensation_receipts r ON r.draft_id=d.id
     WHERE d.order_id=?
     ORDER BY d.created_at ASC, d.rowid ASC`,
    orderId
  )
  const now = options?.now ?? Date.now()

  const countsAtEntry = (entry: DraftReceiptRow): Map<string, number> => {
    const storedHash = extractReturnedHash(entry.condition_hash)
    if (storedHash) {
      const tieMatches = timeline.filter((step, idx) => {
        const nextCreated = timeline[idx + 1]?.created ?? Infinity
        return step.created <= entry.created_at && entry.created_at <= nextCreated && step.returnedHash === storedHash
      })
      if (tieMatches.length > 0) return tieMatches[tieMatches.length - 1]!.counts
    }
    let chosen = timeline[0]!.counts
    for (let i = 1; i < timeline.length; i++) {
      if (timeline[i]!.created < entry.created_at) chosen = timeline[i]!.counts
      else break
    }
    return chosen
  }

  for (const entry of draftRows) {
    // 已明确失败的补差回执按规则释放原占用
    if (entry.receipt_id !== null && entry.channel_status === 'failed') continue
    const isReceipt = entry.receipt_id !== null
    const isLivePending = !isReceipt && entry.status === 'pending' && entry.expires_at > now
    const amountCents = isReceipt ? Number(entry.confirmed_cents) : entry.capped_cents
    if (amountCents <= 0) continue

    const priorReturned = countsAtEntry(entry)
    let parsedLines: Array<{ order_line_id: string; delta_cents: number }> = []
    try {
      const raw = JSON.parse(entry.per_line)
      if (Array.isArray(raw)) {
        parsedLines = raw
          .filter(x => x && typeof x.order_line_id === 'string' && Number.isFinite(x.delta_cents))
          .map(x => ({ order_line_id: x.order_line_id, delta_cents: Math.max(0, Math.trunc(x.delta_cents)) }))
      }
    } catch {
      parsedLines = []
    }

    const lineSum = parsedLines.reduce((s, l) => s + l.delta_cents, 0)
    const scaledLines = lineSum > 0
      ? (lineSum === amountCents
          ? parsedLines
          : allocateDeltaAcrossLines(parsedLines.map(l => l.delta_cents), amountCents)
              .map((delta_cents, i) => ({ order_line_id: parsedLines[i]!.order_line_id, delta_cents })))
      : (() => {
          const fallbackWeights = items.map(item => {
            const ret = Math.min(item.count, priorReturned.get(item.sku_id) ?? 0)
            const paid = unitPaidBySku.get(item.sku_id) ?? []
            const rec = unitReceiptedBySku.get(item.sku_id) ?? []
            const basePend = livePendingBaselineBySku.get(item.sku_id) ?? []
            let rem = 0
            for (let u = ret; u < item.count; u++) rem += Math.max(0, paid[u]! - rec[u]! - basePend[u]!)
            return rem
          })
          return allocateDeltaAcrossLines(fallbackWeights, amountCents).map((delta_cents, i) => ({
            order_line_id: items[i]!.sku_id,
            delta_cents
          }))
        })()

    for (const { order_line_id: skuId, delta_cents } of scaledLines) {
      if (delta_cents <= 0) continue
      const item = itemMap.get(skuId)
      if (!item || item.count <= 0) continue
      const paid = unitPaidBySku.get(skuId)!
      const rec = unitReceiptedBySku.get(skuId)!
      const pend = unitPendingBySku.get(skuId)!
      const peak = unitPeakTargetBySku.get(skuId)!
      const basePend = livePendingBaselineBySku.get(skuId)!
      const startIdx = Math.min(item.count, Math.max(0, priorReturned.get(skuId) ?? 0))
      const slotIndices: number[] = []
      for (let u = startIdx < item.count ? startIdx : 0; u < item.count; u++) slotIndices.push(u)

      const remainingWeights = slotIndices.map(u => Math.max(0, paid[u]! - rec[u]! - basePend[u]!))
      const totalRem = remainingWeights.reduce((s, v) => s + v, 0)
      const weights = totalRem >= delta_cents
        ? remainingWeights
        : slotIndices.map(u => Math.max(1, paid[u]!))
      const shares = allocateDeltaAcrossLines(weights, delta_cents)
      for (let j = 0; j < slotIndices.length; j++) {
        const idx = slotIndices[j]!
        const share = shares[j]!
        const targetAtEntry = rec[idx]! + basePend[idx]! + share
        if (targetAtEntry > peak[idx]!) peak[idx] = targetAtEntry
        if (isReceipt) {
          rec[idx]! += share
        } else if (isLivePending) {
          basePend[idx]! += share
          if (options?.includePending && entry.draft_id !== options.excludeDraftId) {
            pend[idx]! += share
          }
        }
      }
    }
  }

  return {
    unitPaidBySku,
    unitReceiptedBySku,
    unitPendingBySku,
    unitPeakTargetBySku,
    afterSaleSlices
  }
}
