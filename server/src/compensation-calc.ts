import { createHash } from 'node:crypto'
import type { Database } from './database.ts'
import {
  allocateDeltaAcrossLines,
  computeReturnedHash,
  extractReturnedHash,
  orderCompensationByUnit,
  orderRefundableBalance,
  type OrderBalanceSnapshot
} from './balance.ts'
import { currentPromotion, quotePromotion, type Promotion } from './promotions.ts'

export { allocateDeltaAcrossLines, extractReturnedHash }

export interface PerLineDelta {
  order_line_id: string
  delta_cents: number
}

export interface OrderLineRow {
  sku_id: string
  product_id: string
  price: number
  count: number
  discount_share: number
}

export interface PolicyForCalc {
  id: string
  version: number
  window_days: number
  budget_per_order_cents: number
  total_budget_cents: number
}

export interface SkuPriceInfo {
  price: number
  enabled: number
}

export interface PriceHistoryAuditRow {
  id: number
  target_type: string
  target_id: string
  action: string
  summary: string
  created: number
  request_key: string | null
  actor_id: string | null
  change_product_id?: string | null
  promo_change_verified?: number
}

/** 从 audit_log 联合变更凭据表（product_changes / promotion_changes）加载价格与满减历史事件，确保可校验事务作用域。 */
export function loadPriceHistoryAudits(
  db: Database,
  bounds: { minCreated?: number; maxCreated: number; skuIds?: string[] }
): PriceHistoryAuditRow[] {
  const conditions: string[] = ['a.created <= ?']
  const params: Array<string | number> = [bounds.maxCreated]
  if (bounds.minCreated !== undefined) {
    conditions.push('a.created >= ?')
    params.push(bounds.minCreated)
  }
  if (bounds.skuIds && bounds.skuIds.length > 0) {
    const placeholders = bounds.skuIds.map(() => '?').join(',')
    conditions.push(
      `((a.target_type='settings' AND a.target_id='promotion' AND a.action='promotion.edit')` +
      ` OR (a.target_type='sku' AND a.action IN ('sku.price','sku.enable') AND a.target_id IN (${placeholders})))`
    )
    params.push(...bounds.skuIds)
  } else {
    conditions.push("((a.target_type='settings' AND a.target_id='promotion' AND a.action='promotion.edit') OR (a.target_type='sku' AND a.action IN ('sku.price','sku.enable')))")
  }
  return db.all<PriceHistoryAuditRow>(
    `SELECT a.id, a.target_type, a.target_id, a.action, a.summary, a.created, a.request_key, a.actor_id,
            pc.product_id AS change_product_id,
            CASE WHEN prc.request_key IS NOT NULL THEN 1 ELSE 0 END AS promo_change_verified
     FROM audit_log a
     LEFT JOIN product_changes pc
       ON a.target_type = 'sku' AND a.actor_id IS NOT NULL AND a.request_key IS NOT NULL
       AND pc.actor_id = a.actor_id AND pc.request_key = a.request_key
     LEFT JOIN promotion_changes prc
       ON a.action = 'promotion.edit' AND a.target_type = 'settings' AND a.target_id = 'promotion'
       AND a.actor_id IS NOT NULL AND a.request_key IS NOT NULL
       AND prc.request_key = a.request_key AND prc.actor_id = a.actor_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.created ASC, a.id ASC`,
    ...params
  )
}

function buildVerifiedTxScope(row: PriceHistoryAuditRow, expectedProductId?: string): string | null {
  if (!row.request_key || !row.actor_id) return null
  if (row.action === 'promotion.edit') {
    if (row.target_type !== 'settings' || row.target_id !== 'promotion' || row.promo_change_verified !== 1) return null
    return `prc:${row.actor_id}:${row.request_key}`
  }
  if (row.target_type === 'sku' && (row.action === 'sku.price' || row.action === 'sku.enable')) {
    if (!row.change_product_id) return null
    if (expectedProductId && row.change_product_id !== expectedProductId) return null
    return `pc:${row.actor_id}:${row.change_product_id}:${row.request_key}`
  }
  return null
}

