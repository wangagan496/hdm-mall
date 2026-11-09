import { test } from 'node:test'
import assert from 'node:assert/strict'

test('B-24: 缺货直接修改数量并留在结算页', async () => {
  const f = fixture(2); await f.load()
  await f.page.updateCheckoutQuantity('sku', '1')
  assert.equal(f.page.goodsList[0].count, 1)
  assert.equal(f.page.isCheckoutReady(), true)
  assert.deepEqual(f.paths, [])
  assert.equal(f.writes.length, 0)
})

test('D9/B-17: 立即购买同样更新报价、标明缺货并保留来源摘要', async () => {
  const f = fixture(); f.page.checkoutSelection = { skuId: 'sku', count: 3 }; await f.load()
  f.create(async () => { throw { httpStatus: 409, reason: 'PRICE_CHANGED', result: { totalAmountCents: 33,
    goods: [{ skuId: 'sku', priceCents: 11, subtotalCents: 33, count: 3 }] } } })
  await f.page.createOrderAndOpenCashier()
  const key = f.writes[0].requestKey
  assert.equal(f.writes[0].source, 'buy-now')
  assert.equal(f.page.summary.totalPayPrice, 0.33)
  f.create(async () => { throw { httpStatus: 409, reason: 'STOCK_SHORTAGE', result: {
    goods: [{ skuId: 'sku', name: '苹果', spec: '红', remainingCount: 1, requiredCount: 3 }] } } })
  await f.page.createOrderAndOpenCashier()
  assert.notEqual(f.writes[1].requestKey, key)
  assert.equal(f.writes[1].source, 'buy-now')
  assert.equal(f.page.goodsList[0].stock, 1)
  assert.equal(f.page.isCheckoutReady(), false)
  await f.page.updateCheckoutQuantity('sku', '1')
  assert.equal(f.page.goodsList[0].count, 1)
  assert.equal(f.page.checkoutSelection.count, 1)
  assert.deepEqual(f.paths, [])
})


test('B-21: 真实购物车合计用整数分，0.1元乘3等于0.3元', () => {
  const { CartOperationHelper } = execute(sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/utils/CartOperations.ets'))
  assert.equal(CartOperationHelper.calculateTotalPrice([{ selected: true, price: 0.1, count: 3 }]), 0.3)
})


test('B-32: 暂时查无订单保留原号，不重建订单，旧账号迟到查询不能改当前页', async () => {
  const f = fixture(); await f.load()
  f.create(async () => { throw new Error('timeout') })
  await f.page.createOrderAndOpenCashier()
  const oldKey = f.writes[0].requestKey
  f.lookup(async () => { throw { response: { status: 404 } } })
  await f.page.confirmPendingOrder()
  assert.equal(f.records.size, 1)
  assert.equal(f.page.confirmingOrder, true)
  assert.deepEqual(f.messages, [])
  f.create(async () => { throw new Error('timeout again') })
  f.lookup(async () => { throw new Error('offline') })
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 1)
  assert.equal(oldKey, f.page.orderRequestKey)
  const gate = deferred(); f.lookup(() => gate.promise)
  const checking = f.page.confirmPendingOrder()
  f.page.user = { id: 'other', token: 'other-token' }
  await f.page.loadCheckoutPreview()
  const before = f.messages.length
  gate.resolve({ id: 'old-order', orderState: 1 }); await checking
  assert.deepEqual(f.paths, ['home'])
  assert.equal(f.messages.length, before)
  assert.ok(f.records.has('buyer'))
})

test('D4: 落盘失败不发送创建请求，等待落盘时切换账号也不发送', async () => {
  const failed = fixture(); await failed.load()
  failed.storeManager.savePendingOrder = async () => { throw new Error('disk full') }
  await failed.page.createOrderAndOpenCashier()
  assert.equal(failed.writes.length, 0)
  const f = fixture(); await f.load()
  const gate = deferred(); f.storeManager.savePendingOrder = () => gate.promise
  const saving = f.page.createOrderAndOpenCashier()
  f.page.user = { id: 'other', token: 'other-token' }
  gate.resolve(); await saving
  assert.equal(f.writes.length, 0)
  assert.equal(f.paths.length, 0)
})

