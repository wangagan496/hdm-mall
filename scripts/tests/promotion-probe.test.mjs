import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceOf } from './native-harness.mjs'

test('设备满减探针作为独立模式注册，并核对货款及运费两笔退款', () => {
  const driver = sourceOf('scripts/device-trade-regression.ps1')
  assert.ok(driver.includes('[switch]$PromotionProbe'), 'missing PromotionProbe mode')
  assert.ok(driver.includes('Invoke-PromotionProbe; return'))
  const probe = sourceOf('scripts/device-promotion-probe.ps1')
  for (const requirement of ['discountShareCents', 'after-sale', 'shipping', 'checkout-promotion', 'Add-ReturnShippingProof', 'Save-Result']) assert.ok(probe.includes(requirement), requirement)
})
