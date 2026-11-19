import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('production phone sources exclude album save buttons and test launch keys', () => {
  const root = fileURLToPath(new URL('../../mixed-development-h5/products/phone/src/', import.meta.url))
  const sources = readdirSync(root, { recursive: true }).filter(name => /\.(?:ets|ts|js|json5?)$/.test(name))
  assert.ok(sources.some(name => name.endsWith('PhoneAbility.ets')))
  for (const name of sources) {
    const source = readFileSync(join(root, name), 'utf8')
    assert.doesNotMatch(source, /\bSaveButton\b|\b(?:stage2b|synthetic)[\w-]*/i, name)
  }
})
