import { test } from 'node:test'
import assert from 'node:assert/strict'
import { identitySchemas } from '../../contract-kit/v1/identity-context/schema.ts'
import { identityVectors } from '../../contract-kit/v1/vectors/identity-context.ts'
import { parseIdentityContext, parseIdentityLayout, parseIdentityLayoutUpdate, parseIdentitySwitch } from '../src/identity-context/generated.ts'

const parsers = {
  IdentityContext: parseIdentityContext, IdentitySwitch: parseIdentitySwitch,
  IdentityLayout: parseIdentityLayout, IdentityLayoutUpdate: parseIdentityLayoutUpdate
}
for (const vector of identityVectors) test('身份共同向量 Node/TS: ' + vector.name, () => {
  const json = JSON.stringify(vector.value)
  assert.equal(identitySchemas[vector.kind].safeParse(JSON.parse(json)).success, vector.valid)
  assert.equal(parsers[vector.kind](json) !== null, vector.valid)
})
