import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deferred, execute, pageMethods, sourceOf } from './native-harness.mjs'

const native = 'mixed-development-h5/features/'
const draft = { id: 'd1', entries: [
  { fieldId: 'dispatch-window', label: '发货时效', status: 'known', quote: '48小时发货' },
  { fieldId: 'gift', label: '赠品', status: 'known', quote: '赠防尘袋' },
  { fieldId: 'origin', label: '产地', status: 'unknown' },
] }
const snapshot = { receiptId: 'r1', publishedAt: 120, entries: [draft.entries[0]] }
const owner = { id: 'seller', identity: 'merchant', identityRevision: 0, token: 'seller-token' }

function merchantPage(overrides = {}) {
  const pending = new Map(), calls = [], dialogs = []
  const Page = pageMethods(native + 'mine/src/main/ets/presentation/views/ProductPromisesView.ets', 'ProductPromisesView', {}, {
    sameIdentitySession: (a, b) => a?.token === b?.token && a?.identity === b?.identity && a?.identityRevision === b?.identityRevision,
    storeManager: { getStore: () => ({ getSync: (key, fallback) => pending.get(key) ?? fallback,
      putSync: (key, value) => pending.set(key, value), flush: async () => {} }) },
    util: { generateRandomUUID: () => 'request-key' },
    getProductPromises: async () => ({ draft, published: null }),
    extractProductPromises: async () => ({ draft, published: null }),
    confirmProductPromises: async (id, draftId, decisions) => { calls.push(['confirm', id, draftId, JSON.parse(JSON.stringify(decisions))]); return 'token' },
    publishProductPromises: async (id, confirmation, key) => { calls.push(['publish', id, confirmation, key]); return snapshot },
    findPromiseReceipt: async () => null,
    promiseRequestMessage: (_error, fallback) => fallback,
    promiseRequestStatus: () => 0,
    ...overrides,
  })
  const page = new Page()
  page.user = owner
  page.productId = 'product-1'
  page.getUIContext = () => ({ showAlertDialog: dialog => dialogs.push(dialog) })
  return { page, pending, calls, dialogs }
}

test('商家须逐条决定，未说明项没有选择，发布弹窗随身份版本变化作废', async () => {
  const { page, calls, dialogs } = merchantPage()
  await page.load()
  page.choose(draft.entries[2], 'accept')
  page.choose(draft.entries[0], 'accept')
  assert.equal(page.canPublish(), false)
  page.choose(draft.entries[1], 'reject')
  assert.equal(page.canPublish(), true)
  page.requestPublish()
  assert.equal(dialogs.length, 1)
  page.user = { ...owner, identityRevision: 2 }
  dialogs[0].secondaryButton.action()
  assert.deepEqual(calls, [])
  page.accountChanged()
  assert.equal(page.decisions.length, 0)
})

test('发布掉线后在同一店主与商品下查原回执，凭据不写进本地存储', async () => {
  let recovered = false
  const lookedUp = []
  const { page, pending, calls } = merchantPage({
    publishProductPromises: async () => { throw new Error('lost response') },
    findPromiseReceipt: async (id, key) => { lookedUp.push([id, key]); return recovered ? snapshot : null },
  })
  await page.load()
  await page.publish(draft.id, [{ fieldId: 'dispatch-window', decision: 'accept' }, { fieldId: 'gift', decision: 'reject' }],
    page.generation, owner)
  assert.equal(pending.get('promise-publication:seller:product-1'), 'request-key')
  assert.equal(page.published, null)
  assert.equal(page.message, '发布结果暂未确认，请查询发布结果')
  recovered = true
  page.hide()
  page.active = true
  await page.load()
  assert.deepEqual(lookedUp, [['product-1', 'request-key']])
  assert.equal(page.published.receiptId, 'r1')
  assert.equal(pending.get('promise-publication:seller:product-1'), '')
  assert.deepEqual(calls, [['confirm', 'product-1', 'd1', [
    { fieldId: 'dispatch-window', decision: 'accept' }, { fieldId: 'gift', decision: 'reject' },
  ]]])
})

