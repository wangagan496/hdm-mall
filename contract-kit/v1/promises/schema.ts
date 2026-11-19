import { z } from '../../../server/node_modules/zod/index.js'
import { promiseCatalog } from './catalog.ts'

const text = (max: number) => z.string().min(1).max(max)
const integer = (min: number, max = Number.MAX_SAFE_INTEGER) => z.number().int().min(min).max(max)

export const PromiseFieldId = z.enum(promiseCatalog.map(field => field.id))
export const PromiseStatus = z.enum(['known', 'unknown', 'not-applicable'])
export const PromiseSourceField = z.enum(['name', 'description', 'imageText', 'specifications', 'material'])
export const PromiseValueType = z.enum(['number', 'text'])
export const PromiseUnit = z.enum([...new Set(promiseCatalog.flatMap(field => [...field.units]))])
export const PromiseSuggestedAfterSaleKind = z.enum(['return-quality'])

const PromiseTemplateField = z.object({
  id: PromiseFieldId, label: text(100), units: z.array(PromiseUnit).max(12),
  valueType: PromiseValueType, categories: z.array(text(100)).min(1).max(30),
  suggestedAfterSaleKind: PromiseSuggestedAfterSaleKind.nullable().optional(),
}).strict()

const PromiseSourceRef = z.object({
  field: PromiseSourceField, start: integer(0, 4000), end: integer(1, 4000), materialId: text(100).optional(),
}).strict()

const PromiseEntry = z.object({
  fieldId: PromiseFieldId, label: text(100), status: PromiseStatus, value: text(250).nullable(),
  unit: PromiseUnit.nullable(), condition: text(250).nullable(), quote: text(250).nullable(),
  sourceRef: PromiseSourceRef.nullable(), sourceRevision: integer(1).nullable(),
  conditionNeedsReview: z.boolean().optional(),
  suggestedAfterSaleKind: PromiseSuggestedAfterSaleKind.optional(),
}).strict()

const entries = z.array(PromiseEntry).max(30)
const PromiseDraft = z.object({
  id: text(100), templateVersion: text(100), productRevision: integer(1), entries,
  issues: z.array(text(250)).max(30),
}).strict()

const PromiseSnapshot = z.object({
  receiptId: text(100), templateVersion: text(100), productRevision: integer(1), publishedAt: integer(0), entries,
}).strict()

export const promiseSchemas = { PromiseTemplateField, PromiseSourceRef, PromiseEntry, PromiseDraft, PromiseSnapshot }
export const promiseEnums = { PromiseFieldId, PromiseStatus, PromiseSourceField, PromiseValueType, PromiseUnit, PromiseSuggestedAfterSaleKind }