test('D4: 商品或地址变化后必须更换请求号', async () => {
  for (const change of ['goods', 'address']) {
    const f = fixture(); await f.load()
    await f.page.createOrderAndOpenCashier()
    if (change === 'goods') f.page.goodsList = [{ ...f.page.goodsList[0], count: 1 }]
    else { f.page.addressId = 'next'; f.page.addressList = [{ id: 'next' }] }
    await f.page.createOrderAndOpenCashier()
    assert.notEqual(f.writes[0].requestKey, f.writes[1].requestKey)
  }
})

import { pageMethods, deferred, tick, execute, sourceOf } from './native-harness.mjs'

const { checkoutFailure } = execute(sourceOf('mixed-development-h5/commons/storage/src/main/ets/OrderRequest.ets'))

test('B-31/B-32: 连点只创建一次，落盘先于请求；断网用旧号查且保持确认态', async () => {
  const f = fixture(); await f.load()
  const gate = deferred()
  f.create(() => {
    assert.equal(f.records.get('buyer').requestKey, f.writes[0].requestKey)
    return gate.promise
  })
  const first = f.page.createOrderAndOpenCashier()
  await tick()
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 1)
  gate.reject(new Error('lost response')); await first
  assert.equal(f.page.confirmingOrder, true)
  assert.equal(f.page.orderStatusText(), '正在确认是否下单成功，请勿重复提交')
  assert.equal(f.queries[0].key, f.writes[0].requestKey)
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 1)
  assert.equal(f.records.size, 1)
  f.lookup(async () => ({ id: 'recovered', orderState: 1 }))
  await f.page.confirmPendingOrder()
  assert.equal(f.paths[0].param, 'recovered')
  assert.equal(f.records.size, 0)
})

test('D4: 地址商品变化换号；不明确结果未查清前不能换号重提', async () => {
  const f = fixture(); await f.load()
  f.create(async () => { throw { httpStatus: 400 } })
  await f.page.createOrderAndOpenCashier()
  f.page.addressList = [{ id: 'new-address' }]; f.page.addressId = 'new-address'
  f.create(async () => { throw new Error('offline') })
  await f.page.createOrderAndOpenCashier()
  assert.notEqual(f.writes[0].requestKey, f.writes[1].requestKey)
  f.page.goodsList = [{ ...f.page.goodsList[0], count: 1 }]
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 2)
  assert.equal(f.records.get('buyer').requestKey, f.writes[1].requestKey)
})


test('B-24: 结算库存不足标注剩余数量并禁止创建', async () => {
  const f = fixture(2); await f.load()
  assert.equal(f.page.stockShortageText(f.page.goodsList[0]), '库存不足，剩余2件')
  assert.equal(f.page.isCheckoutReady(), false)
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 0)
})

test('B-25: 提交冲突突出具体商品，调整后换号', async () => {
  const f = fixture(); await f.load()
  f.create(async () => { throw { httpStatus: 409, reason: 'STOCK_SHORTAGE', result: {
    goods: [{ skuId: 'sku', name: '苹果', spec: '红', requiredCount: 3, remainingCount: 1 }] } } })
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.page.goodsList[0].stock, 1)
  assert.equal(f.page.isCheckoutReady(), false)
  assert.ok(f.messages.some(message => message.includes('苹果') && message.includes('红') && message.includes('库存不足')))
  f.page.goodsList = [{ ...f.page.goodsList[0], count: 1 }]
  f.page.summary = { ...f.page.summary, totalPayPrice: 0.1 }
  f.create(async () => ({ id: 'adjusted' }))
  await f.page.createOrderAndOpenCashier()
  assert.notEqual(f.writes[0].requestKey, f.writes[1].requestKey)
})


