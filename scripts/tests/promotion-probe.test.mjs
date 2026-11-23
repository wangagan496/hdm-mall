import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceOf } from './native-harness.mjs'

test('设备满减探针使用中性提示和页面返回，并核对货款及运费两笔退款', () => {
  const driver = sourceOf('scripts/device-trade-regression.ps1')
  assert.ok(driver.includes('[switch]$PromotionProbe'), 'missing PromotionProbe mode')
  assert.ok(driver.includes('Invoke-PromotionProbe; return'))
  const probe = sourceOf('scripts/device-promotion-probe.ps1')
  for (const requirement of ['discountShareCents', 'after-sale', 'shipping', "Wait-Text ('还差 '", '元可满减', 'Add-ReturnShippingProof', 'Save-Result']) assert.ok(probe.includes(requirement), requirement)
  assert.ok(!probe.includes("Product-Control 'checkout-promotion'"), 'promotion guidance should not navigate to the home page')
})
