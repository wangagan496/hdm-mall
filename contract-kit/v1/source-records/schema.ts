import { z } from '../../../server/node_modules/zod/index.js'

const text = (max: number) => z.string().min(1).max(max)
const integer = (min: number) => z.number().int().min(min).max(Number.MAX_SAFE_INTEGER)

export const MaterialKind = z.enum(['batch-note', 'authorization', 'inspection-report'])
export const VerificationStatus = z.enum(['provided', 'pending', 'verified', 'unverifiable'])
const SourceAvailability = z.enum(['applicable', 'expired', 'not-yet-valid', 'batch-mismatch', 'withdrawn'])
const SourceRecord = z.strictObject({
  materialId: text(100), kind: MaterialKind, version: integer(1), productId: text(100), productName: text(100),
  batch: text(40), validFrom: integer(0), validUntil: integer(1), summary: text(400),
  verificationStatus: VerificationStatus, availability: SourceAvailability,
  verifier: text(100).nullable(), verifiedAt: integer(0).nullable(), basis: text(400).nullable(),
}).refine(row => row.verificationStatus === 'verified'
  ? !!row.verifier && row.verifiedAt !== null && !!row.basis
  : row.verifier === null && row.verifiedAt === null && row.basis === null,
{ message: '核验状态必须与核验人、时间和依据一致' })
const PromiseMaterialSource = z.strictObject({
  fieldId: text(100), record: SourceRecord, currentAvailability: SourceAvailability,
})
const ProductMaterials = z.strictObject({
  batch: text(40).nullable(), materials: z.array(SourceRecord).max(100),
})

export const sourceRecordSchemas = { SourceRecord, PromiseMaterialSource, ProductMaterials }
export const sourceRecordEnums = { MaterialKind, VerificationStatus, SourceAvailability }
