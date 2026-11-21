// 生成文件勿手改；来源 contract-kit/v1/quote-preview/schema.ts
export interface QuoteItem {
  skuId: string
  count: number
}
export interface QuoteRequest {
  items?: QuoteItem[]
  previousReceipt?: string
}
export interface QuoteRule {
  enabled: boolean
  revision: number
  thresholdCents: number
  discountCents: number
}
export interface QuoteLine {
  skuId: string
  productName: string
  spec: string
  count: number
  unitPriceCents: number
  subtotalCents: number
  productRevision: number
  observedAt: number
}
export interface QuotePromotion {
  rule: QuoteRule
  hit: boolean
  appliedDiscountCents: number
  remainingCents: number
}
export interface QuoteDetail {
  label: string
  rule: string
  ruleVersion: number
  moneyCents: number
}
export interface QuoteRemoval {
  skuId: string
  removedCount: number
  amountWithoutCents: number
  decreaseCents: number
  losesPromotion: boolean
  remainingCents: number
}
export interface QuoteReason {
  kind: string
  skuId: string
  message: string
  beforeCents: number | null
  afterCents: number | null
}
export interface QuoteComparison {
  previousQuoteId: string
  previousAmountCents: number
  deltaCents: number
  beforeRule: QuoteRule
  afterRule: QuoteRule
  reasons: QuoteReason[]
}
export interface QuoteResponse {
  quoteId: string
  observedAt: number
  receipt: string
  lines: QuoteLine[]
  promotion: QuotePromotion
  subtotalCents: number
  amountCents: number
  details: QuoteDetail[]
  removals: QuoteRemoval[]
  comparison: QuoteComparison | null
}
function validQuoteItem(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as QuoteItem
  if (Object.keys(row).some((key: string) => ["skuId","count"].indexOf(key) < 0)) return false
  return (typeof row.skuId === 'string' && row.skuId.length >= 1 && row.skuId.length <= 100) &&
    (typeof row.count === 'number' && Number.isSafeInteger(row.count) && row.count >= 1 && row.count <= 999)
}
export function parseQuoteItem(text: string): QuoteItem | null {
  try { const value = JSON.parse(text) as QuoteItem; return validQuoteItem(value) ? value : null } catch { return null }
}
function validQuoteRequest(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as QuoteRequest
  if (Object.keys(row).some((key: string) => ["items","previousReceipt"].indexOf(key) < 0)) return false
  return (row.items === undefined || (Array.isArray(row.items) && row.items.length <= 100 && row.items.every((item: QuoteItem) => validQuoteItem(item)))) &&
    (row.previousReceipt === undefined || (typeof row.previousReceipt === 'string' && row.previousReceipt.length <= 65536))
}
export function parseQuoteRequest(text: string): QuoteRequest | null {
  try { const value = JSON.parse(text) as QuoteRequest; return validQuoteRequest(value) ? value : null } catch { return null }
}
function validQuoteRule(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as QuoteRule
  if (Object.keys(row).some((key: string) => ["enabled","revision","thresholdCents","discountCents"].indexOf(key) < 0)) return false
  return typeof row.enabled === 'boolean' &&
    (typeof row.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision >= 1 && row.revision <= 9007199254740991) &&
    (typeof row.thresholdCents === 'number' && Number.isSafeInteger(row.thresholdCents) && row.thresholdCents >= 0 && row.thresholdCents <= 9007199254740991) &&
    (typeof row.discountCents === 'number' && Number.isSafeInteger(row.discountCents) && row.discountCents >= 0 && row.discountCents <= 9007199254740991)
}
export function parseQuoteRule(text: string): QuoteRule | null {
  try { const value = JSON.parse(text) as QuoteRule; return validQuoteRule(value) ? value : null } catch { return null }
}
function validQuoteLine(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as QuoteLine
  if (Object.keys(row).some((key: string) => ["skuId","productName","spec","count","unitPriceCents","subtotalCents","productRevision","observedAt"].indexOf(key) < 0)) return false
  return (typeof row.skuId === 'string' && row.skuId.length >= 1 && row.skuId.length <= 100) &&
    (typeof row.productName === 'string' && row.productName.length >= 1 && row.productName.length <= 100) &&
    (typeof row.spec === 'string' && row.spec.length >= 1 && row.spec.length <= 60) &&
    (typeof row.count === 'number' && Number.isSafeInteger(row.count) && row.count >= 1 && row.count <= 999) &&
    (typeof row.unitPriceCents === 'number' && Number.isSafeInteger(row.unitPriceCents) && row.unitPriceCents >= 0 && row.unitPriceCents <= 9007199254740991) &&
    (typeof row.subtotalCents === 'number' && Number.isSafeInteger(row.subtotalCents) && row.subtotalCents >= 0 && row.subtotalCents <= 9007199254740991) &&
    (typeof row.productRevision === 'number' && Number.isSafeInteger(row.productRevision) && row.productRevision >= 1 && row.productRevision <= 9007199254740991) &&
    (typeof row.observedAt === 'number' && Number.isSafeInteger(row.observedAt) && row.observedAt >= 0 && row.observedAt <= 9007199254740991)
}
export function parseQuoteLine(text: string): QuoteLine | null {
  try { const value = JSON.parse(text) as QuoteLine; return validQuoteLine(value) ? value : null } catch { return null }
}
function validQuotePromotion(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as QuotePromotion
  if (Object.keys(row).some((key: string) => ["rule","hit","appliedDiscountCents","remainingCents"].indexOf(key) < 0)) return false
  return validQuoteRule(row.rule) &&
    typeof row.hit === 'boolean' &&
    (typeof row.appliedDiscountCents === 'number' && Number.isSafeInteger(row.appliedDiscountCents) && row.appliedDiscountCents >= 0 && row.appliedDiscountCents <= 9007199254740991) &&
    (typeof row.remainingCents === 'number' && Number.isSafeInteger(row.remainingCents) && row.remainingCents >= 0 && row.remainingCents <= 9007199254740991)
}
export function parseQuotePromotion(text: string): QuotePromotion | null {
  try { const value = JSON.parse(text) as QuotePromotion; return validQuotePromotion(value) ? value : null } catch { return null }
}
function validQuoteDetail(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as QuoteDetail
  if (Object.keys(row).some((key: string) => ["label","rule","ruleVersion","moneyCents"].indexOf(key) < 0)) return false
  return (typeof row.label === 'string' && row.label.length >= 1 && row.label.length <= 200) &&
    (typeof row.rule === 'string' && row.rule.length >= 1 && row.rule.length <= 100) &&
    (typeof row.ruleVersion === 'number' && Number.isSafeInteger(row.ruleVersion) && row.ruleVersion >= 1 && row.ruleVersion <= 9007199254740991) &&
    (typeof row.moneyCents === 'number' && Number.isSafeInteger(row.moneyCents) && row.moneyCents >= -9007199254740991 && row.moneyCents <= 9007199254740991)
}
export function parseQuoteDetail(text: string): QuoteDetail | null {
  try { const value = JSON.parse(text) as QuoteDetail; return validQuoteDetail(value) ? value : null } catch { return null }
}
function validQuoteRemoval(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as QuoteRemoval
  if (Object.keys(row).some((key: string) => ["skuId","removedCount","amountWithoutCents","decreaseCents","losesPromotion","remainingCents"].indexOf(key) < 0)) return false
  return (typeof row.skuId === 'string' && row.skuId.length >= 1 && row.skuId.length <= 100) &&
    (typeof row.removedCount === 'number' && Number.isSafeInteger(row.removedCount) && row.removedCount >= 1 && row.removedCount <= 999) &&
    (typeof row.amountWithoutCents === 'number' && Number.isSafeInteger(row.amountWithoutCents) && row.amountWithoutCents >= 0 && row.amountWithoutCents <= 9007199254740991) &&
    (typeof row.decreaseCents === 'number' && Number.isSafeInteger(row.decreaseCents) && row.decreaseCents >= -9007199254740991 && row.decreaseCents <= 9007199254740991) &&
    typeof row.losesPromotion === 'boolean' &&
    (typeof row.remainingCents === 'number' && Number.isSafeInteger(row.remainingCents) && row.remainingCents >= 0 && row.remainingCents <= 9007199254740991)
}
export function parseQuoteRemoval(text: string): QuoteRemoval | null {
  try { const value = JSON.parse(text) as QuoteRemoval; return validQuoteRemoval(value) ? value : null } catch { return null }
}
function validQuoteReason(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as QuoteReason
  if (Object.keys(row).some((key: string) => ["kind","skuId","message","beforeCents","afterCents"].indexOf(key) < 0)) return false
  return (typeof row.kind === 'string' && ["unit-price","promotion","off","stock","missing"].indexOf(row.kind) >= 0) &&
    (typeof row.skuId === 'string' && row.skuId.length <= 100) &&
    (typeof row.message === 'string' && row.message.length >= 1 && row.message.length <= 500) &&
    (row.beforeCents === null || (typeof row.beforeCents === 'number' && Number.isSafeInteger(row.beforeCents) && row.beforeCents >= 0 && row.beforeCents <= 9007199254740991)) &&
    (row.afterCents === null || (typeof row.afterCents === 'number' && Number.isSafeInteger(row.afterCents) && row.afterCents >= 0 && row.afterCents <= 9007199254740991))
}
export function parseQuoteReason(text: string): QuoteReason | null {
  try { const value = JSON.parse(text) as QuoteReason; return validQuoteReason(value) ? value : null } catch { return null }
}
function validQuoteComparison(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as QuoteComparison
  if (Object.keys(row).some((key: string) => ["previousQuoteId","previousAmountCents","deltaCents","beforeRule","afterRule","reasons"].indexOf(key) < 0)) return false
  return (typeof row.previousQuoteId === 'string' && row.previousQuoteId.length >= 1 && row.previousQuoteId.length <= 32) &&
    (typeof row.previousAmountCents === 'number' && Number.isSafeInteger(row.previousAmountCents) && row.previousAmountCents >= 0 && row.previousAmountCents <= 9007199254740991) &&
    (typeof row.deltaCents === 'number' && Number.isSafeInteger(row.deltaCents) && row.deltaCents >= -9007199254740991 && row.deltaCents <= 9007199254740991) &&
    validQuoteRule(row.beforeRule) &&
    validQuoteRule(row.afterRule) &&
    (Array.isArray(row.reasons) && row.reasons.length <= 201 && row.reasons.every((item: QuoteReason) => validQuoteReason(item)))
}
export function parseQuoteComparison(text: string): QuoteComparison | null {
  try { const value = JSON.parse(text) as QuoteComparison; return validQuoteComparison(value) ? value : null } catch { return null }
}
function validQuoteResponse(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as QuoteResponse
  if (Object.keys(row).some((key: string) => ["quoteId","observedAt","receipt","lines","promotion","subtotalCents","amountCents","details","removals","comparison"].indexOf(key) < 0)) return false
  return (typeof row.quoteId === 'string' && row.quoteId.length >= 1 && row.quoteId.length <= 32) &&
    (typeof row.observedAt === 'number' && Number.isSafeInteger(row.observedAt) && row.observedAt >= 0 && row.observedAt <= 9007199254740991) &&
    (typeof row.receipt === 'string' && row.receipt.length >= 1 && row.receipt.length <= 65536) &&
    (Array.isArray(row.lines) && row.lines.length <= 100 && row.lines.every((item: QuoteLine) => validQuoteLine(item))) &&
    validQuotePromotion(row.promotion) &&
    (typeof row.subtotalCents === 'number' && Number.isSafeInteger(row.subtotalCents) && row.subtotalCents >= 0 && row.subtotalCents <= 9007199254740991) &&
    (typeof row.amountCents === 'number' && Number.isSafeInteger(row.amountCents) && row.amountCents >= 0 && row.amountCents <= 9007199254740991) &&
    (Array.isArray(row.details) && row.details.length <= 102 && row.details.every((item: QuoteDetail) => validQuoteDetail(item))) &&
    (Array.isArray(row.removals) && row.removals.length <= 100 && row.removals.every((item: QuoteRemoval) => validQuoteRemoval(item))) &&
    (row.comparison === null || validQuoteComparison(row.comparison))
}
export function parseQuoteResponse(text: string): QuoteResponse | null {
  try { const value = JSON.parse(text) as QuoteResponse; return validQuoteResponse(value) ? value : null } catch { return null }
}
