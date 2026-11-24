// 生成文件勿手改；来源 contract-kit/v1/compensation/schema.ts
export type CompensationChannelStatus = "pending" | "executed" | "failed" | "unknown"
export type CompensationDraftStatus = "pending" | "pending_budget" | "confirmed" | "expired" | "cancelled"
export interface CompensationDraftLine {
  order_line_id: string
  delta_cents: number
}
export interface CompensationDraftBrief {
  draftId: string
  orderId: string
  policyId: string
  policyVersion: number
  windowDays: number
  budgetPerOrderCents: number
  basketDeltaCents: number
  cappedCents: number
  perLine: CompensationDraftLine[]
  createdAt: number
  expiresAt: number
  status: CompensationDraftStatus
}
export interface CompensationDraftDetail {
  draftId: string
  orderId: string
  policyId: string
  policyVersion: number
  windowDays: number
  budgetPerOrderCents: number
  basketDeltaCents: number
  cappedCents: number
  perLine: CompensationDraftLine[]
  createdAt: number
  expiresAt: number
  status: CompensationDraftStatus
}
export interface CompensationConfirmInput {
  draftId: string
  requestKey: string
  confirmedCents: number
}
export interface CompensationReceipt {
  receiptId: string
  draftId: string
  orderId: string
  policyId: string
  policyVersion: number
  windowDays: number
  confirmedCents: number
  confirmedAt: number
  channelStatus: CompensationChannelStatus
  channelRef: string | null
  statusLabel: string
}
function validCompensationDraftLine(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as CompensationDraftLine
  if (Object.keys(row).some((key: string) => ["order_line_id","delta_cents"].indexOf(key) < 0)) return false
  return (typeof row.order_line_id === 'string' && row.order_line_id.length >= 1 && row.order_line_id.length <= 100) &&
    (typeof row.delta_cents === 'number' && Number.isSafeInteger(row.delta_cents) && row.delta_cents >= 1 && row.delta_cents <= 2147483647)
}
export function parseCompensationDraftLine(text: string): CompensationDraftLine | null {
  try { const value = JSON.parse(text) as CompensationDraftLine; return validCompensationDraftLine(value) ? value : null } catch { return null }
}
function validCompensationDraftBrief(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as CompensationDraftBrief
  if (Object.keys(row).some((key: string) => ["draftId","orderId","policyId","policyVersion","windowDays","budgetPerOrderCents","basketDeltaCents","cappedCents","perLine","createdAt","expiresAt","status"].indexOf(key) < 0)) return false
  return (typeof row.draftId === 'string' && row.draftId.length >= 1 && row.draftId.length <= 100) &&
    (typeof row.orderId === 'string' && row.orderId.length >= 1 && row.orderId.length <= 100) &&
    (typeof row.policyId === 'string' && row.policyId.length >= 1 && row.policyId.length <= 100) &&
    (typeof row.policyVersion === 'number' && Number.isSafeInteger(row.policyVersion) && row.policyVersion >= 1 && row.policyVersion <= 9007199254740991) &&
    (typeof row.windowDays === 'number' && Number.isSafeInteger(row.windowDays) && row.windowDays >= 1 && row.windowDays <= 90) &&
    (typeof row.budgetPerOrderCents === 'number' && Number.isSafeInteger(row.budgetPerOrderCents) && row.budgetPerOrderCents >= 1 && row.budgetPerOrderCents <= 2147483647) &&
    (typeof row.basketDeltaCents === 'number' && Number.isSafeInteger(row.basketDeltaCents) && row.basketDeltaCents >= 1 && row.basketDeltaCents <= 2147483647) &&
    (typeof row.cappedCents === 'number' && Number.isSafeInteger(row.cappedCents) && row.cappedCents >= 1 && row.cappedCents <= 2147483647) &&
    (Array.isArray(row.perLine) && row.perLine.length >= 1 && row.perLine.length <= 100 && row.perLine.every((item: CompensationDraftLine) => validCompensationDraftLine(item))) &&
    (typeof row.createdAt === 'number' && Number.isSafeInteger(row.createdAt) && row.createdAt >= 0 && row.createdAt <= 9007199254740991) &&
    (typeof row.expiresAt === 'number' && Number.isSafeInteger(row.expiresAt) && row.expiresAt >= 0 && row.expiresAt <= 9007199254740991) &&
    (typeof row.status === 'string' && ["pending","pending_budget","confirmed","expired","cancelled"].indexOf(row.status) >= 0)
}
export function parseCompensationDraftBrief(text: string): CompensationDraftBrief | null {
  try { const value = JSON.parse(text) as CompensationDraftBrief; return validCompensationDraftBrief(value) ? value : null } catch { return null }
}
function validCompensationDraftDetail(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as CompensationDraftDetail
  if (Object.keys(row).some((key: string) => ["draftId","orderId","policyId","policyVersion","windowDays","budgetPerOrderCents","basketDeltaCents","cappedCents","perLine","createdAt","expiresAt","status"].indexOf(key) < 0)) return false
  return (typeof row.draftId === 'string' && row.draftId.length >= 1 && row.draftId.length <= 100) &&
    (typeof row.orderId === 'string' && row.orderId.length >= 1 && row.orderId.length <= 100) &&
    (typeof row.policyId === 'string' && row.policyId.length >= 1 && row.policyId.length <= 100) &&
    (typeof row.policyVersion === 'number' && Number.isSafeInteger(row.policyVersion) && row.policyVersion >= 1 && row.policyVersion <= 9007199254740991) &&
    (typeof row.windowDays === 'number' && Number.isSafeInteger(row.windowDays) && row.windowDays >= 1 && row.windowDays <= 90) &&
    (typeof row.budgetPerOrderCents === 'number' && Number.isSafeInteger(row.budgetPerOrderCents) && row.budgetPerOrderCents >= 1 && row.budgetPerOrderCents <= 2147483647) &&
    (typeof row.basketDeltaCents === 'number' && Number.isSafeInteger(row.basketDeltaCents) && row.basketDeltaCents >= 1 && row.basketDeltaCents <= 2147483647) &&
    (typeof row.cappedCents === 'number' && Number.isSafeInteger(row.cappedCents) && row.cappedCents >= 1 && row.cappedCents <= 2147483647) &&
    (Array.isArray(row.perLine) && row.perLine.length >= 1 && row.perLine.length <= 100 && row.perLine.every((item: CompensationDraftLine) => validCompensationDraftLine(item))) &&
    (typeof row.createdAt === 'number' && Number.isSafeInteger(row.createdAt) && row.createdAt >= 0 && row.createdAt <= 9007199254740991) &&
    (typeof row.expiresAt === 'number' && Number.isSafeInteger(row.expiresAt) && row.expiresAt >= 0 && row.expiresAt <= 9007199254740991) &&
    (typeof row.status === 'string' && ["pending","pending_budget","confirmed","expired","cancelled"].indexOf(row.status) >= 0)
}
export function parseCompensationDraftDetail(text: string): CompensationDraftDetail | null {
  try { const value = JSON.parse(text) as CompensationDraftDetail; return validCompensationDraftDetail(value) ? value : null } catch { return null }
}
function validCompensationConfirmInput(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as CompensationConfirmInput
  if (Object.keys(row).some((key: string) => ["draftId","requestKey","confirmedCents"].indexOf(key) < 0)) return false
  return (typeof row.draftId === 'string' && row.draftId.length >= 1 && row.draftId.length <= 100) &&
    (typeof row.requestKey === 'string' && row.requestKey.length >= 1 && row.requestKey.length <= 100) &&
    (typeof row.confirmedCents === 'number' && Number.isSafeInteger(row.confirmedCents) && row.confirmedCents >= 1 && row.confirmedCents <= 2147483647)
}
export function parseCompensationConfirmInput(text: string): CompensationConfirmInput | null {
  try { const value = JSON.parse(text) as CompensationConfirmInput; return validCompensationConfirmInput(value) ? value : null } catch { return null }
}
function validCompensationReceipt(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as CompensationReceipt
  if (Object.keys(row).some((key: string) => ["receiptId","draftId","orderId","policyId","policyVersion","windowDays","confirmedCents","confirmedAt","channelStatus","channelRef","statusLabel"].indexOf(key) < 0)) return false
  return (typeof row.receiptId === 'string' && row.receiptId.length >= 1 && row.receiptId.length <= 100) &&
    (typeof row.draftId === 'string' && row.draftId.length >= 1 && row.draftId.length <= 100) &&
    (typeof row.orderId === 'string' && row.orderId.length >= 1 && row.orderId.length <= 100) &&
    (typeof row.policyId === 'string' && row.policyId.length >= 1 && row.policyId.length <= 100) &&
    (typeof row.policyVersion === 'number' && Number.isSafeInteger(row.policyVersion) && row.policyVersion >= 1 && row.policyVersion <= 9007199254740991) &&
    (typeof row.windowDays === 'number' && Number.isSafeInteger(row.windowDays) && row.windowDays >= 1 && row.windowDays <= 90) &&
    (typeof row.confirmedCents === 'number' && Number.isSafeInteger(row.confirmedCents) && row.confirmedCents >= 1 && row.confirmedCents <= 2147483647) &&
    (typeof row.confirmedAt === 'number' && Number.isSafeInteger(row.confirmedAt) && row.confirmedAt >= 0 && row.confirmedAt <= 9007199254740991) &&
    (typeof row.channelStatus === 'string' && ["pending","executed","failed","unknown"].indexOf(row.channelStatus) >= 0) &&
    (row.channelRef === null || (typeof row.channelRef === 'string' && row.channelRef.length >= 1 && row.channelRef.length <= 100)) &&
    (typeof row.statusLabel === 'string' && row.statusLabel.length >= 1 && row.statusLabel.length <= 100)
}
export function parseCompensationReceipt(text: string): CompensationReceipt | null {
  try { const value = JSON.parse(text) as CompensationReceipt; return validCompensationReceipt(value) ? value : null } catch { return null }
}
