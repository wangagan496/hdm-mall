import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceOf } from './native-harness.mjs'

test('ServiceProbe注册独立模式，原生全链路与后台证据一起验收', () => {
  const driver = sourceOf('scripts/device-trade-regression.ps1')
  assert.ok(driver.includes('[switch]$ServiceProbe'), '缺少ServiceProbe模式')
  assert.ok(driver.includes('Invoke-ServiceProbe; return'))
  const probe = sourceOf('scripts/device-service-probe.ps1')
  for (const marker of ['invoice-enabled', 'invoice-issue', 'order-service', 'service-send', 'service-unread', 'review-hide-', 'review-republish', 'hiddenReason', 'Save-Result']) assert.ok(probe.includes(marker), marker)
})

test('设备媒体清理证据保留精确URI与删除后查询结果', () => {
  const cleanup = sourceOf('scripts/device-promotion-probe.ps1')
  assert.match(cleanup, /uri=\$Uri;deleteResult=/, '媒体清理必须归档实际删除的URI和结果')
  assert.match(cleanup, /queryResult=\(\$Remaining/)
  assert.match(cleanup, /entries=\$Removed/)
})
