// 生成文件勿手改；来源 contract-kit/v1/spending-guard/schema.ts
export type SpendingLimitType = "per_order" | "monthly_budget"
export type WishlistStatus = "waiting" | "cancelled" | "confirmed" | "expired"
export interface WishlistGoodsLine {
  skuId: string
  productId: string
  name: string
  spec: string
  picture: string
  unitPriceCents: number
  count: number
}
export interface SpendingRule {
  id: string | null
  version: number
  monthlyBudgetCents: number | null
  perOrderLimitCents: number | null
  cooldownThresholdCents: number | null
  cooldownHours: number | null
  enabled: boolean
  monthDisclosure: string
  createdAt: number
}
export interface SpendingRuleInput {
  requestKey: string
  expectedVersion: number
  monthlyBudgetCents: number | null
  perOrderLimitCents: number | null
  cooldownThresholdCents: number | null
  cooldownHours: number | null
  enabled: boolean
  disclosureAccepted: boolean
}
export interface SpendingSummary {
  monthKey: string
  ruleVersion: number
  enabled: boolean
  monthlyBudgetCents: number | null
  perOrderLimitCents: number | null
  cooldownThresholdCents: number | null
  cooldownHours: number | null
  spentCents: number
  reservedCents: number
  remainingBudgetCents: number | null
  waitingWishlistCount: number
  monthDisclosure: string
}
export interface SpendingPauseDetail {
  limitType: SpendingLimitType
  amountCents: number
  limitCents: number
  ruleVersion: number
  monthKey: string
  spentCents: number
  reservedCents: number
  remainingBudgetCents: number | null
}
export interface WishlistItem {
  id: string
  requestKey: string
  status: WishlistStatus
  goods: WishlistGoodsLine[]
  addressId: string
  expectedAmountCents: number
  quotedTotalCents: number
  currentQuotedTotalCents: number | null
  priceChanged: boolean
  promotionRevision: number | null
  ruleVersion: number | null
  cooldownUntil: number
  readyToConfirm: boolean
  createdAt: number
}
export interface WishlistConfirmInput {
  requestKey: string
  expectedAmountCents: number
  returnPolicyConfirmed?: boolean
  expectedReturnPolicyToken?: string
}
function validWishlistGoodsLine(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as WishlistGoodsLine
  if (Object.keys(row).some((key: string) => ["skuId","productId","name","spec","picture","unitPriceCents","count"].indexOf(key) < 0)) return false
  return (typeof row.skuId === 'string' && row.skuId.length >= 1 && row.skuId.length <= 100) &&
    (typeof row.productId === 'string' && row.productId.length >= 1 && row.productId.length <= 100) &&
    (typeof row.name === 'string' && row.name.length >= 1 && row.name.length <= 200) &&
    (typeof row.spec === 'string' && row.spec.length >= 1 && row.spec.length <= 200) &&
    (typeof row.picture === 'string' && row.picture.length >= 0 && row.picture.length <= 300) &&
    (typeof row.unitPriceCents === 'number' && Number.isSafeInteger(row.unitPriceCents) && row.unitPriceCents >= 1 && row.unitPriceCents <= 2147483647) &&
    (typeof row.count === 'number' && Number.isSafeInteger(row.count) && row.count >= 1 && row.count <= 999)
}
export function parseWishlistGoodsLine(text: string): WishlistGoodsLine | null {
  try { const value = JSON.parse(text) as WishlistGoodsLine; return validWishlistGoodsLine(value) ? value : null } catch { return null }
}
function validSpendingRule(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as SpendingRule
  if (Object.keys(row).some((key: string) => ["id","version","monthlyBudgetCents","perOrderLimitCents","cooldownThresholdCents","cooldownHours","enabled","monthDisclosure","createdAt"].indexOf(key) < 0)) return false
  return (row.id === null || (typeof row.id === 'string' && row.id.length >= 1 && row.id.length <= 100)) &&
    (typeof row.version === 'number' && Number.isSafeInteger(row.version) && row.version >= 0 && row.version <= 9007199254740991) &&
    (row.monthlyBudgetCents === null || (typeof row.monthlyBudgetCents === 'number' && Number.isSafeInteger(row.monthlyBudgetCents) && row.monthlyBudgetCents >= 1 && row.monthlyBudgetCents <= 2147483647)) &&
    (row.perOrderLimitCents === null || (typeof row.perOrderLimitCents === 'number' && Number.isSafeInteger(row.perOrderLimitCents) && row.perOrderLimitCents >= 1 && row.perOrderLimitCents <= 2147483647)) &&
    (row.cooldownThresholdCents === null || (typeof row.cooldownThresholdCents === 'number' && Number.isSafeInteger(row.cooldownThresholdCents) && row.cooldownThresholdCents >= 1 && row.cooldownThresholdCents <= 2147483647)) &&
    (row.cooldownHours === null || (typeof row.cooldownHours === 'number' && Number.isSafeInteger(row.cooldownHours) && row.cooldownHours >= 1 && row.cooldownHours <= 72)) &&
    typeof row.enabled === 'boolean' &&
    (typeof row.monthDisclosure === 'string' && row.monthDisclosure.length >= 1 && row.monthDisclosure.length <= 200) &&
    (typeof row.createdAt === 'number' && Number.isSafeInteger(row.createdAt) && row.createdAt >= 0 && row.createdAt <= 9007199254740991)
}
export function parseSpendingRule(text: string): SpendingRule | null {
  try { const value = JSON.parse(text) as SpendingRule; return validSpendingRule(value) ? value : null } catch { return null }
}
function validSpendingRuleInput(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as SpendingRuleInput
  if (Object.keys(row).some((key: string) => ["requestKey","expectedVersion","monthlyBudgetCents","perOrderLimitCents","cooldownThresholdCents","cooldownHours","enabled","disclosureAccepted"].indexOf(key) < 0)) return false
  return (typeof row.requestKey === 'string' && row.requestKey.length >= 1 && row.requestKey.length <= 100) &&
    (typeof row.expectedVersion === 'number' && Number.isSafeInteger(row.expectedVersion) && row.expectedVersion >= 0 && row.expectedVersion <= 9007199254740991) &&
    (row.monthlyBudgetCents === null || (typeof row.monthlyBudgetCents === 'number' && Number.isSafeInteger(row.monthlyBudgetCents) && row.monthlyBudgetCents >= 1 && row.monthlyBudgetCents <= 2147483647)) &&
    (row.perOrderLimitCents === null || (typeof row.perOrderLimitCents === 'number' && Number.isSafeInteger(row.perOrderLimitCents) && row.perOrderLimitCents >= 1 && row.perOrderLimitCents <= 2147483647)) &&
    (row.cooldownThresholdCents === null || (typeof row.cooldownThresholdCents === 'number' && Number.isSafeInteger(row.cooldownThresholdCents) && row.cooldownThresholdCents >= 1 && row.cooldownThresholdCents <= 2147483647)) &&
    (row.cooldownHours === null || (typeof row.cooldownHours === 'number' && Number.isSafeInteger(row.cooldownHours) && row.cooldownHours >= 1 && row.cooldownHours <= 72)) &&
    typeof row.enabled === 'boolean' &&
    typeof row.disclosureAccepted === 'boolean'
}
export function parseSpendingRuleInput(text: string): SpendingRuleInput | null {
  try { const value = JSON.parse(text) as SpendingRuleInput; return validSpendingRuleInput(value) ? value : null } catch { return null }
}
function validSpendingSummary(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as SpendingSummary
  if (Object.keys(row).some((key: string) => ["monthKey","ruleVersion","enabled","monthlyBudgetCents","perOrderLimitCents","cooldownThresholdCents","cooldownHours","spentCents","reservedCents","remainingBudgetCents","waitingWishlistCount","monthDisclosure"].indexOf(key) < 0)) return false
  return (typeof row.monthKey === 'string' && row.monthKey.length >= 7 && row.monthKey.length <= 7) &&
    (typeof row.ruleVersion === 'number' && Number.isSafeInteger(row.ruleVersion) && row.ruleVersion >= 0 && row.ruleVersion <= 9007199254740991) &&
    typeof row.enabled === 'boolean' &&
    (row.monthlyBudgetCents === null || (typeof row.monthlyBudgetCents === 'number' && Number.isSafeInteger(row.monthlyBudgetCents) && row.monthlyBudgetCents >= 1 && row.monthlyBudgetCents <= 2147483647)) &&
    (row.perOrderLimitCents === null || (typeof row.perOrderLimitCents === 'number' && Number.isSafeInteger(row.perOrderLimitCents) && row.perOrderLimitCents >= 1 && row.perOrderLimitCents <= 2147483647)) &&
    (row.cooldownThresholdCents === null || (typeof row.cooldownThresholdCents === 'number' && Number.isSafeInteger(row.cooldownThresholdCents) && row.cooldownThresholdCents >= 1 && row.cooldownThresholdCents <= 2147483647)) &&
    (row.cooldownHours === null || (typeof row.cooldownHours === 'number' && Number.isSafeInteger(row.cooldownHours) && row.cooldownHours >= 1 && row.cooldownHours <= 72)) &&
    (typeof row.spentCents === 'number' && Number.isSafeInteger(row.spentCents) && row.spentCents >= 0 && row.spentCents <= 2147483647) &&
    (typeof row.reservedCents === 'number' && Number.isSafeInteger(row.reservedCents) && row.reservedCents >= 0 && row.reservedCents <= 2147483647) &&
    (row.remainingBudgetCents === null || (typeof row.remainingBudgetCents === 'number' && Number.isSafeInteger(row.remainingBudgetCents) && row.remainingBudgetCents >= 0 && row.remainingBudgetCents <= 2147483647)) &&
    (typeof row.waitingWishlistCount === 'number' && Number.isSafeInteger(row.waitingWishlistCount) && row.waitingWishlistCount >= 0 && row.waitingWishlistCount <= 9007199254740991) &&
    (typeof row.monthDisclosure === 'string' && row.monthDisclosure.length >= 1 && row.monthDisclosure.length <= 200)
}
export function parseSpendingSummary(text: string): SpendingSummary | null {
  try { const value = JSON.parse(text) as SpendingSummary; return validSpendingSummary(value) ? value : null } catch { return null }
}
function validSpendingPauseDetail(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as SpendingPauseDetail
  if (Object.keys(row).some((key: string) => ["limitType","amountCents","limitCents","ruleVersion","monthKey","spentCents","reservedCents","remainingBudgetCents"].indexOf(key) < 0)) return false
  return (typeof row.limitType === 'string' && ["per_order","monthly_budget"].indexOf(row.limitType) >= 0) &&
    (typeof row.amountCents === 'number' && Number.isSafeInteger(row.amountCents) && row.amountCents >= 1 && row.amountCents <= 2147483647) &&
    (typeof row.limitCents === 'number' && Number.isSafeInteger(row.limitCents) && row.limitCents >= 1 && row.limitCents <= 2147483647) &&
    (typeof row.ruleVersion === 'number' && Number.isSafeInteger(row.ruleVersion) && row.ruleVersion >= 1 && row.ruleVersion <= 9007199254740991) &&
    (typeof row.monthKey === 'string' && row.monthKey.length >= 7 && row.monthKey.length <= 7) &&
    (typeof row.spentCents === 'number' && Number.isSafeInteger(row.spentCents) && row.spentCents >= 0 && row.spentCents <= 2147483647) &&
    (typeof row.reservedCents === 'number' && Number.isSafeInteger(row.reservedCents) && row.reservedCents >= 0 && row.reservedCents <= 2147483647) &&
    (row.remainingBudgetCents === null || (typeof row.remainingBudgetCents === 'number' && Number.isSafeInteger(row.remainingBudgetCents) && row.remainingBudgetCents >= 0 && row.remainingBudgetCents <= 2147483647))
}
export function parseSpendingPauseDetail(text: string): SpendingPauseDetail | null {
  try { const value = JSON.parse(text) as SpendingPauseDetail; return validSpendingPauseDetail(value) ? value : null } catch { return null }
}
function validWishlistItem(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as WishlistItem
  if (Object.keys(row).some((key: string) => ["id","requestKey","status","goods","addressId","expectedAmountCents","quotedTotalCents","currentQuotedTotalCents","priceChanged","promotionRevision","ruleVersion","cooldownUntil","readyToConfirm","createdAt"].indexOf(key) < 0)) return false
  return (typeof row.id === 'string' && row.id.length >= 1 && row.id.length <= 100) &&
    (typeof row.requestKey === 'string' && row.requestKey.length >= 1 && row.requestKey.length <= 100) &&
    (typeof row.status === 'string' && ["waiting","cancelled","confirmed","expired"].indexOf(row.status) >= 0) &&
    (Array.isArray(row.goods) && row.goods.length >= 1 && row.goods.length <= 100 && row.goods.every((item: WishlistGoodsLine) => validWishlistGoodsLine(item))) &&
    (typeof row.addressId === 'string' && row.addressId.length >= 1 && row.addressId.length <= 100) &&
    (typeof row.expectedAmountCents === 'number' && Number.isSafeInteger(row.expectedAmountCents) && row.expectedAmountCents >= 1 && row.expectedAmountCents <= 2147483647) &&
    (typeof row.quotedTotalCents === 'number' && Number.isSafeInteger(row.quotedTotalCents) && row.quotedTotalCents >= 1 && row.quotedTotalCents <= 2147483647) &&
    (row.currentQuotedTotalCents === null || (typeof row.currentQuotedTotalCents === 'number' && Number.isSafeInteger(row.currentQuotedTotalCents) && row.currentQuotedTotalCents >= 1 && row.currentQuotedTotalCents <= 2147483647)) &&
    typeof row.priceChanged === 'boolean' &&
    (row.promotionRevision === null || (typeof row.promotionRevision === 'number' && Number.isSafeInteger(row.promotionRevision) && row.promotionRevision >= 1 && row.promotionRevision <= 9007199254740991)) &&
    (row.ruleVersion === null || (typeof row.ruleVersion === 'number' && Number.isSafeInteger(row.ruleVersion) && row.ruleVersion >= 1 && row.ruleVersion <= 9007199254740991)) &&
    (typeof row.cooldownUntil === 'number' && Number.isSafeInteger(row.cooldownUntil) && row.cooldownUntil >= 0 && row.cooldownUntil <= 9007199254740991) &&
    typeof row.readyToConfirm === 'boolean' &&
    (typeof row.createdAt === 'number' && Number.isSafeInteger(row.createdAt) && row.createdAt >= 0 && row.createdAt <= 9007199254740991)
}
export function parseWishlistItem(text: string): WishlistItem | null {
  try { const value = JSON.parse(text) as WishlistItem; return validWishlistItem(value) ? value : null } catch { return null }
}
function validWishlistConfirmInput(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as WishlistConfirmInput
  if (Object.keys(row).some((key: string) => ["requestKey","expectedAmountCents","returnPolicyConfirmed","expectedReturnPolicyToken"].indexOf(key) < 0)) return false
  return (typeof row.requestKey === 'string' && row.requestKey.length >= 1 && row.requestKey.length <= 100) &&
    (typeof row.expectedAmountCents === 'number' && Number.isSafeInteger(row.expectedAmountCents) && row.expectedAmountCents >= 1 && row.expectedAmountCents <= 2147483647) &&
    (row.returnPolicyConfirmed === undefined || typeof row.returnPolicyConfirmed === 'boolean') &&
    (row.expectedReturnPolicyToken === undefined || (typeof row.expectedReturnPolicyToken === 'string' && row.expectedReturnPolicyToken.length >= 64 && row.expectedReturnPolicyToken.length <= 64))
}
export function parseWishlistConfirmInput(text: string): WishlistConfirmInput | null {
  try { const value = JSON.parse(text) as WishlistConfirmInput; return validWishlistConfirmInput(value) ? value : null } catch { return null }
}
