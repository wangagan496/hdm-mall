import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, pageMethods, tick } from './native-harness.mjs'

function preview(skuId = 'sku-a', addressId = 'address-a') {
  return {
    goods: [{ skuId, count: 2 }],
    userAddresses: [{ id: addressId, isDefault: 0 }],
    summary: { totalPayPrice: 20, totalPrice: 20, goodsCount: 2, postFee: 0, discountPrice: 0 },
  }
}

function fixture() {
  const queries = [], writes = [], writeTokens = [], messages = [], navigations = []
  let badges = 0, nextKey = 0
  let submit = async () => ({ id: 'created-order' })
  let lookup = async () => { throw new Error('offline') }
  const records = new Map(), lookups = []
  const Page = pageMethods('mixed-development-h5/features/cart/src/main/ets/presentation/views/CheckView.ets', 'CheckView', {}, {
    CheckoutSheet: { None: 0, Payment: 1, Address: 2 },
    GlobalVariable: { DEMO_ORDER_FLOW: false },
    storeManager: {
      getPendingOrder: accountId => records.get(accountId) || null,
      savePendingOrder: async record => { records.set(record.accountId, structuredClone(record)) },
      clearPendingOrder: async (accountId, key) => { if (records.get(accountId)?.requestKey === key) records.delete(accountId) }
    },
    checkoutFailure: error => ({ status: error.httpStatus || 0 }),
    getOrderByRequestAPI: (key, token) => { lookups.push({ key, token }); return lookup() },
    util: { generateRandomUUID: () => `request-key-${++nextKey}` },
    normalizeCheckoutAddress: value => value,
    getPreOrderAPI: token => { const gate = deferred(); queries.push({ ...gate, token }); return gate.promise },
    createOrderAPI: (request, token) => {
      writes.push(JSON.parse(JSON.stringify(request))); writeTokens.push(token); return submit()
    },
    authCart: { updateCartCount: async () => { badges++ } },
    emitter: { on() {}, off() {} },
    BusinessVariable: { UPDATE_ADDRESS_LIST: 'address' },
    PAGE_PATH: { PAY_PAGE: 'pay' },
  })
  const page = new Page()
  page.user = { id: 'buyer-a', token: 'buyer-a' }
  page.safeToast = message => messages.push(message)
  page.stackPath = { replacePath: path => navigations.push(path.param), pop: () => navigations.push('back') }
  const load = async value => {
    const loading = page.loadCheckoutPreview()
    queries.at(-1).resolve(value)
    await loading
  }
  return { page, queries, writes, writeTokens, messages, navigations, load, lookups, setLookup: fn => { lookup = fn },
    badges: () => badges, setSubmit: fn => { submit = fn } }
}

test('结算刷新未完成时不能用旧地址和商品提交，最新资料确认后才允许下单', async () => {
  const f = fixture()
  await f.load(preview())
  const loading = f.page.loadCheckoutPreview()
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 0)
  f.queries.at(-1).resolve(preview('sku-b', 'address-b'))
  await loading
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0].addressId, 'address-b')
  assert.deepEqual(f.writes[0].goods, [{ skuId: 'sku-b', count: 2 }])
  assert.deepEqual(f.navigations, ['created-order'])
})

test('刷新失败保留结算内容但禁止提交，重试成功后恢复', async () => {
  const f = fixture()
  await f.load(preview())
  const loading = f.page.loadCheckoutPreview()
  f.queries.at(-1).reject(new Error('offline'))
  await loading
  assert.equal(f.page.goodsList[0].skuId, 'sku-a')
  assert.equal(f.page.summary.totalPayPrice, 20)
  assert.equal(f.page.checkoutRefreshFailed, true)
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 0)
  await f.load(preview())
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 1)
})

test('服务端确认空购物车后清除旧商品及金额，返回期间也不能提交旧订单', async () => {
  const f = fixture()
  await f.load(preview())
  await f.load({ ...preview(), goods: [] })
  assert.equal(f.page.goodsList.length, 0)
  assert.equal(f.page.summary.totalPayPrice, 0)
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 0)
  assert.deepEqual(f.navigations, ['back'])
})

