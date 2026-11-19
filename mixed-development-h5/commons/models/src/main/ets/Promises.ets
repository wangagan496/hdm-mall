// 生成文件勿手改；来源 contract-kit/v1/promises/schema.ts
export type PromiseFieldId = string
export type PromiseStatus = string
export type PromiseSourceField = string
export type PromiseValueType = string
export type PromiseUnit = string
export type PromiseSuggestedAfterSaleKind = string
export interface PromiseTemplateField {
  id: PromiseFieldId
  label: string
  units: PromiseUnit[]
  valueType: PromiseValueType
  categories: string[]
  suggestedAfterSaleKind?: PromiseSuggestedAfterSaleKind | null
}
export interface PromiseSourceRef {
  field: PromiseSourceField
  start: number
  end: number
  materialId?: string
}
export interface PromiseEntry {
  fieldId: PromiseFieldId
  label: string
  status: PromiseStatus
  value: string | null
  unit: PromiseUnit | null
  condition: string | null
  quote: string | null
  sourceRef: PromiseSourceRef | null
  sourceRevision: number | null
  conditionNeedsReview?: boolean
  suggestedAfterSaleKind?: PromiseSuggestedAfterSaleKind
}
export interface PromiseDraft {
  id: string
  templateVersion: string
  productRevision: number
  entries: PromiseEntry[]
  issues: string[]
}
export interface PromiseSnapshot {
  receiptId: string
  templateVersion: string
  productRevision: number
  publishedAt: number
  entries: PromiseEntry[]
}
function validPromiseTemplateField(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as PromiseTemplateField
  if (Object.keys(row).some((key: string) => ["id","label","units","valueType","categories","suggestedAfterSaleKind"].indexOf(key) < 0)) return false
  return (typeof row.id === 'string' && ["return-window","dispatch-window","shipping-cost","warranty-window","gift","material","origin","specification","shelf-life","garment-care","bag-lining","shoe-sole"].indexOf(row.id) >= 0) &&
    (typeof row.label === 'string' && row.label.length >= 1 && row.label.length <= 100) &&
    (Array.isArray(row.units) && row.units.length <= 12 && row.units.every((item: PromiseUnit) => (typeof item === 'string' && ["小时","天","周","个月","月","年","工作日"].indexOf(item) >= 0))) &&
    (typeof row.valueType === 'string' && ["number","text"].indexOf(row.valueType) >= 0) &&
    (Array.isArray(row.categories) && row.categories.length >= 1 && row.categories.length <= 30 && row.categories.every((item: string) => (typeof item === 'string' && item.length >= 1 && item.length <= 100))) &&
    (row.suggestedAfterSaleKind === undefined || (row.suggestedAfterSaleKind === null || (typeof row.suggestedAfterSaleKind === 'string' && ["return-quality"].indexOf(row.suggestedAfterSaleKind) >= 0)))
}
export function parsePromiseTemplateField(text: string): PromiseTemplateField | null {
  try { const value = JSON.parse(text) as PromiseTemplateField; return validPromiseTemplateField(value) ? value : null } catch { return null }
}
function validPromiseSourceRef(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as PromiseSourceRef
  if (Object.keys(row).some((key: string) => ["field","start","end","materialId"].indexOf(key) < 0)) return false
  return (typeof row.field === 'string' && ["name","description","imageText","specifications","material"].indexOf(row.field) >= 0) &&
    (typeof row.start === 'number' && Number.isSafeInteger(row.start) && row.start >= 0 && row.start <= 4000) &&
    (typeof row.end === 'number' && Number.isSafeInteger(row.end) && row.end >= 1 && row.end <= 4000) &&
    (row.materialId === undefined || (typeof row.materialId === 'string' && row.materialId.length >= 1 && row.materialId.length <= 100))
}
export function parsePromiseSourceRef(text: string): PromiseSourceRef | null {
  try { const value = JSON.parse(text) as PromiseSourceRef; return validPromiseSourceRef(value) ? value : null } catch { return null }
}
function validPromiseEntry(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as PromiseEntry
  if (Object.keys(row).some((key: string) => ["fieldId","label","status","value","unit","condition","quote","sourceRef","sourceRevision","conditionNeedsReview","suggestedAfterSaleKind"].indexOf(key) < 0)) return false
  return (typeof row.fieldId === 'string' && ["return-window","dispatch-window","shipping-cost","warranty-window","gift","material","origin","specification","shelf-life","garment-care","bag-lining","shoe-sole"].indexOf(row.fieldId) >= 0) &&
    (typeof row.label === 'string' && row.label.length >= 1 && row.label.length <= 100) &&
    (typeof row.status === 'string' && ["known","unknown","not-applicable"].indexOf(row.status) >= 0) &&
    (row.value === null || (typeof row.value === 'string' && row.value.length >= 1 && row.value.length <= 250)) &&
    (row.unit === null || (typeof row.unit === 'string' && ["小时","天","周","个月","月","年","工作日"].indexOf(row.unit) >= 0)) &&
    (row.condition === null || (typeof row.condition === 'string' && row.condition.length >= 1 && row.condition.length <= 250)) &&
    (row.quote === null || (typeof row.quote === 'string' && row.quote.length >= 1 && row.quote.length <= 250)) &&
    (row.sourceRef === null || validPromiseSourceRef(row.sourceRef)) &&
    (row.sourceRevision === null || (typeof row.sourceRevision === 'number' && Number.isSafeInteger(row.sourceRevision) && row.sourceRevision >= 1 && row.sourceRevision <= 9007199254740991)) &&
    (row.conditionNeedsReview === undefined || typeof row.conditionNeedsReview === 'boolean') &&
    (row.suggestedAfterSaleKind === undefined || (typeof row.suggestedAfterSaleKind === 'string' && ["return-quality"].indexOf(row.suggestedAfterSaleKind) >= 0))
}
export function parsePromiseEntry(text: string): PromiseEntry | null {
  try { const value = JSON.parse(text) as PromiseEntry; return validPromiseEntry(value) ? value : null } catch { return null }
}
function validPromiseDraft(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as PromiseDraft
  if (Object.keys(row).some((key: string) => ["id","templateVersion","productRevision","entries","issues"].indexOf(key) < 0)) return false
  return (typeof row.id === 'string' && row.id.length >= 1 && row.id.length <= 100) &&
    (typeof row.templateVersion === 'string' && row.templateVersion.length >= 1 && row.templateVersion.length <= 100) &&
    (typeof row.productRevision === 'number' && Number.isSafeInteger(row.productRevision) && row.productRevision >= 1 && row.productRevision <= 9007199254740991) &&
    (Array.isArray(row.entries) && row.entries.length <= 30 && row.entries.every((item: PromiseEntry) => validPromiseEntry(item))) &&
    (Array.isArray(row.issues) && row.issues.length <= 30 && row.issues.every((item: string) => (typeof item === 'string' && item.length >= 1 && item.length <= 250)))
}
export function parsePromiseDraft(text: string): PromiseDraft | null {
  try { const value = JSON.parse(text) as PromiseDraft; return validPromiseDraft(value) ? value : null } catch { return null }
}
function validPromiseSnapshot(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as PromiseSnapshot
  if (Object.keys(row).some((key: string) => ["receiptId","templateVersion","productRevision","publishedAt","entries"].indexOf(key) < 0)) return false
  return (typeof row.receiptId === 'string' && row.receiptId.length >= 1 && row.receiptId.length <= 100) &&
    (typeof row.templateVersion === 'string' && row.templateVersion.length >= 1 && row.templateVersion.length <= 100) &&
    (typeof row.productRevision === 'number' && Number.isSafeInteger(row.productRevision) && row.productRevision >= 1 && row.productRevision <= 9007199254740991) &&
    (typeof row.publishedAt === 'number' && Number.isSafeInteger(row.publishedAt) && row.publishedAt >= 0 && row.publishedAt <= 9007199254740991) &&
    (Array.isArray(row.entries) && row.entries.length <= 30 && row.entries.every((item: PromiseEntry) => validPromiseEntry(item)))
}
export function parsePromiseSnapshot(text: string): PromiseSnapshot | null {
  try { const value = JSON.parse(text) as PromiseSnapshot; return validPromiseSnapshot(value) ? value : null } catch { return null }
}
export function legacyPromiseAfterSaleKind(templateVersion: string, fieldId: string): string {
  return templateVersion === "promises-20261118-1" && ["material","origin","specification","bag-lining","shoe-sole"].indexOf(fieldId) >= 0 ? "return-quality" : ""
}