export interface OrderHistoryMeta {
  created: number
  paid_at: number | null
  promotion: string | null
}

export interface CompensationComputation {
  rawBasketDeltaCents: number
  totalKeptCumulativeDeltaCents: number
  allowedCumulativeCents: number
  coveredCents: number
  marginalBasketDeltaCents: number
  cappedCents: number
  perLine: PerLineDelta[]
  returnedHash: string
  conditionHash: string
  balance: OrderBalanceSnapshot
  insufficientHistory?: boolean
}

const DAY_MS = 86_400_000

function samePromoRule(a: Promotion, b: Promotion): boolean {
  return a.thresholdCents === b.thresholdCents &&
    a.discountCents === b.discountCents &&
    a.enabled === b.enabled &&
    a.revision === b.revision
}

function parsePromoRule(raw: string | null | undefined): Promotion | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed &&
      Number.isSafeInteger(parsed.thresholdCents) &&
      Number.isSafeInteger(parsed.discountCents) &&
      typeof parsed.enabled === 'boolean' &&
      Number.isSafeInteger(parsed.revision)) {
      return {
        thresholdCents: parsed.thresholdCents,
        discountCents: parsed.discountCents,
        enabled: parsed.enabled,
        revision: parsed.revision
      }
    }
  } catch {
    return null
  }
  return null
}

