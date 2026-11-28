// 花钱刹车与待买清单契约唯一来源；只使用生成器支持的受限 Zod 类型。
import { z } from '../../server/node_modules/zod/index.js'

const id = z.string().min(1).max(100)
const shortText = z.string().min(1).max(200)
const pictureText = z.string().min(0).max(300)
const monthKeyText = z.string().min(7).max(7)
const positiveCents = z.number().int().min(1).max(2147483647)
const nonNegativeCents = z.number().int().min(0).max(2147483647)
const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const positiveInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const nonNegativeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const cooldownHoursSchema = z.number().int().min(1).max(72)

export const SpendingLimitTypeSchema = z.enum(['per_order', 'monthly_budget'])
export const WishlistStatusSchema = z.enum(['waiting', 'cancelled', 'confirmed', 'expired'])

export const WishlistGoodsLineSchema = z.object({
  skuId: id,
  productId: id,
  name: shortText,
  spec: shortText,
  picture: pictureText,
  unitPriceCents: positiveCents,
  count: z.number().int().min(1).max(999)
}).strict()

export const SpendingRuleSchema = z.object({
  id: id.nullable(),
  version: nonNegativeInt,
  monthlyBudgetCents: positiveCents.nullable(),
  perOrderLimitCents: positiveCents.nullable(),
  cooldownThresholdCents: positiveCents.nullable(),
  cooldownHours: cooldownHoursSchema.nullable(),
  enabled: z.boolean(),
  monthDisclosure: shortText,
  createdAt: timestamp
}).strict()

export const SpendingRuleInputSchema = z.object({
  requestKey: id,
  expectedVersion: nonNegativeInt,
  monthlyBudgetCents: positiveCents.nullable(),
  perOrderLimitCents: positiveCents.nullable(),
  cooldownThresholdCents: positiveCents.nullable(),
  cooldownHours: cooldownHoursSchema.nullable(),
  enabled: z.boolean(),
  disclosureAccepted: z.boolean()
}).strict()

export const SpendingSummarySchema = z.object({
  monthKey: monthKeyText,
  ruleVersion: nonNegativeInt,
  enabled: z.boolean(),
  monthlyBudgetCents: positiveCents.nullable(),
  perOrderLimitCents: positiveCents.nullable(),
  cooldownThresholdCents: positiveCents.nullable(),
  cooldownHours: cooldownHoursSchema.nullable(),
  spentCents: nonNegativeCents,
  reservedCents: nonNegativeCents,
  remainingBudgetCents: nonNegativeCents.nullable(),
  waitingWishlistCount: nonNegativeInt,
  monthDisclosure: shortText
}).strict()

export const SpendingPauseDetailSchema = z.object({
  limitType: SpendingLimitTypeSchema,
  amountCents: positiveCents,
  limitCents: positiveCents,
  ruleVersion: positiveInt,
  monthKey: monthKeyText,
  spentCents: nonNegativeCents,
  reservedCents: nonNegativeCents,
  remainingBudgetCents: nonNegativeCents.nullable()
}).strict()

export const WishlistItemSchema = z.object({
  id,
  requestKey: id,
  status: WishlistStatusSchema,
  goods: z.array(WishlistGoodsLineSchema).min(1).max(100),
  addressId: id,
  expectedAmountCents: positiveCents,
  quotedTotalCents: positiveCents,
  currentQuotedTotalCents: positiveCents.nullable(),
  priceChanged: z.boolean(),
  promotionRevision: positiveInt.nullable(),
  ruleVersion: positiveInt.nullable(),
  cooldownUntil: timestamp,
  readyToConfirm: z.boolean(),
  createdAt: timestamp
}).strict()

export const WishlistConfirmInputSchema = z.object({
  requestKey: id,
  expectedAmountCents: positiveCents,
  returnPolicyConfirmed: z.boolean().optional(),
  expectedReturnPolicyToken: z.string().min(64).max(64).optional()
}).strict()

export type SpendingLimitType = z.infer<typeof SpendingLimitTypeSchema>
export type WishlistStatus = z.infer<typeof WishlistStatusSchema>
export type WishlistGoodsLine = z.infer<typeof WishlistGoodsLineSchema>
export type SpendingRule = z.infer<typeof SpendingRuleSchema>
export type SpendingRuleInput = z.infer<typeof SpendingRuleInputSchema>
export type SpendingSummary = z.infer<typeof SpendingSummarySchema>
export type SpendingPauseDetail = z.infer<typeof SpendingPauseDetailSchema>
export type WishlistItem = z.infer<typeof WishlistItemSchema>
export type WishlistConfirmInput = z.infer<typeof WishlistConfirmInputSchema>

export const spendingGuardEnums = {
  SpendingLimitType: SpendingLimitTypeSchema,
  WishlistStatus: WishlistStatusSchema
}

export const spendingGuardSchemas = {
  WishlistGoodsLine: WishlistGoodsLineSchema,
  SpendingRule: SpendingRuleSchema,
  SpendingRuleInput: SpendingRuleInputSchema,
  SpendingSummary: SpendingSummarySchema,
  SpendingPauseDetail: SpendingPauseDetailSchema,
  WishlistItem: WishlistItemSchema,
  WishlistConfirmInput: WishlistConfirmInputSchema
}
