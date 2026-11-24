import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from '../../../server/node_modules/zod/index.js'
import { quoteSchemas } from '../quote-preview/schema.ts'
import { quoteVectors } from '../vectors/quote-preview.ts'
import { IdentitySchema, identitySchemas } from '../identity-context/schema.ts'
import { identityEntries } from '../identity-context/entries.ts'
import { identityVectors } from '../vectors/identity-context.ts'
import { promiseEnums, promiseSchemas } from '../promises/schema.ts'
import { LEGACY_PROMISE_TEMPLATE_VERSION, PROMISE_TEMPLATE_VERSION, QUALITY_RETURN_FIELDS, promiseCatalog } from '../promises/catalog.ts'
import { promiseVectors } from '../vectors/promises.ts'
import { sourceRecordEnums, sourceRecordSchemas } from '../source-records/schema.ts'
import { sourceRecordVectors } from '../vectors/source-records.ts'
import { compensationEnums, compensationSchemas } from '../compensation.ts'
import { compensationVectors } from '../vectors/compensation.ts'

// 故意只支持本协议用到的类型；不认识的 schema 立即失败，不能静默放宽解析。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const checking = process.argv.includes('--check')
function writeGenerated(target: string, source: string) {
  const path = resolve(root, target)
  if (existsSync(path) && readFileSync(path, 'utf8') === source) return
  if (checking) {
    throw new Error('Generated file drift: ' + target)
  } else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
  }
}

function renderContract(contract: string, schemas: Record<string, z.ZodObject>, enums: Record<string, z.ZodEnum> = {},
  arkts = false, objectChecks: Record<string, string[]> = {}) {
  const entries = Object.entries(schemas)
  const names = new Map<z.ZodType, string>([...entries, ...Object.entries(enums)].map(([name, schema]) => [schema, name]))
  function type(schema: z.ZodType): string {
    const def = schema._zod.def
    if (schema instanceof z.ZodOptional) return type(schema.unwrap())
    if (schema instanceof z.ZodNullable) return type(schema.unwrap()) + ' | null'
    if (names.has(schema)) return names.get(schema)!
    if (schema instanceof z.ZodArray) return type(schema.element) + '[]'
    if (['string', 'number', 'boolean', 'enum'].includes(def.type)) return def.type === 'enum' ? 'string' : def.type
    throw new Error('Unsupported schema: ' + def.type)
  }
  function check(schema: z.ZodType, value: string): string {
    if (schema instanceof z.ZodOptional) return `(${value} === undefined || ${check(schema.unwrap(), value)})`
    if (schema instanceof z.ZodNullable) return `(${value} === null || ${check(schema.unwrap(), value)})`
    if (schema instanceof z.ZodObject) return `valid${names.get(schema)}(${value})`
    const json = z.toJSONSchema(schema) as { minLength?: number; maxLength?: number; minimum?: number; maximum?: number; minItems?: number; maxItems?: number; enum?: string[] }
    if (schema instanceof z.ZodArray) return `(Array.isArray(${value})${json.minItems === undefined ? '' : ` && ${value}.length >= ${json.minItems}`}${json.maxItems === undefined ? '' : ` && ${value}.length <= ${json.maxItems}`} && ${value}.every((item: ${type(schema.element)}) => ${check(schema.element, 'item')}))`
    if (schema instanceof z.ZodEnum) return `(typeof ${value} === 'string' && ${JSON.stringify(json.enum)}.indexOf(${value}) >= 0)`
    if (schema instanceof z.ZodString) return `(typeof ${value} === 'string'${json.minLength === undefined ? '' : ` && ${value}.length >= ${json.minLength}`}${json.maxLength === undefined ? '' : ` && ${value}.length <= ${json.maxLength}`})`
    if (schema instanceof z.ZodNumber) return `(typeof ${value} === 'number' && Number.isSafeInteger(${value}) && ${value} >= ${json.minimum} && ${value} <= ${json.maximum})`
    if (schema instanceof z.ZodBoolean) return `typeof ${value} === 'boolean'`
    throw new Error('Unsupported schema check')
  }
  let source = `// 生成文件勿手改；来源 contract-kit/v1/${contract}/schema.ts\n`
  for (const [name, schema] of Object.entries(enums)) {
    const enumType = arkts ? 'string' : schema.options.map(value => JSON.stringify(value)).join(' | ')
    source += `export type ${name} = ${enumType}\n`
  }
  for (const [name, schema] of entries) {
    source += `export interface ${name} {\n`
    for (const [field, value] of Object.entries(schema.shape) as [string, z.ZodType][]) source += `  ${field}${value instanceof z.ZodOptional ? '?' : ''}: ${type(value)}\n`
    source += '}\n'
  }
  for (const [name, schema] of entries) {
    const fields = Object.entries(schema.shape) as [string, z.ZodType][]
    const checks = fields.map(([k, s]) => check(s, `row.${k}`)).concat(objectChecks[name] ?? [])
    source += `function valid${name}(value: Object | null | undefined): boolean {\n  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false\n  const row = value as ${name}\n  if (Object.keys(row).some((key: string) => ${JSON.stringify(fields.map(([k]) => k))}.indexOf(key) < 0)) return false\n  return ${checks.join(' &&\n    ')}\n}\n`
    source += `export function parse${name}(text: string): ${name} | null {\n  try { const value = JSON.parse(text) as ${name}; return valid${name}(value) ? value : null } catch { return null }\n}\n`
  }
  return source
}

