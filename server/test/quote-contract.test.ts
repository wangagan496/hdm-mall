import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QuoteRequestSchema, QuoteResponseSchema } from '../../contract-kit/v1/quote-preview/schema.ts'
import { quoteVectors } from '../../contract-kit/v1/vectors/quote-preview.ts'
import { parseQuoteRequest, parseQuoteResponse } from '../src/quote-preview/generated.ts'
for (const vector of quoteVectors) test('报价共同向量 Node/TS: ' + vector.name, () => {
  const schema = vector.kind === 'request' ? QuoteRequestSchema : QuoteResponseSchema
  const parser = vector.kind === 'request' ? parseQuoteRequest : parseQuoteResponse
  const value = JSON.parse(JSON.stringify(vector.value))
  assert.equal(schema.safeParse(value).success, vector.valid)
  assert.equal(parser(JSON.stringify(value)) !== null, vector.valid)
})
