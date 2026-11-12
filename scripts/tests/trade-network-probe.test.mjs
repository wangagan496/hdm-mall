import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')

test('B-83 to B-88 TradeNetworkProbe has an isolated fixture and ordered checkpoints', () => {
  const main = read('scripts/device-trade-regression.ps1')
  const probe = read('scripts/device-trade-network-probe.ps1')
  assert.ok(main.includes('[switch]$TradeNetworkProbe'))
  assert.ok(main.includes(". (Join-Path $PSScriptRoot 'device-trade-network-probe.ps1')"))
  for (const caseId of ['B-83', 'B-84', 'B-85', 'B-86', 'B-87', 'B-88']) assert.ok(probe.includes(caseId), caseId)
  for (const kind of ['cancel-request', 'cancel-withdraw', 'cancel-resolve']) assert.ok(probe.includes(kind), kind)
  assert.match(probe, /Disconnect-AcceptedResponse/)
  assert.match(probe, /Restore-TestNetwork/)
  assert.match(probe, /force-stop/)
  assert.match(probe, /cleanup.json/)
  assert.match(probe, /media-cleanup.json/)
})

test('B-87 rapid commands retain timing limits and do not claim unmeasured input intervals', () => {
  const probe = read('scripts/device-trade-network-probe.ps1')
  assert.match(probe, /Rapid-TradeTap/)
  assert.match(probe, /intervalMs/)
  assert.match(probe, /cancelActions/)
  assert.match(probe, /refunds/)
  assert.match(probe, /movements/)
  assert.match(probe, /audit/)
  assert.ok(probe.includes('injectionIntervalVerified=$false'))
  assert.ok(probe.includes("case='B-87';result='blocked'"))
})
