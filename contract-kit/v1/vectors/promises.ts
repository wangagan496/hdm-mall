import { LEGACY_PROMISE_TEMPLATE_VERSION, PROMISE_TEMPLATE_VERSION } from '../promises/catalog.ts'
import type { promiseSchemas } from '../promises/schema.ts'

const source = { field: 'description', start: 0, end: 5 }
const known = { fieldId: 'dispatch-window', label: '发货时效', status: 'known', value: '48', unit: '小时',
  condition: null, quote: '48小时发货', sourceRef: source, sourceRevision: 1 }
const unknown = { fieldId: 'origin', label: '产地', status: 'unknown', value: null, unit: null,
  condition: null, quote: null, sourceRef: null, sourceRevision: null }
const draft = { id: 'draft-1', templateVersion: PROMISE_TEMPLATE_VERSION, productRevision: 1, entries: [known, unknown], issues: [] }
const snapshot = { receiptId: 'receipt-1', templateVersion: PROMISE_TEMPLATE_VERSION, productRevision: 1,
  publishedAt: 1763452800000, entries: [known, unknown] }

export const promiseVectors: ReadonlyArray<{ name: string; kind: keyof typeof promiseSchemas; value: unknown; valid: boolean }> = [
  { name: 'garment-size-chart', kind: 'PromiseEntry', value: { ...known, fieldId: 'size-chart', label: '尺码表', unit: null, value: 'M 胸围 90cm\nL 胸围 96cm', quote: 'M 胸围 90cm\nL 胸围 96cm' }, valid: true },
  { name: 'garment-fit', kind: 'PromiseEntry', value: { ...known, fieldId: 'fit', label: '版型', unit: null, value: '偏大', fit: '偏大', quote: '版型偏大' }, valid: true },
  { name: 'shoe-fit', kind: 'PromiseEntry', value: { ...known, fieldId: 'fit', label: '版型', unit: null, value: '正常尺码', fit: '标准', quote: '本鞋正常尺码' }, valid: true },
  { name: 'fit-value-outside-three-options', kind: 'PromiseEntry', value: { ...known, fieldId: 'fit', label: '版型', unit: null, value: '宽松', fit: '宽松', quote: '版型宽松' }, valid: false },
  { name: 'size-chart-wrong-value', kind: 'PromiseEntry', value: { ...known, fieldId: 'size-chart', unit: null, value: 'M 胸围 91cm', quote: 'M 胸围 90cm' }, valid: false },
  { name: 'known-with-origin', kind: 'PromiseEntry', value: known, valid: true },
  { name: 'known-with-qualifier-warning', kind: 'PromiseEntry', value: { ...known, conditionNeedsReview: true }, valid: true },
  { name: 'quality-return-suggestion', kind: 'PromiseEntry', value: { ...known, fieldId: 'material', suggestedAfterSaleKind: 'return-quality' }, valid: true },
  { name: 'invalid-return-suggestion', kind: 'PromiseEntry', value: { ...known, suggestedAfterSaleKind: 'refund-missing' }, valid: false },
  { name: 'unknown-with-null-value', kind: 'PromiseEntry', value: unknown, valid: true },
  { name: 'not-applicable', kind: 'PromiseEntry', value: { ...unknown, status: 'not-applicable' }, valid: true },
  { name: 'unknown-field-id', kind: 'PromiseEntry', value: { ...known, fieldId: 'injected' }, valid: false },
  { name: 'unknown-unit', kind: 'PromiseEntry', value: { ...known, unit: '分钟数' }, valid: false },
  { name: 'unknown-state', kind: 'PromiseEntry', value: { ...known, status: 'confirmed' }, valid: false },
  { name: 'unknown-source-field', kind: 'PromiseSourceRef', value: { ...source, field: 'foreign' }, valid: false },
  { name: 'source-ref-negative-offset', kind: 'PromiseSourceRef', value: { ...source, start: -1 }, valid: false },
  { name: 'source-ref-fractional-offset', kind: 'PromiseSourceRef', value: { ...source, start: 0.5 }, valid: false },
  { name: 'draft', kind: 'PromiseDraft', value: draft, valid: true },
  { name: 'draft-extra-key', kind: 'PromiseDraft', value: { ...draft, secret: 'not-a-contract-field' }, valid: false },
  { name: 'draft-nested-invalid', kind: 'PromiseDraft', value: { ...draft, entries: [{ ...known, sourceRevision: 0 }] }, valid: false },
  { name: 'snapshot', kind: 'PromiseSnapshot', value: snapshot, valid: true },
  { name: 'stage2b-snapshot', kind: 'PromiseSnapshot', value: { ...snapshot, templateVersion: 'promises-20261118-2' }, valid: true },
  { name: 'legacy-snapshot-retains-original-entry-shape', kind: 'PromiseSnapshot', value: { ...snapshot, templateVersion: LEGACY_PROMISE_TEMPLATE_VERSION }, valid: true },
  { name: 'snapshot-missing-receipt', kind: 'PromiseSnapshot', value: { ...snapshot, receiptId: '' }, valid: false },
  { name: 'catalog-template', kind: 'PromiseTemplateField', value: { id: 'shoe-sole', label: '鞋底材质', valueType: 'text', units: [], categories: ['鞋靴'], suggestedAfterSaleKind: 'return-quality' }, valid: true },
  { name: 'catalog-template-invalid-type', kind: 'PromiseTemplateField', value: { id: 'shoe-sole', label: '鞋底材质', valueType: 'arbitrary', units: [], categories: ['鞋靴'] }, valid: false },
]