function fixture(stock = 9) {
  let previewOverride
  const writes = [], queries = [], messages = [], paths = [], records = new Map()
  let count = 3, counter = 0, create = async () => ({ id: 'order' }), lookup = async () => { throw new Error('offline') }
  const storeManager = {
    getPendingOrder: accountId => records.get(accountId) || null,
    savePendingOrder: async record => { records.set(record.accountId, structuredClone(record)) },
    clearPendingOrder: async (accountId, key) => { if (records.get(accountId)?.requestKey === key) records.delete(accountId) }
  }
  const Page = pageMethods('mixed-development-h5/features/cart/src/main/ets/presentation/views/CheckView.ets', 'CheckView', {}, {
    CheckoutSheet: { None: 0, Payment: 1, Address: 2 }, GlobalVariable: { DEMO_ORDER_FLOW: false },
    setTimeout: () => 1, clearTimeout() {},
    AppStorage: { setOrCreate() {} },
    util: { generateRandomUUID: () => 'request-key-' + ++counter }, storeManager,
    getOrderByRequestAPI: (key, token) => { queries.push({ key, token }); return lookup() },
    checkoutFailure,
    normalizeCheckoutAddress: value => value, emitter: { on() {}, off() {} }, BusinessVariable: { UPDATE_ADDRESS_LIST: 'address' },
    authCart: { updateCartCount: async () => {} }, PAGE_PATH: { PAY_PAGE: 'pay', ORDER_DETAIL_PAGE: 'detail', CART_PAGE: 'cart' },
    updateCheckoutCartAPI: async (sku, data) => { count = data.count },
    getPreOrderAPI: async (token, selection) => previewOverride || ({ goods: [{ skuId: 'sku', name: '苹果', attrsText: '红', stock, count: selection?.count ?? count, payPrice: '0.1' }],
      userAddresses: [{ id: 'address', isDefault: 0 }], summary: { totalPayPrice: (selection?.count ?? count) / 10, totalPrice: (selection?.count ?? count) / 10, goodsCount: selection?.count ?? count, discountPrice: 0, postFee: 0 } }),
    createOrderAPI: (body, token) => { writes.push({ ...structuredClone(body), token }); return create() }
  })
  const page = new Page()
  page.user = { id: 'buyer', token: 'token' }
  page.safeToast = message => messages.push(message)
  page.stackPath = { replacePath: path => paths.push(path), pop: () => paths.push('back'), clear: () => paths.push('home') }
  return { page, writes, queries, messages, paths, records, storeManager, load: () => page.loadCheckoutPreview(),
    create: fn => { create = fn }, lookup: fn => { lookup = fn }, preview: value => { previewOverride = value } }
}

test('提交瞬间下架自动刷新排除项，全部失效留页且不自动重下单', async () => {
  const f = fixture(); await f.load()
  const excludedGoods = [{ skuId: 'sku', name: '苹果', reason: '已下架' }]
  f.preview({ goods: [], excludedGoods, userAddresses: [{ id: 'address' }], summary: { totalPayPrice: 0, goodsCount: 0 } })
  f.create(async () => { throw { httpStatus: 409, reason: 'PRODUCT_UNAVAILABLE', result: { goods: excludedGoods } } })
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 1); assert.equal(f.page.goodsList.length, 0)
  assert.match(f.page.excludedNotice, /苹果已下架，已移出本次结算/)
  assert.equal(f.page.isCheckoutReady(), false); assert.deepEqual(f.paths, [])
  assert.equal(f.records.size, 0)
})

test('鉴权明确拒绝即使拦截器先清登录，也清除原待确认记录并保留同号重登提交', async () => {
  const f = fixture(); await f.load()
  f.create(async () => { f.page.user = { id: 'buyer', token: '' }; throw { httpStatus: 401 } })
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.records.size, 0)
  const originalKey = f.writes[0].requestKey
  f.page.user = { id: 'buyer', token: 'renewed' }; await f.load()
  f.create(async () => ({ id: 'new-order' })); await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes.length, 2); assert.equal(f.writes[1].requestKey, originalKey)
})

test('B-23: 409后显示新价且不跳转，再确认才换号下单', async () => {
  const f = fixture(); await f.load()
  f.create(async () => { throw { httpStatus: 409, reason: 'PRICE_CHANGED', result: { totalAmountCents: 33,
    goods: [{ skuId: 'sku', name: '苹果', spec: '红', priceCents: 11, count: 3, subtotalCents: 33 }] } } })
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.page.summary.totalPayPrice, 0.33)
  assert.equal(f.page.goodsList[0].payPrice, '0.11')
  assert.equal(f.writes[0].expectedAmountCents, 30)
  assert.equal(f.paths.length, 0)
  assert.equal(f.page.isCheckoutReady(), true)
  assert.ok(f.messages.includes('商品价格有变化，已更新为最新价格，请确认后再提交'))
  f.create(async () => ({ id: 'confirmed' }))
  await f.page.createOrderAndOpenCashier()
  assert.equal(f.writes[1].expectedAmountCents, 33)
  assert.notEqual(f.writes[0].requestKey, f.writes[1].requestKey)
  assert.equal(f.paths[0].param, 'confirmed')
  assert.equal(f.records.size, 0)
})