test('订单核对获得服务端确认后带着冻结字段进售后，切换身份不跳转', async () => {
  const writes = [], paths = []
  let gate = deferred()
  const Page = pageMethods(native + 'cart/src/main/ets/presentation/views/OrderDetailView.ets', 'OrderDetailView', {}, {
    frozenOrderPromise: (value, fieldId) => value?.entries.find(entry => entry.fieldId === fieldId),
    RequestAxios: { putForSession: (...args) => { writes.push(args); return gate.promise } },
    PAGE_PATH: { AFTER_SALE_APPLY_PAGE: 'after-sale' },
  })
  const page = new Page()
  page.user = { id: 'buyer', identity: 'buyer', identityRevision: 0, token: 'buyer-token' }
  page.orderId = 'order-1'
  function ready() {
    page.synchronizeDetailContext()
    page.order = { id: 'order-1', canCheckPromises: true, canApplyAfterSale: true,
      skus: [{ id: 'sku-1', afterSaleRemaining: 1, promiseSnapshot: snapshot }] }
    page.loading = false
  }
  ready()
  page.loadOrderDetail = async () => {}
  page.stackPath = { pushPath: route => paths.push(JSON.parse(JSON.stringify(route))) }
  const stale = page.checkPromise('sku-1', 'dispatch-window', 'mismatch')
  page.user = { ...page.user, identity: 'merchant', identityRevision: 1 }
  page.synchronizeDetailContext()
  gate.resolve({ fieldId: 'dispatch-window', result: 'mismatch' })
  await stale
  assert.deepEqual(paths, [])
  page.user = { ...page.user, identity: 'buyer', identityRevision: 2 }
  ready()
  gate = deferred()
  const current = page.checkPromise('sku-1', 'dispatch-window', 'mismatch')
  assert.equal(writes.length, 2)
  gate.resolve({ fieldId: 'dispatch-window', result: 'mismatch' })
  await current
  assert.deepEqual(paths, [{ name: 'after-sale', param: {
    orderId: 'order-1', promiseMismatch: { skuId: 'sku-1', fieldId: 'dispatch-window' },
  } }])
})

test('已核对状态变化时刷新相同规格的承诺卡片', () => {
  const Page = pageMethods(native + 'cart/src/main/ets/presentation/views/OrderDetailView.ets', 'OrderDetailView')
  const page = new Page()
  const sku = { id: 'sku-1', promiseSnapshot: snapshot }
  const unchecked = page.promiseCardKey(sku)
  const matches = page.promiseCardKey({ ...sku, promiseChecks: [{ fieldId: 'dispatch-window', result: 'matches' }] })
  const mismatch = page.promiseCardKey({ ...sku, promiseChecks: [{ fieldId: 'dispatch-window', result: 'mismatch' }] })
  assert.notEqual(matches, unchecked)
  assert.notEqual(mismatch, matches)
  assert.equal(page.promiseCardKey({ ...sku, promiseChecks: [] }), unchecked)
})

test('商家草稿和订单承诺卡片显示原文核对提醒', () => {
  const merchant = sourceOf(native + 'mine/src/main/ets/presentation/views/ProductPromisesView.ets')
  const order = sourceOf(native + 'cart/src/main/ets/presentation/components/OrderPromisesCard.ets')
  assert.match(merchant, /if \(entry\.conditionNeedsReview\)[\s\S]*Text\('请看原文核对'\)/)
  assert.match(order, /if \(entry\.conditionNeedsReview\)[\s\S]*Text\('原文另有适用限制，以原文为准'\)/)
})

test('device promise probe includes unselected dispatch and frozen material suggestion checks', () => {
  const fixture = sourceOf('scripts/tests/device-trade-server.ts')
  const probe = sourceOf('scripts/device-promises-probe.ps1')
  assert.ok(fixture.includes("condition: '收货后'"))
  assert.ok(fixture.includes("fieldId: 'material'"))
  assert.ok(probe.includes("Wait-Text '逐条确认草稿'"))
  assert.ok(probe.includes("Wait-Text '请选择适合你的售后类型'"))
  assert.ok(probe.includes('dispatchMismatchTypeUnselected=$true'))
  assert.ok(probe.includes("Wait-Text '质量问题退货 ✓ 已选'"))
  assert.ok(probe.includes('materialMismatchPreselectedQualityReturn=$true'))
})

