import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { Database } from '../database.ts'
import type { User } from '../accounts.ts'
import { AppError, ensure } from '../errors.ts'
import { quotePromotion } from '../promotions.ts'
import { QuoteRequestSchema, QuoteResponseSchema, QuoteLineSchema, QuoteRuleSchema } from '../../../contract-kit/v1/quote-preview/schema.ts'
import type { QuoteItem, QuoteLine, QuoteRule, QuoteReason, QuoteResponse, QuoteComparison } from './generated.ts'

interface SnapshotRow {
  skuId: string | null; price: number; stock: number; enabled: number; status: string; revision: number
  productName: string; spec: string
  threshold: number; discount: number; ruleEnabled: number; ruleRevision: number
}
const receiptSchema = z.object({
  v: z.literal(1), subject: z.string().min(1), lines: z.array(QuoteLineSchema.omit({ observedAt: true })).max(100),
  rule: QuoteRuleSchema, amountCents: z.number().int().nonnegative().safe(), quoteId: z.string().max(32)
}).strict()
type Receipt = z.infer<typeof receiptSchema>

function safeMoney(amount: bigint): number {
  ensure(amount >= 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER), 400, '报价金额超出安全整数分范围')
  return Number(amount)
}

function money(cents: number): string { return '¥' + (cents / 100).toFixed(2) }
function ruleText(rule: QuoteRule): string { return `满 ${money(rule.thresholdCents)} 减 ${money(rule.discountCents)}` }
function promotionChange(before: QuoteRule, after: QuoteRule): string {
  if (!after.enabled) return before.enabled ? `满减已停用（原${ruleText(before)}）` : '满减设置已修改，目前仍未启用'
  if (!before.enabled) return `满减已启用：${ruleText(after)}`
  if (before.thresholdCents === after.thresholdCents && before.discountCents === after.discountCents) return `满减规则已更新，优惠不变：${ruleText(after)}`
  return `满减规则已修改：${ruleText(before)} → ${ruleText(after)}`
}

// 整篮与逐项移除始终调用这里，不维护第二套满减算法。
export function calculateQuote(lines: QuoteLine[], rule: QuoteRule) {
  const subtotalCents = safeMoney(lines.reduce((sum, line) => sum + BigInt(line.unitPriceCents) * BigInt(line.count), 0n))
  const promotion = quotePromotion(rule, subtotalCents)
  return { subtotalCents, amountCents: promotion.amountCents, promotion }
}

