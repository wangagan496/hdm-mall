// 价保降价雷达与补差确认契约唯一来源；只使用生成器支持的受限 Zod 类型。
import { z } from '../../server/node_modules/zod/index.js'

const id = z.string().min(1).max(100)
const positiveCents = z.number().int().min(1).max(2147483647)
const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const positiveInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)

export const CompensationChannelStatusSchema = z.enum(['pending', 'executed', 'failed', 'unknown'])
export const CompensationDraftStatusSchema = z.enum(['pending', 'pending_budget', 'confirmed', 'expired', 'cancelled'])

export const CompensationDraftLineSchema = z.object({
  order_line_id: id,
  delta_cents: positiveCents
}).strict()

export const CompensationDraftBriefSchema = z.object({
  draftId: id,
  orderId: id,
  policyId: id,
  policyVersion: positiveInt,
  windowDays: z.number().int().min(1).max(90),
  budgetPerOrderCents: positiveCents,
  basketDeltaCents: positiveCents,
  cappedCents: positiveCents,
  perLine: z.array(CompensationDraftLineSchema).min(1).max(100),
  createdAt: timestamp,
  expiresAt: timestamp,
  status: CompensationDraftStatusSchema
}).strict()

export const CompensationDraftDetailSchema = CompensationDraftBriefSchema

export const CompensationConfirmInputSchema = z.object({
  draftId: id,
  requestKey: id,
  confirmedCents: positiveCents
}).strict()

export const CompensationReceiptSchema = z.object({
  receiptId: id,
  draftId: id,
  orderId: id,
  policyId: id,
  policyVersion: positiveInt,
  windowDays: z.number().int().min(1).max(90),
  confirmedCents: positiveCents,
  confirmedAt: timestamp,
  channelStatus: CompensationChannelStatusSchema,
  channelRef: z.string().min(1).max(100).nullable(),
  statusLabel: z.string().min(1).max(100)
}).strict()

export type CompensationChannelStatus = z.infer<typeof CompensationChannelStatusSchema>
export type CompensationDraftStatus = z.infer<typeof CompensationDraftStatusSchema>
export type CompensationDraftLine = z.infer<typeof CompensationDraftLineSchema>
export type CompensationDraftBrief = z.infer<typeof CompensationDraftBriefSchema>
export type CompensationDraftDetail = z.infer<typeof CompensationDraftDetailSchema>
export type CompensationConfirmInput = z.infer<typeof CompensationConfirmInputSchema>
export type CompensationReceipt = z.infer<typeof CompensationReceiptSchema>

export const compensationEnums = {
  CompensationChannelStatus: CompensationChannelStatusSchema,
  CompensationDraftStatus: CompensationDraftStatusSchema
}

export const compensationSchemas = {
  CompensationDraftLine: CompensationDraftLineSchema,
  CompensationDraftBrief: CompensationDraftBriefSchema,
  CompensationDraftDetail: CompensationDraftDetailSchema,
  CompensationConfirmInput: CompensationConfirmInputSchema,
  CompensationReceipt: CompensationReceiptSchema
}
