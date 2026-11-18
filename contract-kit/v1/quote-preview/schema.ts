// 报价协议唯一来源；只使用生成器支持的受限 Zod 类型。
// 复用 server 已有 Zod，不引入新的运行时依赖。
import { z } from '../../../server/node_modules/zod/index.js'

const id = z.string().min(1).max(100)
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
export const QuoteItemSchema = z.object({ skuId: id, count: z.number().int().min(1).max(999) }).strict()
export const QuoteRequestSchema = z.object({
  items: z.array(QuoteItemSchema).max(100).optional(),
  previousReceipt: z.string().max(65536).optional()
}).strict()
export const QuoteRuleSchema = z.object({
  enabled: z.boolean(), revision: version, thresholdCents: cents, discountCents: cents
}).strict()
export const QuoteLineSchema = z.object({
  skuId: id, productName: z.string().min(1).max(100), spec: z.string().min(1).max(60),
  count: z.number().int().min(1).max(999), unitPriceCents: cents, subtotalCents: cents,
  productRevision: version, observedAt: cents
}).strict()
export const QuotePromotionSchema = z.object({
  rule: QuoteRuleSchema, hit: z.boolean(), appliedDiscountCents: cents, remainingCents: cents
}).strict()
export const QuoteDetailSchema = z.object({
  label: z.string().min(1).max(200), rule: z.string().min(1).max(100), ruleVersion: version,
  moneyCents: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
}).strict()
export const QuoteRemovalSchema = z.object({
  skuId: id, removedCount: z.number().int().min(1).max(999), amountWithoutCents: cents,
  decreaseCents: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  losesPromotion: z.boolean(), remainingCents: cents
}).strict()
export const QuoteReasonSchema = z.object({
  kind: z.enum(['unit-price', 'promotion', 'off', 'stock', 'missing']),
  skuId: z.string().max(100), message: z.string().min(1).max(500),
  beforeCents: cents.nullable(), afterCents: cents.nullable()
}).strict()
export const QuoteComparisonSchema = z.object({
  previousQuoteId: z.string().min(1).max(32), previousAmountCents: cents,
  deltaCents: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  beforeRule: QuoteRuleSchema, afterRule: QuoteRuleSchema, reasons: z.array(QuoteReasonSchema).max(201)
}).strict()
export const QuoteResponseSchema = z.object({
  quoteId: z.string().min(1).max(32), observedAt: cents, receipt: z.string().min(1).max(65536),
  lines: z.array(QuoteLineSchema).max(100), promotion: QuotePromotionSchema,
  subtotalCents: cents, amountCents: cents, details: z.array(QuoteDetailSchema).max(102),
  removals: z.array(QuoteRemovalSchema).max(100), comparison: QuoteComparisonSchema.nullable()
}).strict()

export const quoteSchemas = {
  QuoteItem: QuoteItemSchema, QuoteRequest: QuoteRequestSchema, QuoteRule: QuoteRuleSchema,
  QuoteLine: QuoteLineSchema, QuotePromotion: QuotePromotionSchema, QuoteDetail: QuoteDetailSchema,
  QuoteRemoval: QuoteRemovalSchema, QuoteReason: QuoteReasonSchema,
  QuoteComparison: QuoteComparisonSchema, QuoteResponse: QuoteResponseSchema
}
