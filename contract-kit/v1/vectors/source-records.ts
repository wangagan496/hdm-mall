const record = {
  materialId: 'record-1', kind: 'inspection-report', version: 1, productId: 'product-1',
  productName: '纯棉短袜', batch: 'B-24', validFrom: 1, validUntil: 2, summary: '材料说明：纯棉短袜。',
  verificationStatus: 'pending', availability: 'applicable', verifier: null, verifiedAt: null, basis: null,
}
const source = { fieldId: 'material-composition', record, currentAvailability: 'withdrawn' }
export const sourceRecordVectors = [
  { name: 'pending-record', kind: 'SourceRecord', value: record, valid: true },
  { name: 'verified-metadata', kind: 'SourceRecord', value: { ...record, verificationStatus: 'verified', verifier: '处理员', verifiedAt: 1, basis: '核对报告编号' }, valid: true },
  { name: 'verified-without-basis', kind: 'SourceRecord', value: { ...record, verificationStatus: 'verified', verifier: '处理员', verifiedAt: 1 }, valid: false },
  { name: 'pending-with-verifier', kind: 'SourceRecord', value: { ...record, verifier: '店主' }, valid: false },
  { name: 'invalid-version', kind: 'SourceRecord', value: { ...record, version: 0 }, valid: false },
  { name: 'invalid-state', kind: 'SourceRecord', value: { ...record, verificationStatus: 'authentic' }, valid: false },
  { name: 'no-attachment', kind: 'SourceRecord', value: { ...record, attachment: 'file' }, valid: false },
  { name: 'frozen-and-current', kind: 'PromiseMaterialSource', value: source, valid: true },
  { name: 'invalid-current', kind: 'PromiseMaterialSource', value: { ...source, currentAvailability: 'verified' }, valid: false },
  { name: 'invalid-nested-record', kind: 'PromiseMaterialSource', value: { ...source, record: { ...record, batch: '' } }, valid: false },
  { name: 'product-materials', kind: 'ProductMaterials', value: { batch: null, materials: [record] }, valid: true },
  { name: 'unknown-type', kind: 'ProductMaterials', value: { batch: 'B-24', materials: [{ ...record, kind: 'invoice' }] }, valid: false },
] as const
