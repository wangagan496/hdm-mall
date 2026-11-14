import { z } from 'zod'

export const billRowSchema = z.object({
  kind: z.enum(['payment', 'refund']), businessId: z.string().min(1).max(100),
  channelId: z.string().min(1).max(120), amountCents: z.number().int().positive().safe(),
  state: z.enum(['pending', 'succeeded', 'failed']), occurredAt: z.number().int().nonnegative().safe()
}).strict()
export type BillRow = z.infer<typeof billRowSchema>
export function beijingDate(time: number) { return new Date(time + 8 * 3600_000).toISOString().slice(0, 10) }
export const billDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(date => {
  const time = Date.parse(date + 'T00:00:00+08:00')
  return Number.isFinite(time) && beijingDate(time) === date
}, '请输入有效日期')
export function billDay(date: string) {
  const value = billDateSchema.parse(date), start = Date.parse(value + 'T00:00:00+08:00')
  return { start, end: start + 86400_000 }
}
