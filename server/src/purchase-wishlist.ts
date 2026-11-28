import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Database } from './database.ts'
import { requireBuyer, type User } from './accounts.ts'
import type { Catalog } from './catalog.ts'
import { AppError, ensure } from './errors.ts'
import { promotionQuote } from './promotions.ts'
import { policyDigest, policyToken, presentPolicy } from './return-policy.ts'
import type { WishlistGoodsLine, WishlistItem } from './spending-guard/generated.ts'

export const wishlistConfirmInputSchema = z.object({
  requestKey: z.string().min(1).max(100),
  expectedAmountCents: z.number().int().min(1).max(2147483647),
  returnPolicyConfirmed: z.boolean().optional(),
  expectedReturnPolicyToken: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict()

interface WishlistRow {
  id: string
  user_id: string
  request_key: string
  goods: string
  address_id: string
  expected_amount_cents: number
  quoted_total_cents: number
  promotion_revision: number | null
  rule_version: number | null
  return_policy_confirmed: number
  expected_return_policy_token: string | null
  cooldown_until: number
  status: 'waiting' | 'cancelled' | 'confirmed' | 'expired'
  created_at: number
}

export interface WishlistOrderCreationInput {
  requestKey: string
  expectedAmountCents: number
  addressId: string
  goods: { skuId: string; count: number }[]
  returnPolicyConfirmed?: boolean
  expectedReturnPolicyToken?: string
}

export type CreateOrderFromWishlistFn = (user: User, data: WishlistOrderCreationInput, wishlistId: string) => { id: string }

export function normalizeGoodsKey(goods: ReadonlyArray<{ skuId: string; count: number }>): string {
  return JSON.stringify(
    [...goods]
      .map(g => ({ skuId: g.skuId, count: g.count }))
      .sort((a, b) => a.skuId.localeCompare(b.skuId))
  )
}

function parseGoodsSnapshot(raw: string): WishlistGoodsLine[] {
  return JSON.parse(raw) as WishlistGoodsLine[]
}

function sameGoodsSnapshot(raw: string, normalizedKey: string): boolean {
  try {
    return normalizeGoodsKey(parseGoodsSnapshot(raw)) === normalizedKey
  } catch {
    return false
  }
}

function requoteSnapshot(
  db: Database,
  catalog: Catalog,
  lines: WishlistGoodsLine[]
): { currentTotalCents: number | null; promotionRevision: number; promotion: ReturnType<typeof promotionQuote>; pricedLines: Array<{ skuId: string; name: string; spec: string; priceCents: number; count: number; subtotalCents: number }>; policyGoods: Array<{ skuId: string; name: string; returnPolicy: 'standard' | 'law-excluded' | 'confirm-required'; returnPolicyReason: '' | 'custom' | 'perishable' | 'digital' | 'periodical' | 'unsealed' | 'activated' | 'near-expiry' | 'defect'; returnPolicyNote: string }>; needsPolicyConfirm: boolean } {
  const fetched = []
  for (const line of lines) {
    try {
      const sku = catalog.sku(line.skuId)
      if (sku.status !== 'on' || sku.enabled !== 1) {
        const promo = promotionQuote(db, 0)
        return { currentTotalCents: null, promotionRevision: promo.rule.revision, promotion: promo, pricedLines: [], policyGoods: [], needsPolicyConfirm: false }
      }
      fetched.push({ ...sku, count: line.count })
    } catch {
      const promo = promotionQuote(db, 0)
      return { currentTotalCents: null, promotionRevision: promo.rule.revision, promotion: promo, pricedLines: [], policyGoods: [], needsPolicyConfirm: false }
    }
  }
  const subtotal = fetched.reduce((sum, item) => sum + item.price * item.count, 0)
  const promo = promotionQuote(db, subtotal)
  const policyGoods = fetched.map(item => ({ skuId: item.id, name: item.name, ...presentPolicy(item) }))
  return {
    currentTotalCents: promo.amountCents,
    promotionRevision: promo.rule.revision,
    promotion: promo,
    pricedLines: fetched.map(item => ({
      skuId: item.id,
      name: item.name,
      spec: item.spec,
      priceCents: item.price,
      count: item.count,
      subtotalCents: item.price * item.count
    })),
    policyGoods,
    needsPolicyConfirm: fetched.some(item => item.return_policy === 'confirm-required')
  }
}

function presentWishlistRow(db: Database, catalog: Catalog, row: WishlistRow, now: number): WishlistItem {
  const goods = parseGoodsSnapshot(row.goods)
  let currentQuotedTotalCents: number | null = null
  let priceChanged = false
  if (row.status === 'waiting') {
    const q = requoteSnapshot(db, catalog, goods)
    currentQuotedTotalCents = q.currentTotalCents
    priceChanged = q.currentTotalCents === null ||
      q.currentTotalCents !== row.quoted_total_cents ||
      q.promotionRevision !== row.promotion_revision
  }
  return {
    id: row.id,
    requestKey: row.request_key,
    status: row.status,
    goods,
    addressId: row.address_id,
    expectedAmountCents: row.expected_amount_cents,
    quotedTotalCents: row.quoted_total_cents,
    currentQuotedTotalCents,
    priceChanged,
    promotionRevision: row.promotion_revision,
    ruleVersion: row.rule_version,
    cooldownUntil: row.cooldown_until,
    readyToConfirm: row.status === 'waiting' && now >= row.cooldown_until,
    createdAt: row.created_at
  }
}

/** 校验是否存在同一购买意图（未到期 waiting / 取消后未到期重建）冷静限制。 */
export function findActiveCooldownBlocker(
  db: Database,
  userId: string,
  goods: ReadonlyArray<{ skuId: string; count: number }>,
  quotedTotalCents: number,
  now: number,
  options?: { excludeWishlistId?: string; ruleCooldownThresholdCents?: number | null }
): { waitingBlocker: WishlistRow | null; maxUnexpiredUntil: number } {
  const targetKey = normalizeGoodsKey(goods)
  const targetSkuSet = new Set(goods.map(g => g.skuId))
  const rows = db.all<WishlistRow>(
    "SELECT * FROM purchase_wishlist WHERE user_id=? AND status IN ('waiting','cancelled') AND cooldown_until > ? ORDER BY cooldown_until DESC, created_at DESC",
    userId, now
  )
  let waitingBlocker: WishlistRow | null = null
  let maxUnexpiredUntil = 0

  for (const row of rows) {
    if (options?.excludeWishlistId && row.id === options.excludeWishlistId) continue
    const parsed = parseGoodsSnapshot(row.goods)
    const exactMatch = sameGoodsSnapshot(row.goods, targetKey)
    const thresholdFloor = options?.ruleCooldownThresholdCents ?? row.quoted_total_cents
    const skuOverlapAbove = parsed.some(g => targetSkuSet.has(g.skuId)) && quotedTotalCents >= Math.min(row.quoted_total_cents, thresholdFloor)
    if (!exactMatch && !skuOverlapAbove) continue

    if (row.cooldown_until > maxUnexpiredUntil) maxUnexpiredUntil = row.cooldown_until
    if (row.status === 'waiting' && !waitingBlocker) {
      waitingBlocker = row
    }
  }
  return { waitingBlocker, maxUnexpiredUntil }
}

export function enqueue(
  db: Database,
  user: User,
  input: {
    requestKey: string
    goods: WishlistGoodsLine[]
    addressId: string
    expectedAmountCents: number
    quotedTotalCents: number
    promotionRevision: number | null
    ruleVersion: number | null
    returnPolicyConfirmed?: boolean
    expectedReturnPolicyToken?: string | null
    cooldownHours: number
    minCooldownUntil?: number
  },
  now: number
): { wishlistItemId: string; cooldownUntil: number; quotedTotalCents: number; status: WishlistRow['status'] } {
  requireBuyer(user)
  const normalizedGoods = [...input.goods].sort((a, b) => a.skuId.localeCompare(b.skuId))
  const goodsJson = JSON.stringify(normalizedGoods)

  const existing = db.one<WishlistRow>('SELECT * FROM purchase_wishlist WHERE user_id=? AND request_key=?', user.id, input.requestKey)
  if (existing) {
    ensure(
      existing.address_id === input.addressId &&
      existing.expected_amount_cents === input.expectedAmountCents &&
      sameGoodsSnapshot(existing.goods, normalizeGoodsKey(normalizedGoods)),
      409,
      '同一次待买请求不能修改商品或收货地址'
    )
    return {
      wishlistItemId: existing.id,
      cooldownUntil: existing.cooldown_until,
      quotedTotalCents: existing.quoted_total_cents,
      status: existing.status
    }
  }

  const computedUntil = now + input.cooldownHours * 3600_000
  const cooldownUntil = Math.max(computedUntil, input.minCooldownUntil ?? 0)
  const id = randomUUID()
  db.run(
    `INSERT INTO purchase_wishlist(
      id,user_id,request_key,goods,address_id,expected_amount_cents,quoted_total_cents,
      promotion_revision,rule_version,return_policy_confirmed,expected_return_policy_token,
      cooldown_until,status,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'waiting',?)`,
    id, user.id, input.requestKey, goodsJson, input.addressId, input.expectedAmountCents,
    input.quotedTotalCents, input.promotionRevision, input.ruleVersion,
    Number(input.returnPolicyConfirmed === true), input.expectedReturnPolicyToken ?? null,
    cooldownUntil, now
  )
  return { wishlistItemId: id, cooldownUntil, quotedTotalCents: input.quotedTotalCents, status: 'waiting' }
}

export function listWishlist(db: Database, catalog: Catalog, user: User, now: number): WishlistItem[] {
  requireBuyer(user)
  const rows = db.all<WishlistRow>(
    'SELECT * FROM purchase_wishlist WHERE user_id=? ORDER BY created_at DESC, rowid DESC',
    user.id
  )
  return rows.map(row => presentWishlistRow(db, catalog, row, now))
}

export function detailWishlist(db: Database, catalog: Catalog, user: User, id: string, now: number): WishlistItem {
  requireBuyer(user)
  const row = db.one<WishlistRow>('SELECT * FROM purchase_wishlist WHERE id=?', id)
  ensure(row, 404, '待买记录不存在')
  ensure(row.user_id === user.id, 403, '无权查看他人待买记录')
  return presentWishlistRow(db, catalog, row, now)
}

export function cancelWishlist(db: Database, catalog: Catalog, user: User, id: string, _now: number): WishlistItem {
  requireBuyer(user)
  return db.transaction(() => {
    const row = db.one<WishlistRow>('SELECT * FROM purchase_wishlist WHERE id=?', id)
    ensure(row, 404, '待买记录不存在')
    ensure(row.user_id === user.id, 403, '无权操作他人待买记录')
    if (row.status === 'cancelled') return presentWishlistRow(db, catalog, row, _now)
    ensure(row.status === 'waiting', 409, '只有冷静期中的待买记录可以取消')
    db.run("UPDATE purchase_wishlist SET status='cancelled' WHERE id=? AND user_id=? AND status='waiting'", id, user.id)
    return presentWishlistRow(db, catalog, db.one<WishlistRow>('SELECT * FROM purchase_wishlist WHERE id=?', id)!, _now)
  })
}

export function confirmWishlist(
  db: Database,
  catalog: Catalog,
  user: User,
  id: string,
  rawInput: unknown,
  createOrder: CreateOrderFromWishlistFn,
  now: number
): { id: string; orderId: string; wishlistItemId: string } {
  requireBuyer(user)
  const data = wishlistConfirmInputSchema.parse(rawInput)
  const precheck = db.transaction(():
    | { kind: 'already_confirmed'; result: { id: string; orderId: string; wishlistItemId: string } }
    | { kind: 'price_changed'; data: Record<string, unknown> }
    | { kind: 'ready'; orderInput: WishlistOrderCreationInput; wishlistId: string } => {
    const row = db.one<WishlistRow>('SELECT * FROM purchase_wishlist WHERE id=?', id)
    ensure(row, 404, '待买记录不存在')
    ensure(row.user_id === user.id, 403, '无权确认他人待买记录')

    if (row.status === 'confirmed') {
      const existingOrder = db.one<{ id: string }>('SELECT id FROM orders WHERE owner_id=? AND request_key=?', user.id, data.requestKey)
      if (existingOrder) {
        return { kind: 'already_confirmed', result: { id: existingOrder.id, orderId: existingOrder.id, wishlistItemId: row.id } }
      }
      throw new AppError(409, '该待买记录已确认下单', 'WISHLIST_ALREADY_CONFIRMED')
    }

    ensure(row.status === 'waiting', 409, '当前待买记录不可确认')

    if (now < row.cooldown_until) {
      throw new AppError(409, '冷静期尚未结束，到期后再本人确认', 'COOLDOWN_ACTIVE', {
        wishlistItemId: row.id,
        cooldownUntil: row.cooldown_until
      })
    }

    const parsedGoods = parseGoodsSnapshot(row.goods)
    const blocker = findActiveCooldownBlocker(db, user.id, parsedGoods, data.expectedAmountCents, now, {
      excludeWishlistId: row.id
    })
    if (blocker.maxUnexpiredUntil > now) {
      throw new AppError(409, '相同购买意图仍在冷静期限制内', 'COOLDOWN_ACTIVE', {
        wishlistItemId: blocker.waitingBlocker?.id ?? row.id,
        cooldownUntil: blocker.maxUnexpiredUntil
      })
    }

    const quote = requoteSnapshot(db, catalog, parsedGoods)
    if (quote.currentTotalCents === null) {
      throw new AppError(409, '部分商品已下架或停售，无法确认下单', 'PRODUCT_UNAVAILABLE')
    }

    const priceOrPromoChanged = quote.currentTotalCents !== data.expectedAmountCents ||
      quote.currentTotalCents !== row.quoted_total_cents ||
      quote.promotionRevision !== row.promotion_revision

    if (priceOrPromoChanged) {
      // 先提交刷新待买项最新报价，再向外抛出 PRICE_CHANGED 要求买家重新确认新金额
      db.run(
        'UPDATE purchase_wishlist SET quoted_total_cents=?, promotion_revision=? WHERE id=?',
        quote.currentTotalCents, quote.promotionRevision, row.id
      )
      return {
        kind: 'price_changed',
        data: {
          totalAmountCents: quote.currentTotalCents,
          promotionRevision: quote.promotionRevision,
          promotion: quote.promotion,
          goods: quote.pricedLines
        }
      }
    }

    const currentPolicyDigest = policyDigest(quote.policyGoods)
    const currentPolicyTok = policyToken(quote.policyGoods, user)
    let effectiveConfirmed = false
    let effectiveToken: string | undefined = undefined

    if (data.returnPolicyConfirmed === true && data.expectedReturnPolicyToken) {
      effectiveConfirmed = true
      effectiveToken = data.expectedReturnPolicyToken
    } else if (row.return_policy_confirmed === 1) {
      if (row.expected_return_policy_token && row.expected_return_policy_token !== currentPolicyDigest) {
        throw new AppError(409, '商品退货规则有变化，请核对后重新确认', 'RETURN_POLICY_CHANGED', {
          goods: quote.policyGoods,
          returnPolicyToken: currentPolicyTok
        })
      }
      effectiveConfirmed = true
      effectiveToken = currentPolicyTok
    } else if (quote.needsPolicyConfirm) {
      throw new AppError(409, '请先了解并确认商品的退货限制', 'RETURN_POLICY_CONFIRM_REQUIRED', {
        goods: quote.policyGoods,
        returnPolicyToken: currentPolicyTok
      })
    }

    return {
      kind: 'ready',
      wishlistId: row.id,
      orderInput: {
        requestKey: data.requestKey,
        expectedAmountCents: data.expectedAmountCents,
        addressId: row.address_id,
        goods: parsedGoods.map(g => ({ skuId: g.skuId, count: g.count })),
        ...(effectiveConfirmed ? { returnPolicyConfirmed: true } : {}),
        ...(effectiveToken ? { expectedReturnPolicyToken: effectiveToken } : {})
      }
    }
  })
  if (precheck.kind === 'already_confirmed') return precheck.result
  if (precheck.kind === 'price_changed') {
    throw new AppError(409, '商品价格或满减已更新，请核对新报价后再确认', 'PRICE_CHANGED', precheck.data)
  }
  const created = createOrder(user, precheck.orderInput, precheck.wishlistId)
  return { id: created.id, orderId: created.id, wishlistItemId: precheck.wishlistId }
}