function renderVectors(contract: string, model: string, suite: string, vectors: ReadonlyArray<{
  name: string; parser: string; value: unknown; valid: boolean
}>) {
  const parsers = [...new Set(vectors.map(vector => vector.parser))]
  let tests = `// 生成文件勿手改；与 Node/TS 共用 contract-kit/v1/vectors/${contract}.ts\n` +
    "import { describe, it, expect } from '@ohos/hypium'\n" +
    `import { ${parsers.join(', ')} } from '../main/ets/${model}'\n` +
    `export default function ${suite}VectorTests(): void {\n  describe('${suite}ContractVectors', () => {\n`
  for (const vector of vectors) {
    tests += `    it('${vector.name}', 0, () => { expect(${vector.parser}(${JSON.stringify(JSON.stringify(vector.value))}) !== null).assertEqual(${vector.valid}) })\n`
  }
  return tests + '  })\n}\n'
}

const models = 'mixed-development-h5/commons/models/src'
const quote = renderContract('quote-preview', quoteSchemas)
writeGenerated('server/src/quote-preview/generated.ts', quote)
writeGenerated(models + '/main/ets/QuotePreview.ets', quote)
writeGenerated(models + '/test/QuoteVectors.test.ets', renderVectors('quote-preview', 'QuotePreview', 'quote',
  quoteVectors.map(vector => ({ ...vector, parser: vector.kind === 'request' ? 'parseQuoteRequest' : 'parseQuoteResponse' }))))

const identityEnums = { Identity: IdentitySchema }
writeGenerated('server/src/identity-context/generated.ts', renderContract('identity-context', identitySchemas, identityEnums))
writeGenerated(models + '/main/ets/IdentityContext.ets', renderContract('identity-context', identitySchemas, identityEnums, true))
writeGenerated(models + '/test/IdentityVectors.test.ets', renderVectors('identity-context', 'IdentityContext', 'identity',
  identityVectors.map(vector => ({ ...vector, parser: 'parse' + vector.kind }))))

const entriesSource = '// 生成文件勿手改；来源 contract-kit/v1/identity-context/entries.ts\n' +
  'export interface IdentityEntry {\n  id: string\n  label: string\n  locked: boolean\n}\n' +
  'interface IdentityEntries {\n  buyer: IdentityEntry[]\n  merchant: IdentityEntry[]\n}\n' +
  'export const IDENTITY_ENTRIES: IdentityEntries = {\n' +
  Object.entries(identityEntries).map(([key, values]) => `  ${key}: [\n` +
    values.map(value => `    { id: ${JSON.stringify(value.id)}, label: ${JSON.stringify(value.label)}, locked: ${value.locked} }`).join(',\n') +
    '\n  ]').join(',\n') + '\n}\n'
