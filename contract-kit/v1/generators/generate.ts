import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from '../../../server/node_modules/zod/index.js'
import { quoteSchemas } from '../quote-preview/schema.ts'
import { quoteVectors } from '../vectors/quote-preview.ts'

// 故意只支持本协议用到的类型；不认识的 schema 立即失败，不能静默放宽解析。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const entries = Object.entries(quoteSchemas)
const names = new Map<z.ZodType, string>(entries.map(([name, schema]) => [schema, name]))
function type(schema: z.ZodType): string {
  const def = schema._zod.def
  if (schema instanceof z.ZodOptional) return type(schema.unwrap())
  if (schema instanceof z.ZodNullable) return type(schema.unwrap()) + ' | null'
  if (names.has(schema)) return names.get(schema)!
  if (schema instanceof z.ZodArray) return type(schema.element) + '[]'
  if (['string', 'number', 'boolean', 'enum'].includes(def.type)) return def.type === 'enum' ? 'string' : def.type
  throw new Error('Unsupported quote schema: ' + def.type)
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
  throw new Error('Unsupported quote check')
}
let source = '// 生成文件勿手改；来源 contract-kit/v1/quote-preview/schema.ts\n'
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
const targets = ['server/src/quote-preview/generated.ts', 'mixed-development-h5/commons/models/src/main/ets/QuotePreview.ets']
const checking = process.argv.includes('--check')
for (const target of targets) {
  const path = resolve(root, target)
  if (checking) { if (readFileSync(path, 'utf8') !== source) throw new Error('Generated quote file drift: ' + target) }
  else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source) }
}
console.log('quote-contract: ' + (checking ? 'verified' : 'generated') + ' TS + ArkTS')
let tests = "// 生成文件勿手改；与 Node/TS 共用 contract-kit/v1/vectors/quote-preview.ts\nimport { describe, it, expect } from '@ohos/hypium'\nimport { parseQuoteRequest, parseQuoteResponse } from '../main/ets/QuotePreview'\nexport default function quoteVectorTests(): void {\n  describe('quoteContractVectors', () => {\n"
for (const vector of quoteVectors) {
  tests += `    it('${vector.name}', 0, () => { expect(parseQuote${vector.kind === 'request' ? 'Request' : 'Response'}(${JSON.stringify(JSON.stringify(vector.value))}) !== null).assertEqual(${vector.valid}) })\n`
}
tests += '  })\n}\n'
const testPath = resolve(root, 'mixed-development-h5/commons/models/src/test/QuoteVectors.test.ets')
if (checking) { if (readFileSync(testPath, 'utf8') !== tests) throw new Error('Generated quote vectors drift') }
else writeFileSync(testPath, tests)
