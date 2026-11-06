import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, execute, pageMethods, sourceOf, tick } from './native-harness.mjs'

function checkoutFixture() {
  const previews = [], paths = [], lookups = [], writes = [], pending = new Map()
  let preview = async () => ({ goods: [{ skuId: 'sku', count: 1, stock: 5, payPrice: '1' }],
    userAddresses: [{ id: 'address', isDefault: 0 }],
    summary: { totalPayPrice: 1, totalPrice: 1, goodsCount: 1, discountPrice: 0, postFee: 0 } })
  let counter = 0
  const Page = pageMethods('mixed-development-h5/features/cart/src/main/ets/presentation/views/CheckView.ets', 'CheckView', {}, {
    CheckoutSheet: { None: 0, Payment: 1, Address: 2 }, GlobalVariable: { DEMO_ORDER_FLOW: false },
    util: { generateRandomUUID: () => 'key-' + ++counter },
    storeManager: { getPendingOrder: id => pending.get(id), savePendingOrder: async record => pending.set(record.accountId, record),
      clearPendingOrder: async id => pending.delete(id) },
    emitter: { on() {}, off() {} }, BusinessVariable: { UPDATE_ADDRESS_LIST: 'address' },
    authCart: { updateCartCount: async () => {} }, PAGE_PATH: { PAY_PAGE: 'pay', ORDER_DETAIL_PAGE: 'detail', CART_PAGE: 'cart' },
    normalizeCheckoutAddress: value => value, AppStorage: { setOrCreate() {} },
    getOrderByRequestAPI: async (key, token) => { lookups.push({ key, token }); return { id: 'known-order', orderState: 1 } },
    getPreOrderAPI: (...args) => { previews.push(args); return preview(...args) },
    createOrderAPI: async request => { writes.push(request); return { id: 'order' } }
  })
  const page = new Page(); page.user = { id: 'buyer-a', token: 'token-a' }
  page.stackPath = { getParamByName: () => [{ skuId: 'sku', count: 1 }], replacePath: value => paths.push(value),
    pop: () => paths.push('back'), clear: () => paths.push('home') }
  page.safeToast = () => {}
  return { page, previews, paths, pending, lookups, writes, setPreview: fn => { preview = fn } }
}

test('B-26: 同账号换凭证保留结算及请求号', async () => {
  const f = checkoutFixture(); await f.page.loadCheckoutPreview()
  f.page.addressManuallySelected = true
  const key = f.page.orderRequestKey
  f.page.user = { id: 'buyer-a', token: 'token-new' }
  await f.page.loadCheckoutPreview()
  assert.equal(f.page.orderRequestKey, key)
  assert.equal(f.page.addressId, 'address')
  assert.equal(f.page.goodsList.length, 1)
  assert.equal(f.page.addressManuallySelected, true)
})

test('B-26: 登录失效再登录保留已确认报价，未知结果只查询原号不重提', async () => {
  const f = checkoutFixture(); await f.page.loadCheckoutPreview()
  f.page.summary.totalPayPrice = 2
  f.page.addressManuallySelected = true
  const request = f.page.buildOrderRequest(), summary = f.page.requestSummary
  f.page.user = { token: '' }; f.page.reloadForCurrentAccount(); await tick()
  assert.equal(f.page.summary.totalPayPrice, 2)
  assert.equal(f.page.orderRequestKey, request.requestKey)
  f.page.user = { id: 'buyer-a', token: 'renewed' }; f.page.reloadForCurrentAccount(); await tick()
  assert.equal(f.page.summary.totalPayPrice, 2)
  assert.equal(f.page.requestSummary, summary)
  assert.equal(f.previews.length, 1)
  f.pending.set('buyer-a', { accountId: 'buyer-a', requestKey: request.requestKey, summary })
  f.page.user = { id: 'buyer-a', token: 'renewed-again' }; f.page.reloadForCurrentAccount(); await tick()
  assert.deepEqual(f.lookups, [{ key: request.requestKey, token: 'renewed-again' }])
  assert.equal(f.writes.length, 0)
  assert.equal(f.paths[0].param, 'known-order')
})

test('B-27/B-71: 换账号清空并回首页，迟到响应不能覆盖新账号', async () => {
  const f = checkoutFixture(); const old = deferred()
  f.setPreview(() => old.promise)
  const first = f.page.loadCheckoutPreview()
  f.page.user = { id: 'buyer-b', token: 'token-b' }
  f.setPreview(async () => ({ goods: [], userAddresses: [], summary: { totalPayPrice: 0 } }))
  await f.page.loadCheckoutPreview()
  old.resolve({ goods: [{ skuId: 'old' }], userAddresses: [{ id: 'old' }], summary: { totalPayPrice: 5 } })
  await first
  assert.equal(f.page.goodsList.some(item => item.skuId === 'old'), false)
  assert.equal(f.page.addressList.some(item => item.id === 'old'), false)
  assert.ok(f.paths.includes('home'))
})

test('B-17/B-18: 指定预览及来源进入请求摘要', async () => {
  const f = checkoutFixture()
  f.page.aboutToAppear()
  await f.page.loadCheckoutPreview()
  assert.deepEqual(f.previews[0], ['token-a', { skuId: 'sku', count: 1 }])
  assert.equal(f.page.buildOrderRequest().source, 'buy-now')
  assert.equal(JSON.parse(f.page.requestSummary).source, 'buy-now')
})

test('D5: 续办意图限定 30 分钟且账号绑定', () => {
  const api = execute(sourceOf('mixed-development-h5/features/home/src/main/ets/data/api/loginSkuSelection.ets'), {
    './goodsPresentation': { normalizeSkuSelection: value => value || { id: '', specs: [] }, normalizeSkuSpecs: () => [] },
    './mockData': { isFallbackSkuId: () => false }
  })
  const intent = { goodsId: 'goods', sku: { id: 'sku', specs: [], price: '1' }, count: 1, action: 'cart',
    requestKey: 'key', created: 1000, accountId: 'buyer-a' }
  assert.equal(api.isPendingTradeValid(intent, 1000 + 30 * 60_000, 'buyer-a'), true)
  assert.equal(api.isPendingTradeValid(intent, 1000 + 30 * 60_000 + 1, 'buyer-a'), false)
  assert.equal(api.isPendingTradeValid(intent, 1000, 'buyer-b'), false)
})

test('B-10: 重启后从登录页完成登录会打开持久意图商品页', async () => {
  class HuaweiController {
    setAgreementStatus() { return this }
    setEnabled() { return this }
    onClickLoginWithHuaweiIDButton() { return this }
  }
  const paths = ['login']
  const user = { id: 'buyer', token: 'token' }
  const record = { accountId: 'buyer', requestKey: 'key', goodsId: 'goods', created: 1000, entry: { id: 'goods' } }
  const Page = pageMethods('mixed-development-h5/features/mine/src/main/ets/presentation/views/LoginView.ets', 'LoginView', {}, {
    loginComponentManager: { LoginWithHuaweiIDButtonController: HuaweiController, AgreementStatus: {} },
    auth: { getUserInfo: () => user }, GlobalVariable: { DEMO_ORDER_FLOW: false }, Date: { now: () => 2000 },
    storeManager: { getPendingTrade: () => JSON.stringify(record) }, PAGE_PATH: { GOODS_PAGE: 'goods', LOGIN_PAGE: 'login' }
  })
  const page = new Page()
  page.stackPath = { getAllPathName: () => paths, pop: () => paths.pop(), pushPath: value => paths.push(value.name) }
  await page.finishLogin(user)
  assert.deepEqual(paths, ['goods'])
})