test('售后预选读取订单冻结的字段版本规则，类型不可用时保持未选', async () => {
  const { legacyPromiseAfterSaleKind } = execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/Promises.ets'))
  let legacySuggestion = () => ''
  let loadedOrder
  const Page = pageMethods(native + 'cart/src/main/ets/presentation/views/AfterSaleApplyView.ets', 'AfterSaleApplyView', {}, {
    GlobalVariable: {}, afterSaleActions: { pending: () => null },
    legacyPromiseAfterSaleKind: (...args) => legacySuggestion(...args),
    getAfterSaleOrderAPI: async () => loadedOrder,
    frozenOrderPromise: (value, fieldId) => value.entries.find(entry => entry.fieldId === fieldId),
    returnPolicyAllowsNoReason: () => true,
  })
  const page = new Page()
  page.user = { id: 'buyer', identity: 'buyer', identityRevision: 0, token: 'buyer-token' }
  const entries = [draft.entries[0], { fieldId: 'material', label: '材质成分', status: 'known',
    quote: '面料为棉', value: '棉', suggestedAfterSaleKind: 'return-quality' }]
  const sku = { id: 'sku-1', afterSaleKinds: ['return-no-reason', 'return-quality'],
    promiseChecks: entries.map(entry => ({ fieldId: entry.fieldId, result: 'mismatch' })),
    promiseSnapshot: { ...snapshot, templateVersion: 'promises-20261118-2', entries } }
  page.order = { canApplyAfterSale: true, afterSaleKinds: sku.afterSaleKinds, skus: [sku] }
  page.lines = [{ skuId: sku.id, count: 1, remaining: 1, afterSaleKinds: sku.afterSaleKinds }]
  page.mismatch = { skuId: sku.id, fieldId: 'dispatch-window' }
  page.applyMismatch(page.order, page.mismatch)
  assert.equal(page.kind, '')
  assert.equal(page.lines[0].count, 1)
  assert.equal(page.canSubmit(), false)
  assert.equal(page.inputError(), '请先选择售后类型')
  page.selectKind('return-no-reason')
  assert.equal(page.kind, 'return-no-reason')
  assert.equal(page.canSubmit(), true)

  page.mismatch = { skuId: sku.id, fieldId: 'material' }
  page.applyMismatch(page.order, page.mismatch)
  assert.equal(page.kind, 'return-quality')
  assert.equal(page.canSubmit(), true)
  page.lines[0].afterSaleKinds = ['return-no-reason']
  page.applyMismatch(page.order, page.mismatch)
  assert.equal(page.kind, '')
  page.selectKind('return-quality')
  assert.equal(page.kind, '')
  assert.equal(page.canSubmit(), false)

  page.lines[0].afterSaleKinds = sku.afterSaleKinds
  delete entries[1].suggestedAfterSaleKind
  legacySuggestion = legacyPromiseAfterSaleKind
  sku.promiseSnapshot.templateVersion = 'promises-20261118-1'
  page.applyMismatch(page.order, page.mismatch)
  assert.equal(page.kind, 'return-quality')

  legacySuggestion = legacyPromiseAfterSaleKind
  sku.promiseSnapshot.templateVersion = 'promises-20261118-2'
  entries[1].suggestedAfterSaleKind = 'return-quality'
  loadedOrder = { id: 'order-1', canApplyAfterSale: true, afterSaleKinds: sku.afterSaleKinds,
    skus: [{ ...sku, afterSaleRemaining: 1, attrsText: '标准款', realPay: 10, quantity: 1 }] }
  page.orderId = 'order-1'
  page.mismatch = { skuId: sku.id, fieldId: 'material' }
  await page.load()
  assert.equal(page.kind, 'return-quality')
  assert.equal(page.lines[0].count, 1)
})