export class QuotePreview {
  private readonly secret: string | Buffer
  constructor(privateDb: Database, secret?: string) {
    this.db = privateDb
    this.secret = secret ?? randomBytes(32)
  }
  private readonly db: Database
  private signature(body: string): Buffer { return createHmac('sha256', this.secret).update('hdm-quote-preview-v1\0').update(body).digest() }
  private previous(receipt: string | undefined, subject: string): Receipt | null {
    if (!receipt) return null
    try {
      const parts = receipt.split('.')
      if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) return null
      const signature = Buffer.from(parts[1]!, 'base64url')
      if (!timingSafeEqual(this.signature(parts[0]!), signature)) return null
      const parsed = receiptSchema.safeParse(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')))
      return parsed.success && parsed.data.subject === subject ? parsed.data : null
    } catch { return null }
  }
  preview(user: User, input: unknown, observedAt: number): QuoteResponse {
    ensure(user.role === 'buyer', 403, '需要买家身份')
    const request = QuoteRequestSchema.parse(input)
    const items: QuoteItem[] = request.items ?? this.db.all<QuoteItem>('SELECT sku_id AS skuId,count FROM carts WHERE user_id=? AND selected=1 ORDER BY sku_id', user.id)
    ensure(items.length <= 100, 400, '一次最多报价100种规格')
    ensure(new Set(items.map(item => item.skuId)).size === items.length, 400, '商品规格重复')
    for (const item of items) ensure(typeof item.skuId === 'string' && item.skuId.length > 0 && Number.isSafeInteger(item.count) && item.count > 0 && item.count <= 999, 400, '商品规格或数量不正确')
    const sorted = [...items].sort((a, b) => a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0)
    // 单条 SELECT 同时观察商品与规则；只读，完全不经过 Catalog/Orders 的过期维护。
    const rows = this.db.all<SnapshotRow>(`SELECT s.id AS skuId,s.price,s.stock,s.enabled,p.name AS productName,s.spec,p.status,p.revision,
      r.threshold,r.discount,r.enabled AS ruleEnabled,r.revision AS ruleRevision
      FROM promotions r LEFT JOIN skus s ON s.id IN (${sorted.map(() => '?').join(',') || 'NULL'})
      LEFT JOIN products p ON p.id=s.product_id WHERE r.id=1`, ...sorted.map(item => item.skuId))
    const first = rows[0]!
    const rule: QuoteRule = { enabled: first.ruleEnabled === 1, revision: first.ruleRevision, thresholdCents: first.threshold, discountCents: first.discount }
    QuoteRuleSchema.parse(rule)
    const signed = this.previous(request.previousReceipt, user.id)
    const previous = signed && JSON.stringify(signed.lines.map(line => ({ skuId: line.skuId, count: line.count }))) === JSON.stringify(sorted) ? signed : null
    const reasons: QuoteReason[] = []
    const lines: QuoteLine[] = []
    for (const item of sorted) {
      const row = rows.find(row => row.skuId === item.skuId)
      const old = previous?.lines.find(line => line.skuId === item.skuId)
      if (!row) {
        reasons.push({ kind: 'missing', skuId: item.skuId, message: '有一件商品已不存在', beforeCents: old?.unitPriceCents ?? null, afterCents: null })
        continue
      }
      const name = `『${row.productName} ${row.spec}』`
      if (row.status !== 'on' || row.enabled !== 1) reasons.push({ kind: 'off', skuId: item.skuId, message: name + (row.status !== 'on' ? '已下架' : '该规格已停售'), beforeCents: null, afterCents: null })
      if (row.stock < item.count) reasons.push({ kind: 'stock', skuId: item.skuId, message: `${name}库存不足，需要 ${item.count} 件，可用 ${row.stock} 件`, beforeCents: null, afterCents: null })
      ensure(Number.isSafeInteger(row.price) && row.price > 0 && Number.isSafeInteger(row.revision), 400, '商品价格或版本不正确')
      const line: QuoteLine = { ...item, productName: row.productName, spec: row.spec, unitPriceCents: row.price, subtotalCents: safeMoney(BigInt(row.price) * BigInt(item.count)), productRevision: row.revision, observedAt }
      lines.push(line)
      if (old && old.unitPriceCents !== row.price) reasons.push({ kind: 'unit-price', skuId: item.skuId, message: `${name}单价从 ${money(old.unitPriceCents)} 调到 ${money(row.price)}`, beforeCents: old.unitPriceCents, afterCents: row.price })
    }
    if (previous && JSON.stringify(previous.rule) !== JSON.stringify(rule)) reasons.push({
      kind: 'promotion', skuId: '', message: promotionChange(previous.rule, rule),
      beforeCents: previous.rule.discountCents, afterCents: rule.discountCents
    })
    const unavailable = reasons.some(reason => ['off', 'stock', 'missing'].includes(reason.kind))
    if (unavailable) {
      // 不移除失效行、不声称存在新的可下单实付；差额未知，不伪造为零。
      throw new AppError(reasons.some(r => r.kind === 'missing') ? 400 : 409, reasons.map(r => r.message).join('；'), 'QUOTE_UNAVAILABLE', {
        reasons, previousQuoteId: previous?.quoteId ?? null, previousAmountCents: previous?.amountCents ?? null,
        amountCents: null, deltaCents: null, observedAt
      })
    }
    const quote = calculateQuote(lines, rule)
    const identityLines = lines.map(({ observedAt: _time, ...line }) => line)
    const quoteId = createHash('sha256').update(JSON.stringify(['quote-v1', identityLines, rule])).digest('hex').slice(0, 12).toUpperCase()
    const body = Buffer.from(JSON.stringify({ v: 1, subject: user.id, lines: identityLines, rule, amountCents: quote.amountCents, quoteId })).toString('base64url')
    const comparison: QuoteComparison | null = previous ? { previousQuoteId: previous.quoteId, previousAmountCents: previous.amountCents,
      deltaCents: quote.amountCents - previous.amountCents, beforeRule: previous.rule, afterRule: rule, reasons } : null
    const result: QuoteResponse = {
      quoteId, observedAt, receipt: body + '.' + this.signature(body).toString('base64url'), lines,
      subtotalCents: quote.subtotalCents, amountCents: quote.amountCents,
      promotion: { rule, hit: quote.promotion.discountCents > 0, appliedDiscountCents: quote.promotion.discountCents, remainingCents: quote.promotion.remainingCents },
      details: [...lines.map(line => ({ label: `${line.productName} ${line.spec} ${money(line.unitPriceCents)} × ${line.count}`, rule: 'sku-price/product-revision', ruleVersion: line.productRevision, moneyCents: line.subtotalCents })),
        { label: '全店满减', rule: 'promotion', ruleVersion: rule.revision, moneyCents: -quote.promotion.discountCents },
        { label: '实付', rule: 'quote-v1', ruleVersion: 1, moneyCents: quote.amountCents }],
      removals: lines.map(line => {
        const without = calculateQuote(lines.filter(other => other.skuId !== line.skuId), rule)
        return { skuId: line.skuId, removedCount: line.count, amountWithoutCents: without.amountCents,
          decreaseCents: quote.amountCents - without.amountCents,
          losesPromotion: quote.promotion.discountCents > 0 && without.promotion.discountCents === 0,
          remainingCents: without.promotion.remainingCents }
      }), comparison
    }
    return QuoteResponseSchema.parse(result)
  }
}
