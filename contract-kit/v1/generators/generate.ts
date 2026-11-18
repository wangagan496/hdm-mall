import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from '../../../server/node_modules/zod/index.js'
import { quoteSchemas } from '../quote-preview/schema.ts'
import { quoteVectors } from '../vectors/quote-preview.ts'
import { IdentitySchema, identitySchemas } from '../identity-context/schema.ts'
import { identityEntries } from '../identity-context/entries.ts'
import { identityVectors } from '../vectors/identity-context.ts'

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

function renderContract(contract: string, schemas: Record<string, z.ZodObject>, enums: Record<string, z.ZodEnum> = {}, arkts = false) {
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
    source += `function valid${name}(value: Object | null | undefined): boolean {\n  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false\n  const row = value as ${name}\n  if (Object.keys(row).some((key: string) => ${JSON.stringify(fields.map(([k]) => k))}.indexOf(key) < 0)) return false\n  return ${fields.map(([k, s]) => check(s, `row.${k}`)).join(' &&\n    ')}\n}\n`
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
console.log('quote and identity contracts: ' + (checking ? 'verified' : 'generated') + ' TS + ArkTS')
