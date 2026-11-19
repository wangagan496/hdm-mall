import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promiseSchemas } from '../../contract-kit/v1/promises/schema.ts'
import { promiseVectors } from '../../contract-kit/v1/vectors/promises.ts'
import {
  parsePromiseDraft, parsePromiseEntry, parsePromiseSnapshot, parsePromiseSourceRef, parsePromiseTemplateField,
} from '../src/promises/generated.ts'

const parsers = {
  PromiseDraft: parsePromiseDraft, PromiseEntry: parsePromiseEntry, PromiseSnapshot: parsePromiseSnapshot,
  PromiseSourceRef: parsePromiseSourceRef, PromiseTemplateField: parsePromiseTemplateField,
}
for (const vector of promiseVectors) test('承诺共同向量 Node/TS: ' + vector.name, () => {
  const json = JSON.stringify(vector.value)
  assert.equal(promiseSchemas[vector.kind].safeParse(JSON.parse(json)).success, vector.valid)
  assert.equal(parsers[vector.kind](json) !== null, vector.valid)
})