/** 统一按价格/满减事件顺序与原篮在持件重建累计目标 E_i、校验历史证据连续性，再过滤退件并扣减留件已领/在途补差。 */
export function computeOrderCompensation(
  db: Database,
  order: { id: string; amount: number; created?: number; paid_at?: number | null; promotion?: string | null },
  policy: PolicyForCalc,
  now: number,
  options?: {
    promo?: Promotion
    items?: OrderLineRow[]
    returnedMap?: Map<string, number>
    skuMap?: Map<string, SkuPriceInfo>
    balance?: OrderBalanceSnapshot
    excludeDraftId?: string
    extraCoveredCents?: number
    auditRows?: PriceHistoryAuditRow[]
  }
): CompensationComputation {
  const promo = options?.promo ?? currentPromotion(db)
  const rawItems = options?.items ?? db.all<OrderLineRow>(
    'SELECT sku_id,product_id,price,count,discount_share FROM order_items WHERE order_id=? ORDER BY sku_id ASC, rowid ASC',
    order.id
  )
  // 按稳定行 ID (sku_id 字典序) 排序参与计算，保证余分按稳定行/件 ID 顺序分配、不随下单传入顺序漂移
  const items = [...rawItems].sort((a, b) => (a.sku_id < b.sku_id ? -1 : a.sku_id > b.sku_id ? 1 : 0))
  const balance = options?.balance ?? orderRefundableBalance(db, order.id)

  const orderMeta: OrderHistoryMeta = (order.created !== undefined && order.paid_at !== undefined && order.promotion !== undefined)
    ? { created: order.created, paid_at: order.paid_at, promotion: order.promotion }
    : (db.one<OrderHistoryMeta>('SELECT created,paid_at,promotion FROM orders WHERE id=?', order.id) ??
      { created: 0, paid_at: 0, promotion: null })

  const anchor = db.one<{ created_audit_seq: number | null; paid_audit_seq: number | null }>(
    'SELECT created_audit_seq, paid_audit_seq FROM order_audit_anchors WHERE order_id=?',
    order.id
  )
  const createdAnchorSeq = anchor?.created_audit_seq ?? null
  const paidAnchorSeq = anchor?.paid_audit_seq ?? null

  const saleItemRows = db.all<{ created: number; sku_id: string; count: number }>(
    `SELECT s.created, a.sku_id, a.count
     FROM after_sale_items a
     JOIN after_sales s ON s.id=a.after_sale_id
     WHERE s.order_id=? AND s.state NOT IN ('rejected','withdrawn','closed','refund-rejected')
     ORDER BY s.created ASC, s.sequence ASC, s.id ASC, a.rowid ASC`,
    order.id
  )

  let returnedMap = options?.returnedMap
  if (!returnedMap) {
    returnedMap = new Map<string, number>()
    for (const row of saleItemRows) {
      returnedMap.set(row.sku_id, (returnedMap.get(row.sku_id) ?? 0) + row.count)
    }
  }

  const returnedHash = computeReturnedHash(returnedMap)

  const emptyResult = (rawBasketDeltaCents = 0, insufficientHistory = false): CompensationComputation => ({
    rawBasketDeltaCents,
    totalKeptCumulativeDeltaCents: 0,
    allowedCumulativeCents: 0,
    coveredCents: 0,
    marginalBasketDeltaCents: 0,
    cappedCents: 0,
    perLine: [],
    returnedHash,
    conditionHash: `${returnedHash}:${policy.id}:v${policy.version}:${insufficientHistory ? 'gap' : '0'}`,
    balance,
    ...(insufficientHistory ? { insufficientHistory: true } : {})
  })

  if (!items.length || orderMeta.paid_at === null) return emptyResult(0)

  const lineCurrentInfos: SkuPriceInfo[] = []
  for (const item of items) {
    const sku = options?.skuMap?.get(item.sku_id) ??
      db.one<SkuPriceInfo>('SELECT price,enabled FROM skus WHERE id=?', item.sku_id)
    lineCurrentInfos.push(sku ?? { price: item.price, enabled: 1 })
  }

  // 加载审计链路（sku.price / sku.enable / promotion.edit）与来源变更凭据，校验连续性并按可验证业务事务身份分组
  const relevantAudits: PriceHistoryAuditRow[] = options?.auditRows
    ? options.auditRows.filter(a =>
        (a.created >= orderMeta.created || (createdAnchorSeq !== null && a.id > createdAnchorSeq)) &&
        a.created <= now &&
        ((a.target_type === 'settings' && a.target_id === 'promotion' && a.action === 'promotion.edit') ||
         (a.target_type === 'sku' && (a.action === 'sku.price' || a.action === 'sku.enable') &&
           items.some(it => it.sku_id === a.target_id)))
      )
    : loadPriceHistoryAudits(db, {
        minCreated: createdAnchorSeq !== null ? undefined : orderMeta.created,
        maxCreated: now,
        skuIds: items.map(it => it.sku_id)
      }).filter(a => a.created >= orderMeta.created || (createdAnchorSeq !== null && a.id > createdAnchorSeq))

  // 若历史订单缺乏创建/付款因果锚点且同一毫秒内存在价格/满减审计，无法判定先后顺序 -> 标记历史缺口停止自动算钱，禁止猜数
  if ((createdAnchorSeq === null && relevantAudits.some(a => a.created === orderMeta.created)) ||
      (paidAnchorSeq === null && relevantAudits.some(a => a.created === orderMeta.paid_at))) {
    return emptyResult(0, true)
  }
  if (createdAnchorSeq !== null && paidAnchorSeq !== null && paidAnchorSeq < createdAnchorSeq) {
    return emptyResult(0, true)
  }

  // 按审计链自当前状态回溯到下单起点：保留全局 (created, id) 序，并以来源变更表+actor+域+实体作用域构建事务身份 txScope
  const skuIdxById = new Map(items.map((it, idx) => [it.sku_id, idx]))
  type ParsedSkuAudit = { id: number; created: number; txScope: string | null; lineIdx: number; field: 'price' | 'enable'; before: number | boolean; after: number | boolean }
  const skuAuditsPerLine: ParsedSkuAudit[][] = items.map(() => [])
  type ParsedPromoAudit = { id: number; created: number; txScope: string | null; before: Promotion; after: Promotion }
  const promoAuditsAll: ParsedPromoAudit[] = []

  for (const row of relevantAudits) {
    if (row.target_type === 'sku') {
      const idx = skuIdxById.get(row.target_id)
      if (idx === undefined) continue
      let parsed: { before?: unknown; after?: unknown }
      try { parsed = JSON.parse(row.summary) } catch { return emptyResult(0, true) }
      const txScope = buildVerifiedTxScope(row, items[idx]!.product_id)
      if (row.action === 'sku.price') {
        if (!Number.isSafeInteger(parsed.before) || !Number.isSafeInteger(parsed.after)) return emptyResult(0, true)
        skuAuditsPerLine[idx]!.push({ id: row.id, created: row.created, txScope, lineIdx: idx, field: 'price', before: Number(parsed.before), after: Number(parsed.after) })
      } else if (row.action === 'sku.enable') {
        if (typeof parsed.before !== 'boolean' || typeof parsed.after !== 'boolean') return emptyResult(0, true)
        skuAuditsPerLine[idx]!.push({ id: row.id, created: row.created, txScope, lineIdx: idx, field: 'enable', before: parsed.before, after: parsed.after })
      }
    } else if (row.action === 'promotion.edit') {
      let parsed: { before?: unknown; after?: unknown }
      try { parsed = JSON.parse(row.summary) } catch { return emptyResult(0, true) }
      const before = typeof parsed.before === 'string' ? parsePromoRule(parsed.before) : null
      const after = typeof parsed.after === 'string' ? parsePromoRule(parsed.after) : null
      if (!before || !after) return emptyResult(0, true)
      const txScope = buildVerifiedTxScope(row)
      promoAuditsAll.push({ id: row.id, created: row.created, txScope, before, after })
    }
  }

  type PostEvent =
    | { kind: 'sku'; data: ParsedSkuAudit }
    | { kind: 'promo'; data: ParsedPromoAudit }
  const postEventById = new Map<number, PostEvent>()

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const live = lineCurrentInfos[i]!
    const events = skuAuditsPerLine[i]!
    let curPrice = live.price
    let curEnabled = live.enabled
    let splitIdx = events.length

    if (createdAnchorSeq !== null) {
      while (splitIdx > 0 && events[splitIdx - 1]!.id > createdAnchorSeq) {
        const ev = events[splitIdx - 1]!
        if (ev.created < orderMeta.created) return emptyResult(0, true)
        if (ev.field === 'price') {
          if (ev.after !== curPrice) return emptyResult(0, true)
          curPrice = Number(ev.before)
        } else {
          if (Boolean(curEnabled) !== ev.after) return emptyResult(0, true)
          curEnabled = ev.before ? 1 : 0
        }
        splitIdx--
      }
    } else {
      while (splitIdx > 0 && events[splitIdx - 1]!.created > orderMeta.created) {
        const ev = events[splitIdx - 1]!
        if (ev.field === 'price') {
          if (ev.after !== curPrice) return emptyResult(0, true)
          curPrice = Number(ev.before)
        } else {
          if (Boolean(curEnabled) !== ev.after) return emptyResult(0, true)
          curEnabled = ev.before ? 1 : 0
        }
        splitIdx--
      }
      while (splitIdx > 0 && !(curPrice === item.price && curEnabled === 1)) {
        const ev = events[splitIdx - 1]!
        if (ev.field === 'price') {
          if (ev.after !== curPrice) return emptyResult(0, true)
          curPrice = Number(ev.before)
        } else {
          if (Boolean(curEnabled) !== ev.after) return emptyResult(0, true)
          curEnabled = ev.before ? 1 : 0
        }
        splitIdx--
      }
    }
    if (curPrice !== item.price || curEnabled !== 1) {
      return emptyResult(0, true)
    }
    for (let k = splitIdx; k < events.length; k++) {
      postEventById.set(events[k]!.id, { kind: 'sku', data: events[k]! })
    }
  }

  const frozenOrderPromo = parsePromoRule(orderMeta.promotion)
  let curPromo = promo
  let promoSplit = promoAuditsAll.length
  if (createdAnchorSeq !== null) {
    while (promoSplit > 0 && promoAuditsAll[promoSplit - 1]!.id > createdAnchorSeq) {
      const pa = promoAuditsAll[promoSplit - 1]!
      if (pa.created < orderMeta.created) return emptyResult(0, true)
      if (!samePromoRule(curPromo, pa.after)) return emptyResult(0, true)
      curPromo = pa.before
      promoSplit--
    }
  } else {
    while (promoSplit > 0 && promoAuditsAll[promoSplit - 1]!.created > orderMeta.created) {
      const pa = promoAuditsAll[promoSplit - 1]!
      if (!samePromoRule(curPromo, pa.after)) return emptyResult(0, true)
      curPromo = pa.before
      promoSplit--
    }
    if (frozenOrderPromo) {
      while (promoSplit > 0 && !samePromoRule(curPromo, frozenOrderPromo)) {
        const pa = promoAuditsAll[promoSplit - 1]!
        if (!samePromoRule(curPromo, pa.after)) return emptyResult(0, true)
        curPromo = pa.before
        promoSplit--
      }
    }
  }
  if (frozenOrderPromo && !samePromoRule(curPromo, frozenOrderPromo)) return emptyResult(0, true)
  const initialPromo = frozenOrderPromo ?? curPromo
  for (let k = promoSplit; k < promoAuditsAll.length; k++) {
    postEventById.set(promoAuditsAll[k]!.id, { kind: 'promo', data: promoAuditsAll[k]! })
  }

  // 按全局持久化顺序 (created ASC, id ASC) 提取下单后事件，仅合并同一可验证原子业务事务
  const postOrderEvents = [...postEventById.values()].sort((a, b) =>
    a.data.created !== b.data.created ? a.data.created - b.data.created : a.data.id - b.data.id
  )

  // 构建每件原实付 a_{i,u}；原篮所有件参与 E_{i,u} 分配，最后再按是否仍持有过滤（退件份额永不转给留件）
  const unitOriginalPaid: number[][] = []
  const unitTargetsE: number[][] = []
  const lineOriginalPaid = items.map(item => Math.max(0, item.price * item.count - item.discount_share))

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const shares: number[] = []
    for (let u = 0; u < item.count; u++) {
      const disc = Math.floor(item.discount_share * (u + 1) / item.count) - Math.floor(item.discount_share * u / item.count)
      shares.push(Math.max(0, item.price - disc))
    }
    unitOriginalPaid.push(shares)
    unitTargetsE.push(new Array(item.count).fill(0))
  }

  // 按原子事务边界重放价格与满减快照：仅同 created 且同可验证业务事务身份 txScope 的连续事件合并为一帧，并用 paid_audit_seq 排除付款前结束的同毫秒低价
  const windowEnd = orderMeta.paid_at + policy.window_days * DAY_MS
  const priceState = items.map(it => it.price)
  const enabledState = items.map(() => 1)
  let promoState = initialPromo
  let qBestBasket = order.amount
  let rawBasketDeltaCents = 0

  let aIdx = 0
  while (aIdx < postOrderEvents.length) {
    const first = postOrderEvents[aIdx]!.data
    const t = first.created
    if (t >= windowEnd || t > now) break
    let maxFrameId = first.id
    while (aIdx < postOrderEvents.length) {
      const cur = postOrderEvents[aIdx]!.data
      if (cur.created !== t) break
      if (cur !== first && (first.txScope === null || cur.txScope !== first.txScope)) break
      maxFrameId = Math.max(maxFrameId, cur.id)
      const ev = postOrderEvents[aIdx]!
      if (ev.kind === 'sku') {
        if (ev.data.field === 'price') priceState[ev.data.lineIdx] = Number(ev.data.after)
        else enabledState[ev.data.lineIdx] = ev.data.after ? 1 : 0
      } else {
        promoState = ev.data.after
      }
      aIdx++
    }
    if ((paidAnchorSeq !== null && maxFrameId <= paidAnchorSeq) || t < orderMeta.paid_at) continue

    const grossByLine = items.map((item, idx) => (enabledState[idx] === 1 ? priceState[idx]! : item.price) * item.count)
    const subtotalT = grossByLine.reduce((s, v) => s + v, 0)
    const quotedT = quotePromotion(promoState, subtotalT)
    const qBasketT = quotedT.amountCents
    if (qBasketT < qBestBasket) {
      qBestBasket = qBasketT
      const gMinusQ = Math.max(0, order.amount - qBestBasket)
      rawBasketDeltaCents = Math.max(rawBasketDeltaCents, gMinusQ)

      const newTotalCap = Math.min(policy.budget_per_order_cents, gMinusQ)
      let allocatedSoFar = 0
      for (let i = 0; i < items.length; i++) {
        for (const eVal of unitTargetsE[i]!) allocatedSoFar += eVal
      }
      const incrementalCap = Math.max(0, newTotalCap - allocatedSoFar)
      if (incrementalCap > 0) {
        const promoDiscByLine = allocateDeltaAcrossLines(grossByLine, quotedT.discountCents)
        const weights: number[] = []
        const slotRefs: Array<{ lineIdx: number; unitIdx: number }> = []
        for (let i = 0; i < items.length; i++) {
          const cnt = items[i]!.count
          const netLineT = Math.max(0, grossByLine[i]! - promoDiscByLine[i]!)
          for (let u = 0; u < cnt; u++) {
            const qUnit = Math.floor(netLineT * (u + 1) / cnt) - Math.floor(netLineT * u / cnt)
            const aUnit = unitOriginalPaid[i]![u]!
            const eUnit = unitTargetsE[i]![u]!
            const gap = Math.max(0, aUnit - qUnit - eUnit)
            weights.push(gap)
            slotRefs.push({ lineIdx: i, unitIdx: u })
          }
        }
        const totalGap = weights.reduce((s, w) => s + w, 0)
        if (totalGap > 0) {
          const inc = allocateDeltaAcrossLines(weights, Math.min(incrementalCap, totalGap))
          for (let k = 0; k < slotRefs.length; k++) {
            const ref = slotRefs[k]!
            const eCur = unitTargetsE[ref.lineIdx]![ref.unitIdx]!
            const aUnit = unitOriginalPaid[ref.lineIdx]![ref.unitIdx]!
            unitTargetsE[ref.lineIdx]![ref.unitIdx] = Math.min(aUnit, eCur + inc[k]!)
          }
        }
      }
    }
  }

  let totalEAll = 0
  for (let i = 0; i < items.length; i++) {
    for (const eVal of unitTargetsE[i]!) totalEAll += eVal
  }
  if (totalEAll <= 0) return emptyResult(rawBasketDeltaCents)

  const unitComp = orderCompensationByUnit(db, order.id, {
    items,
    now,
    excludeDraftId: options?.excludeDraftId,
    includePending: true
  })

  // 过滤退件：仅统计仍持有件的累计目标 E 与已领/在途补差；退件已占用的 E_i 锁定于退件本身，绝不转嫁给留件
  const keptLines: Array<{ skuId: string; lineMarginal: number }> = []
  let totalKeptCumulativeDeltaCents = 0
  let keptCoveredCents = 0
  let totalMarginalFromLines = 0
  let returnedLockedUnaccountedE = 0

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const returned = Math.min(item.count, returnedMap.get(item.sku_id) ?? 0)
    const unitRec = unitComp.unitReceiptedBySku.get(item.sku_id) ?? []
    const unitPend = unitComp.unitPendingBySku.get(item.sku_id) ?? []
    const unitE = unitTargetsE[i]!

    for (let u = 0; u < returned; u++) {
      returnedLockedUnaccountedE += Math.max(0, (unitE[u] ?? 0) - (unitRec[u] ?? 0) - (unitPend[u] ?? 0))
    }

    const kept = item.count - returned
    if (kept <= 0) continue

    let lineKeptE = 0
    let lineCovered = 0
    let lineMarginal = 0
    for (let u = returned; u < item.count; u++) {
      const eu = unitE[u] ?? 0
      const cu = (unitRec[u] ?? 0) + (unitPend[u] ?? 0)
      lineKeptE += eu
      lineCovered += cu
      lineMarginal += Math.max(0, eu - cu)
    }

    totalKeptCumulativeDeltaCents += lineKeptE
    keptCoveredCents += lineCovered
    totalMarginalFromLines += lineMarginal
    if (lineMarginal > 0) {
      keptLines.push({ skuId: item.sku_id, lineMarginal })
    }
  }
  if (totalKeptCumulativeDeltaCents <= 0) return emptyResult(rawBasketDeltaCents)

  const allowedCumulativeCents = Math.min(totalKeptCumulativeDeltaCents, policy.budget_per_order_cents)
  const otherPendingDrafts = options?.excludeDraftId
    ? db.one<{ total: number }>(
        "SELECT COALESCE(SUM(capped_cents),0) AS total FROM compensation_drafts WHERE order_id=? AND id<>? AND status='pending' AND expires_at>?",
        order.id, options.excludeDraftId, now
      )!.total
    : db.one<{ total: number }>(
        "SELECT COALESCE(SUM(capped_cents),0) AS total FROM compensation_drafts WHERE order_id=? AND status='pending' AND expires_at>?",
        order.id, now
      )!.total

  // 同时满足：留件按件差额、同单所有有效非失败补差/在途/退件锁定K上限、订单可退余额
  const extraCovered = options?.extraCoveredCents ?? 0
  const totalOrderCoveredCents = balance.compensatedCents + otherPendingDrafts + returnedLockedUnaccountedE + extraCovered
  const availableByKeptNetDrop = Math.max(0, totalKeptCumulativeDeltaCents - keptCoveredCents - extraCovered)
  const availableByOrderPolicyCap = Math.max(0, policy.budget_per_order_cents - totalOrderCoveredCents)
  const availableByPolicyCap = Math.min(availableByKeptNetDrop, availableByOrderPolicyCap)
  const availableByOrderBalance = Math.max(0, balance.remainingCents - otherPendingDrafts - extraCovered)
  const cappedCents = Math.min(totalMarginalFromLines, availableByPolicyCap, availableByOrderBalance)
  const coveredCents = totalOrderCoveredCents
  const marginalBasketDeltaCents = Math.max(0, Math.min(totalKeptCumulativeDeltaCents - keptCoveredCents, totalMarginalFromLines))

  const lineAllocations = allocateDeltaAcrossLines(keptLines.map(l => l.lineMarginal), cappedCents)
  const perLine: PerLineDelta[] = []
  for (let i = 0; i < keptLines.length; i++) {
    if (lineAllocations[i]! > 0) {
      perLine.push({ order_line_id: keptLines[i]!.skuId, delta_cents: lineAllocations[i]! })
    }
  }

  const detailDigest = createHash('sha256').update(JSON.stringify({
    policyId: policy.id,
    policyVersion: policy.version,
    allowedCumulativeCents,
    cappedCents,
    perLine
  })).digest('hex').slice(0, 24)

  return {
    rawBasketDeltaCents,
    totalKeptCumulativeDeltaCents,
    allowedCumulativeCents,
    coveredCents,
    marginalBasketDeltaCents,
    cappedCents,
    perLine,
    returnedHash,
    conditionHash: `${returnedHash}:${detailDigest}`,
    balance
  }
}
