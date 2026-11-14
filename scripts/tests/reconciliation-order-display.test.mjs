import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageMethods, sourceOf } from './native-harness.mjs'
const path = 'mixed-development-h5/features/mine/src/main/ets/presentation/views/ReconciliationView.ets'
function fixture() {
  const Page = pageMethods(path, 'ReconciliationView', {}, { reconciliationDay: () => '2026-11-11', formatBeijingTime: () => '2026-11-11 08:00' })
  const page = new Page(), calls = []
  page.user = { id: 'seller', role: 'merchant', token: 'session' }; page.active = true
  page.stackPath = { pushPath: value => calls.push(value) }
  return { page, calls }
}
test('E19 对账卡片显示买家、北京时间与多件商品，不向商家展示内部业务编号', () => {
  const { page } = fixture()
  const item = { id: 'diff', businessId: 'payment-internal', orderId: 'order', buyerAccount: 'buyer', orderCreatedAt: 1794355200000,
    orderItems: [{ name: '短袜', count: 2 }, { name: '收纳包', count: 1 }] }
  assert.equal(page.orderSummary(item), 'buyer · 2026-11-11 08:00 · 短袜 × 2、收纳包 × 1')
  assert.equal(page.orderSummary({ id: 'external', orderId: null, orderItems: [] }), '系统内无对应订单')
  assert.doesNotMatch(sourceOf(path), /Text\('业务编号：'/)
  assert.match(sourceOf(path), /Text\(this\.orderSummary\(item\)\)/)
})
test('E19 商家从当前差异打开对应订单，渠道独有记录不提供跳转', () => {
  const { page, calls } = fixture()
  const item = { id: 'diff', orderId: 'order' }, external = { id: 'external', orderId: null }
  page.report = { differences: [item, external] }
  page.openOrder(item)
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'MerchantOrderView'); assert.equal(calls[0].param, 'order')
  page.openOrder(external); assert.equal(calls.length, 1)
  page.active = false; page.openOrder(item); assert.equal(calls.length, 1)
  page.active = true; page.user.role = 'buyer'; page.openOrder(item); assert.equal(calls.length, 1)
  assert.match(sourceOf(path), /if \(item\.orderId\)/)
  assert.match(sourceOf(path), /onClick\(\(\) => this\.openOrder\(item\)\)/)
})
