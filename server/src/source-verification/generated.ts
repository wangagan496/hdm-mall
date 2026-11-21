// 生成文件勿手改；来源 contract-kit/v1/source-records/schema.ts
export type MaterialKind = "batch-note" | "authorization" | "inspection-report"
export type VerificationStatus = "provided" | "pending" | "verified" | "unverifiable"
export type SourceAvailability = "applicable" | "expired" | "not-yet-valid" | "batch-mismatch" | "withdrawn"
export interface SourceRecord {
  materialId: string
  kind: MaterialKind
  version: number
  productId: string
  productName: string
  batch: string
  validFrom: number
  validUntil: number
  summary: string
  verificationStatus: VerificationStatus
  availability: SourceAvailability
  verifier: string | null
  verifiedAt: number | null
  basis: string | null
}
export interface PromiseMaterialSource {
  fieldId: string
  record: SourceRecord
  currentAvailability: SourceAvailability
}
export interface ProductMaterials {
  batch: string | null
  materials: SourceRecord[]
}
function validSourceRecord(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as SourceRecord
  if (Object.keys(row).some((key: string) => ["materialId","kind","version","productId","productName","batch","validFrom","validUntil","summary","verificationStatus","availability","verifier","verifiedAt","basis"].indexOf(key) < 0)) return false
  return (typeof row.materialId === 'string' && row.materialId.length >= 1 && row.materialId.length <= 100) &&
    (typeof row.kind === 'string' && ["batch-note","authorization","inspection-report"].indexOf(row.kind) >= 0) &&
    (typeof row.version === 'number' && Number.isSafeInteger(row.version) && row.version >= 1 && row.version <= 9007199254740991) &&
    (typeof row.productId === 'string' && row.productId.length >= 1 && row.productId.length <= 100) &&
    (typeof row.productName === 'string' && row.productName.length >= 1 && row.productName.length <= 100) &&
    (typeof row.batch === 'string' && row.batch.length >= 1 && row.batch.length <= 40) &&
    (typeof row.validFrom === 'number' && Number.isSafeInteger(row.validFrom) && row.validFrom >= 0 && row.validFrom <= 9007199254740991) &&
    (typeof row.validUntil === 'number' && Number.isSafeInteger(row.validUntil) && row.validUntil >= 1 && row.validUntil <= 9007199254740991) &&
    (typeof row.summary === 'string' && row.summary.length >= 1 && row.summary.length <= 400) &&
    (typeof row.verificationStatus === 'string' && ["provided","pending","verified","unverifiable"].indexOf(row.verificationStatus) >= 0) &&
    (typeof row.availability === 'string' && ["applicable","expired","not-yet-valid","batch-mismatch","withdrawn"].indexOf(row.availability) >= 0) &&
    (row.verifier === null || (typeof row.verifier === 'string' && row.verifier.length >= 1 && row.verifier.length <= 100)) &&
    (row.verifiedAt === null || (typeof row.verifiedAt === 'number' && Number.isSafeInteger(row.verifiedAt) && row.verifiedAt >= 0 && row.verifiedAt <= 9007199254740991)) &&
    (row.basis === null || (typeof row.basis === 'string' && row.basis.length >= 1 && row.basis.length <= 400)) &&
    (row.verificationStatus === "verified" ? !!row.verifier && row.verifiedAt !== null && !!row.basis : row.verifier === null && row.verifiedAt === null && row.basis === null)
}
export function parseSourceRecord(text: string): SourceRecord | null {
  try { const value = JSON.parse(text) as SourceRecord; return validSourceRecord(value) ? value : null } catch { return null }
}
function validPromiseMaterialSource(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as PromiseMaterialSource
  if (Object.keys(row).some((key: string) => ["fieldId","record","currentAvailability"].indexOf(key) < 0)) return false
  return (typeof row.fieldId === 'string' && row.fieldId.length >= 1 && row.fieldId.length <= 100) &&
    validSourceRecord(row.record) &&
    (typeof row.currentAvailability === 'string' && ["applicable","expired","not-yet-valid","batch-mismatch","withdrawn"].indexOf(row.currentAvailability) >= 0)
}
export function parsePromiseMaterialSource(text: string): PromiseMaterialSource | null {
  try { const value = JSON.parse(text) as PromiseMaterialSource; return validPromiseMaterialSource(value) ? value : null } catch { return null }
}
function validProductMaterials(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as ProductMaterials
  if (Object.keys(row).some((key: string) => ["batch","materials"].indexOf(key) < 0)) return false
  return (row.batch === null || (typeof row.batch === 'string' && row.batch.length >= 1 && row.batch.length <= 40)) &&
    (Array.isArray(row.materials) && row.materials.length <= 100 && row.materials.every((item: SourceRecord) => validSourceRecord(item)))
}
export function parseProductMaterials(text: string): ProductMaterials | null {
  try { const value = JSON.parse(text) as ProductMaterials; return validProductMaterials(value) ? value : null } catch { return null }
}
