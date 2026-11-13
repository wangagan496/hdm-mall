import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, pageMethods, sourceOf } from './native-harness.mjs'

const merchant = 'mixed-development-h5/features/mine/src/main/ets/presentation/views/AfterSaleManageView.ets'
const inventory = 'mixed-development-h5/features/mine/src/main/ets/presentation/views/InventoryView.ets'
function fixture() {
  const calls = []
  const Page = pageMethods(merchant, 'AfterSaleManageView', {}, { GlobalVariable: {}, RequestAxios: { getForSession: async url => url.includes('/settings/') ? null : { items: [], page: 1, pages: 0 } },
    afterSaleActions: { pending: () => null, start: async (...args) => calls.push(args) }, $r: x => x, Date, Math })
  const page = new Page(); page.user = { id: 'merchant', token: 'fixture-session', role: 'merchant' }; page.active = true; page.synchronize()
  return { page, calls }
}

test('INV-UI 待验收与不合格白话区分，少件退款不冒充验收不合格', () => {
  const { page } = fixture()
  assert.equal(page.restockText({ state: 'refunded', inspectionPending: true, items: [{ count: 2, restockCount: 0 }] }), '已寄回待验收 2 件（不入可售库存）')
  assert.equal(page.restockText({ state: 'refunded', inspectionState: 'inspected', items: [{ count: 2, restockCount: 1 }] }), '退回 2 件，合格入库 1 件，不合格 1 件（不入可售库存）')
  assert.equal(page.restockText({ state: 'refunded', kind: 'refund-missing', items: [{ count: 2, restockCount: 0 }] }), '少件仅退款，不涉及退货入库')
  assert.match(page.restockText({ state: 'refund-rejected', inspectionState: 'rejected', items: [{ count: 2, restockCount: 0 }] }), /不合格 2 件/)
})

test('INV-UI 自动退款后的补验收只提交入库数量，不提交运费调整', async () => {
  const { page, calls } = fixture()
  const sale = { id: 'sale', orderId: 'order', kind: 'return-quality', state: 'refunded', inspectionPending: true,
    amountCents: 2000, shippingAmountCents: 1000, items: [{ skuId: 'sku', name: '商品', spec: '标准', priceCents: 1000, count: 2 }] }
  page.open(sale, 'inspect')
  assert.equal(page.actionLabel(), '确认补验收，仅记录入库')
  page.lines[0].restockCount = 1; page.shippingCompensation = 'wrong'; page.shippingReason = ''
  await page.submit()
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])), { items: [{ skuId: 'sku', restockCount: 1 }] })
})

test('INV-UI 库存记录按SKU关联售后，补验收不改变退款状态时卡片仍刷新', () => {
  const s = sourceOf(inventory), m = sourceOf(merchant)
  for (const field of ['pendingInspectionCount', 'rejectedReturnCount', 'returnRecords']) assert.ok(s.includes(field), field)
  assert.match(s, /已寄回待验收/); assert.match(s, /验收不合格/); assert.match(s, /不入可售库存/)
  assert.match(m, /sale\.inspectionPending/)
  assert.match(m, /JSON.stringify\(sale\)/)
  assert.match(m, /补验收入库/)
})

function inventoryFixture() {
  const time = execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/TimeFormat.ets'))
  const Page = pageMethods(inventory, 'InventoryView', {}, { ...time, GlobalVariable: {} })
  return new Page()
}

test('INV-UI-R2 零隔离库存隐藏汇总，有待验收或不合格才显示', () => {
  const page = inventoryFixture()
  assert.equal(page.returnSummary({ pendingInspectionCount: 0, rejectedReturnCount: 0 }), '')
  assert.equal(page.returnSummary({}), '')
  assert.equal(page.returnSummary({ pendingInspectionCount: 2, rejectedReturnCount: 0 }), '已寄回待验收：2 件；验收不合格：0 件（均不入可售库存）')
  assert.equal(page.returnSummary({ pendingInspectionCount: 0, rejectedReturnCount: 1 }), '已寄回待验收：0 件；验收不合格：1 件（均不入可售库存）')
  assert.match(sourceOf(inventory), /if\s*\(this\.returnSummary\(item\)\)/)
})

test('INV-UI-R2 退货记录以买家日期和次数识别，页面不显示内部售后编号', () => {
  const page = inventoryFixture()
  assert.equal(page.returnRecordLabel({ afterSaleId: 'internal-id', buyerAccount: '测试买家', createdAt: Date.UTC(2026, 10, 13, 2), sequence: 2 }), '测试买家 · 2026-11-13 10:00 · 售后第 2 次')
  for (const path of [inventory, merchant]) assert.doesNotMatch(sourceOf(path), /Text\('售后：'\s*\+/)
  assert.match(sourceOf(inventory), /Text\(this\.returnRecordLabel\(record\)\)/)
})

test('INV-UI-R2 不合格历史超出三条时显示剩余记录数', () => {
  const page = inventoryFixture()
  assert.equal(page.moreRejectedText({ hiddenRejectedRecordCount: 2 }), '另有 2 条不合格记录')
  assert.equal(page.moreRejectedText({ hiddenRejectedRecordCount: 0 }), '')
  assert.equal(page.moreRejectedText({}), '')
  assert.match(sourceOf(inventory), /if\s*\(this\.moreRejectedText\(item\)\)/)
})

test('INV-DEVICE 独立库存探针保留界面、退款原号和库存差额证据', () => {
  const driver = sourceOf('scripts/device-trade-regression.ps1'), probe = sourceOf('scripts/device-inventory-probe.ps1')
  assert.ok(driver.includes('[switch]$InventoryProbe'))
  assert.ok(driver.includes('Invoke-InventoryProbe; return'))
  assert.ok(driver.includes("$FixtureArguments += '--inventory-probe'"))
  for (const field of ['partial-inspection-result', 'inventory-separate-return-quantities', 'auto-refunded-still-pending-inspection', 'late-inspection-result', 'RefundsBefore', 'pendingInspectionCount', 'rejectedReturnCount', 'difference', 'Save-Result']) assert.ok(probe.includes(field), field)
})