writeGenerated('server/src/identity-context/entries.ts', entriesSource)
writeGenerated(models + '/main/ets/IdentityEntries.ets', entriesSource)

for (const { cues: _cues, ...field } of promiseCatalog) promiseSchemas.PromiseTemplateField.parse(field)
writeGenerated('server/src/promises/templates/catalog.ts', '// 生成文件勿手改；来源 contract-kit/v1/promises/catalog.ts\n' +
  `export const PROMISE_TEMPLATE_VERSION = ${JSON.stringify(PROMISE_TEMPLATE_VERSION)}\n` +
  `export const promiseCatalog = ${JSON.stringify(promiseCatalog, null, 2)} as const\n`)
const promiseChecks = { PromiseEntry: [
  '((row.fieldId === "size-chart" || row.fieldId === "fit") ? ' +
    '(row.unit === null && !row.suggestedAfterSaleKind && (row.status !== "known" ? ' +
    'row.value === null && row.quote === null && !row.fit && !row.sourceRef && row.sourceRevision === null : ' +
    '!!row.value && !!row.quote && !!row.sourceRef && !!row.sourceRevision && row.quote.includes(row.value) && ' +
    '(row.fieldId === "size-chart" ? !row.fit && row.value === row.quote : !!row.fit && row.fit === (row.value === "正常尺码" ? "标准" : row.value)))) : ' +
    '(!row.fit && (!row.quote || row.quote.length <= 250) && (!row.value || row.value.length <= 250)))',
] }
writeGenerated('server/src/promises/generated.ts', renderContract('promises', promiseSchemas, promiseEnums, false, promiseChecks))
writeGenerated(models + '/main/ets/Promises.ets', renderContract('promises', promiseSchemas, promiseEnums, true, promiseChecks) +
  'export function legacyPromiseAfterSaleKind(templateVersion: string, fieldId: string): string {\n' +
  '  return templateVersion === ' + JSON.stringify(LEGACY_PROMISE_TEMPLATE_VERSION) +
  ' && ' + JSON.stringify(QUALITY_RETURN_FIELDS) + '.indexOf(fieldId) >= 0 ? "return-quality" : ""\n}\n')
writeGenerated(models + '/test/PromiseVectors.test.ets', renderVectors('promises', 'Promises', 'promises',
  promiseVectors.map(vector => ({ ...vector, parser: 'parse' + vector.kind }))))
const sourceChecks = { SourceRecord: [
  '(row.verificationStatus === "verified" ? !!row.verifier && row.verifiedAt !== null && !!row.basis : row.verifier === null && row.verifiedAt === null && row.basis === null)',
] }
writeGenerated('server/src/source-verification/generated.ts', renderContract('source-records', sourceRecordSchemas, sourceRecordEnums, false, sourceChecks))
writeGenerated(models + '/main/ets/SourceRecords.ets', renderContract('source-records', sourceRecordSchemas, sourceRecordEnums, true, sourceChecks))
writeGenerated(models + '/test/SourceRecordVectors.test.ets', renderVectors('source-records', 'SourceRecords', 'sourceRecord',
  sourceRecordVectors.map(vector => ({ ...vector, parser: 'parse' + vector.kind }))))

writeGenerated('server/src/compensation/generated.ts', renderContract('compensation', compensationSchemas, compensationEnums, false))
writeGenerated(models + '/main/ets/CompensationModels.ets', renderContract('compensation', compensationSchemas, compensationEnums, true))
writeGenerated(models + '/test/CompensationVectors.test.ets', renderVectors('compensation', 'CompensationModels', 'compensation',
  compensationVectors.map(vector => ({ ...vector, parser: 'parse' + vector.kind }))))
console.log('quote, identity, promise, source record and compensation contracts: ' + (checking ? 'verified' : 'generated') + ' TS + ArkTS')
