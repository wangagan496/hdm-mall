import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageMethods, deferred, tick } from './native-harness.mjs'

function fixture(buyNow = false) {
  const edits = [], quotes = [], writes = [], navigation = [], messages = []
  let key = 0
  const Page = pageMethods('mixed-development-h5/features/cart/src/main/ets/presentation/views/CheckView.ets', 'CheckView', {}, {
    CheckoutSheet: { None: 0, Address: 2 }, GlobalVariable: { DEMO_ORDER_FLOW: false },
    util: { generateRandomUUID: () => `key-${++key}` },
    normalizeCheckoutAddress: value => value,
    storeManager: { getPendingOrder: () => null },
    updateCheckoutCartAPI: async (...args) => { edits.push(args) },
    getPreOrderAPI: (...args) => { const gate = deferred(); quotes.push({ args, ...gate }); return gate.promise },
    createOrderAPI: (...args) => { writes.push(args) },
    emitter: { off() {} }, BusinessVariable: {},
  })
  const page = new Page()
  page.user = { id: 'buyer', token: 'token' }; page.checkoutToken = 'token'; page.checkoutAccountId = 'buyer'
  page.checkoutLoading = false; page.addressManuallySelected = true; page.addressId = 'chosen'
  page.addressList = [{ id: 'chosen', isDefault: 1 }]
  page.goodsList = [{ skuId: 'sku', name: '商品', count: 3, stock: 1, price: '10', payPrice: '10' }]
  page.summary = { totalPayPrice: 30, goodsCount: 3 }
  page.requestSummary = 'previous-content'
  page.safeToast = value => messages.push(value)
  page.stackPath = { pop: () => navigation.push('pop'), replacePath: value => navigation.push(value) }
  if (buyNow) page.checkoutSelection = { skuId: 'sku', count: 3 }
  return { page, edits, quotes, writes, navigation, messages }
}

test('缺货数量原位修改后取服务端新报价，保留地址且不自动下单，下一次提交用新请求号', async () => {
  for (const buyNow of [false, true]) {
    const f = fixture(buyNow), oldKey = f.page.orderRequestKey
    const editing = f.page.updateCheckoutQuantity('sku', '1')
    await tick()
    assert.equal(f.page.checkoutLoading, true)
    assert.equal(f.quotes.length, 1)
    if (buyNow) assert.equal(f.edits.length, 0)
    else assert.deepEqual(JSON.parse(JSON.stringify(f.edits)), [['sku', { count: 1 }, 'token']])
    f.quotes[0].resolve({ goods: [{ skuId: 'sku', count: 1, stock: 1 }],
      userAddresses: [{ id: 'default', isDefault: 0 }, { id: 'chosen', isDefault: 1 }],
      summary: { totalPayPrice: 10, goodsCount: 1 } })
    await editing
    assert.equal(f.page.summary.totalPayPrice, 10)
    assert.equal(f.page.addressId, 'chosen')
    assert.notEqual(f.page.buildOrderRequest().requestKey, oldKey)
    assert.equal(f.writes.length, 0)
    assert.deepEqual(f.navigation, [])
  }
})

test('移除最后一件缺货商品原位显示空结算，不跳转也不创建订单', async () => {
  const f = fixture(true)
  await f.page.removeCheckoutItem('sku')
  assert.equal(f.page.goodsList.length, 0)
  assert.equal(f.page.summary.totalPayPrice, 0)
  assert.equal(f.page.isCheckoutReady(), false)
  assert.deepEqual(f.navigation, [])
  assert.equal(f.writes.length, 0)
})

test('立即购买移除后回前台重新取预览不会恢复已移除商品', async () => {
  const f = fixture(true)
  await f.page.removeCheckoutItem('sku')
  const reloading = f.page.loadCheckoutPreview()
  await tick()
  assert.equal(f.quotes.length, 0)
  await reloading
  assert.equal(f.page.goodsList.length, 0)
})

test('非法数量与待确认订单禁止修改；修改报价失败保留内容且禁止提交', async () => {
  const f = fixture()
  for (const count of ['0', '-1', '1.5', '1000', 'abc']) await f.page.updateCheckoutQuantity('sku', count)
  assert.equal(f.edits.length, 0)
  f.page.confirmingOrder = true
  await f.page.updateCheckoutQuantity('sku', '1')
  await f.page.removeCheckoutItem('sku')
  assert.equal(f.edits.length, 0)
  f.page.confirmingOrder = false
  const changing = f.page.updateCheckoutQuantity('sku', '1')
  await tick(); f.quotes[0].reject(new Error('offline')); await changing
  assert.equal(f.page.checkoutRefreshFailed, true)
  assert.equal(f.page.isCheckoutReady(), false)
  assert.equal(f.page.addressId, 'chosen')
  assert.equal(f.writes.length, 0)
})