test('旧结算查询成功或失败不能提前解除最新查询的提交限制', async () => {
  for (const fails of [false, true]) {
    const f = fixture()
    await f.load(preview())
    const old = f.page.loadCheckoutPreview()
    const current = f.page.loadCheckoutPreview()
    if (fails) f.queries[1].reject(new Error('late failure'))
    else f.queries[1].resolve(preview('old'))
    await old
    await f.page.createOrderAndOpenCashier()
    assert.equal(f.writes.length, 0)
    assert.equal(f.page.checkoutRefreshFailed, false)
    f.queries[2].resolve(preview('current'))
    await current
    await f.page.createOrderAndOpenCashier()
    assert.equal(f.writes[0].goods[0].skuId, 'current')
  }
})

test('结算刷新关闭旧金额的支付确认层，保留地址选择并在新资料确认后重开', async () => {
  const f = fixture()
  await f.load(preview())
  f.page.activeSheet = 1
  f.page.showSheet = true
  const loading = f.page.loadCheckoutPreview()
  assert.equal(f.page.showSheet, false)
  f.queries.at(-1).resolve(preview())
  await loading
  assert.equal(f.page.showSheet, false)
  f.page.openPaymentSheet()
  assert.equal(f.page.showSheet, true)
  assert.equal(f.page.activeSheet, 1)
  f.page.activeSheet = 2
  const selecting = f.page.loadCheckoutPreview()
  assert.equal(f.page.showSheet, true)
  f.queries.at(-1).resolve(preview())
  await selecting
})

test('首次查询、无商品和无效地址不能下单，离页的迟到预览不能恢复提交', async () => {
  const f = fixture()
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 0)
  await f.load(preview())
  f.page.addressId = 'not-in-current-addresses'
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 0)
  f.page.addressId = 'address-a'
  const pending = f.page.loadCheckoutPreview()
  f.page.aboutToDisappear()
  f.queries.at(-1).resolve(preview('late'))
  await pending
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 0)
})

test('就绪后重复提交只创建一次在途请求，失败重查沿用原请求编号', async () => {
  const f = fixture()
  await f.load(preview())
  const gate = deferred()
  f.setSubmit(() => gate.promise)
  const submitting = f.page.createOrderAndOpenCashier()
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 1)
  gate.reject(new Error('response lost'))
  await submitting
  assert.equal(f.page.isSubmittingOrder, false)
  f.setLookup(async () => ({ id: 'recovered-order', orderState: 1 }))
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 1)
  assert.ok(f.lookups.every(query => query.key === f.writes[0].requestKey))
  assert.deepEqual(f.navigations, ['recovered-order'])
})

test('切换账号立即清除结算地址商品和金额，旧查询成功失败或空结果均不影响新账号', async () => {
  for (const result of ['success', 'failure', 'empty']) {
    const f = fixture()
    await f.load(preview())
    f.page.addressManuallySelected = true
    const old = f.page.loadCheckoutPreview()
    f.page.user = { id: 'buyer-b', token: 'buyer-b' }
    const current = f.page.loadCheckoutPreview()
    assert.equal(f.page.goodsList.length, 0)
    assert.equal(f.page.addressList.length, 0)
    assert.equal(f.page.addressId, '')
    assert.equal(f.page.addressManuallySelected, false)
    assert.equal(f.page.summary.totalPayPrice, 0)
    if (result === 'failure') f.queries[1].reject(new Error('old error'))
    else f.queries[1].resolve({ ...preview(), goods: result === 'empty' ? [] : preview().goods })
    await old
    assert.equal(f.page.checkoutLoading, true)
    assert.deepEqual(f.messages, [])
    assert.deepEqual(f.navigations, [])
    f.queries[2].resolve(preview('sku-b', 'address-b'))
    await current
    assert.equal(f.page.addressId, 'address-b')
  }
})

test('下单结果在离页后到达不跳转、不提示，也不刷新新页面角标', async () => {
  for (const fails of [false, true]) {
    const f = fixture()
    await f.load(preview())
    const pending = deferred()
    f.setSubmit(() => pending.promise)
    const saving = f.page.createOrderAndOpenCashier()
    await tick()
    f.page.aboutToDisappear()
    if (fails) pending.reject(new Error('late error'))
    else pending.resolve({ id: 'old-order' })
    await saving
    assert.deepEqual(f.navigations, [])
    assert.deepEqual(f.messages, [])
    assert.equal(f.badges(), 0)
  }
})

test('换账号或离页重进后旧下单收尾不能解除新提交锁，当前结果正常跳转', async () => {
  for (const transition of ['account', 'reenter']) {
    const f = fixture()
    await f.load(preview())
    const oldGate = deferred(), newGate = deferred()
    f.setSubmit(() => oldGate.promise)
    const old = f.page.createOrderAndOpenCashier()
    await tick()
    if (transition === 'reenter') f.setLookup(() => newGate.promise)
    if (transition === 'account') {
      f.page.user = { id: 'buyer-b', token: 'buyer-b' }
      f.page.reloadForCurrentAccount()
    } else {
      f.page.aboutToDisappear()
      f.page.aboutToAppear()
    }
    f.queries.at(-1).resolve(transition === 'account' ? preview('sku-b', 'address-b') : preview())
    await tick()
    f.setSubmit(() => newGate.promise)
    const current = f.page.createOrderAndOpenCashier()
    await tick()
    assert.equal(f.writes.length, transition === 'account' ? 2 : 1)
    if (transition === 'account') assert.notEqual(f.writes[0].requestKey, f.writes[1].requestKey)
    else assert.equal(f.lookups[0].key, f.writes[0].requestKey)
    oldGate.resolve({ id: 'old-order' })
    await old
    assert.equal(transition === 'account' ? f.page.isSubmittingOrder : f.page.confirmingRequest, true)
    assert.deepEqual(f.navigations, [])
    newGate.resolve({ id: 'current-order', orderState: 1 })
    await current
    await tick()
    assert.equal(f.page.isSubmittingOrder, false)
    assert.deepEqual(f.navigations, ['current-order'])
    assert.equal(f.badges(), 1)
  }
})

test('结算请求使用发起时凭证，账号监听前也不能借新账号提交旧结算', async () => {
  const f = fixture()
  await f.load(preview())
  assert.equal(f.queries[0].token, 'buyer-a')
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writeTokens[0], 'buyer-a')
  f.page.user = { id: 'buyer-b', token: 'buyer-b' }
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 1)
})

test('退出登录清空结算且不发匿名查询，同账号资料更新不重新生成请求编号', async () => {
  const anonymous = fixture()
  anonymous.page.user = { token: '' }
  await anonymous.page.loadCheckoutPreview()
  assert.equal(anonymous.queries.length, 0)
  assert.equal(anonymous.page.checkoutLoading, false)
  const f = fixture()
  await f.load(preview())
  const key = f.page.orderRequestKey
  f.page.user = { id: 'buyer-a', token: 'buyer-a', nickname: 'new-name' }
  f.page.reloadForCurrentAccount()
  assert.equal(f.queries.length, 1)
  assert.equal(f.page.orderRequestKey, key)
  f.page.user = { token: '' }
  f.page.reloadForCurrentAccount()
  assert.equal(f.queries.length, 1)
  assert.equal(f.page.goodsList.length, 0)
  assert.equal(f.page.addressList.length, 0)
  assert.equal(f.page.checkoutLoading, false)
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 0)
  f.page.aboutToDisappear()
  f.page.user = { id: 'buyer-b', token: 'buyer-b' }
  f.page.reloadForCurrentAccount()
  assert.equal(f.queries.length, 1)
  f.page.aboutToAppear()
  assert.equal(f.queries.length, 2)
  f.queries[1].resolve(preview('sku-b', 'address-b'))
  await tick()
  assert.equal(f.page.addressId, 'address-b')
})
