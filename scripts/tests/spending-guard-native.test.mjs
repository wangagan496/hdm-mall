import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf, pageMethods, deferred } from './native-harness.mjs'

const root = 'mixed-development-h5/'

function loadSpendingUtils() {
  const timeFormat = execute(sourceOf(root + 'commons/models/src/main/ets/TimeFormat.ets'))
  const afterSaleModels = execute(sourceOf(root + 'commons/models/src/main/ets/AfterSaleModels.ets'))
  const minePres = execute(
    sourceOf(root + 'features/mine/src/main/ets/presentation/utils/SpendingSettingPresentation.ets'),
    { models: { ...timeFormat, ...afterSaleModels } }
  )
  const cartPres = execute(
    sourceOf(root + 'features/cart/src/main/ets/presentation/utils/SpendingPresentation.ets'),
    { models: { ...timeFormat } }
  )
  return { timeFormat, afterSaleModels, minePres, cartPres }
}

test('Stage 5 源码结构、主题资源与无倒计时/无AI边界校验', () => {
  const mineView = sourceOf(root + 'features/mine/src/main/ets/presentation/views/MineView.ets')
  const phoneIndex = sourceOf(root + 'products/phone/src/main/ets/pages/Index.ets')
  const settingView = sourceOf(root + 'features/mine/src/main/ets/presentation/views/SpendingSettingView.ets')
  const wishlistView = sourceOf(root + 'features/mine/src/main/ets/presentation/views/WishlistView.ets')
  const checkView = sourceOf(root + 'features/cart/src/main/ets/presentation/views/CheckView.ets')
  const orderDetailView = sourceOf(root + 'features/cart/src/main/ets/presentation/views/OrderDetailView.ets')

  assert.match(mineView, /mine-spending-setting-entry/)
  assert.match(mineView, /mine-wishlist-entry/)
  assert.match(phoneIndex, /name === 'SpendingSettingView'/)
  assert.match(phoneIndex, /name === 'WishlistView'/)

  for (const src of [settingView, wishlistView]) {
    assert.match(src, /\$r\('\[ui_components\]\.color\.white'\)/)
    assert.match(src, /\$r\('\[ui_components\]\.color\.red'\)/)
    assert.match(src, /\$r\('\[ui_components\]\.color\.on_primary'\)/)
    // 不允许倒计时定时器与 AI 建议文本
    assert.doesNotMatch(src, /setInterval|倒计时|AI建议|人工智能/)
  }

  assert.match(checkView, /checkout-spending-pause/)
  assert.match(checkView, /checkout-wishlist-notice/)
  assert.match(checkView, /formatCooldownUntilText/)
  assert.match(orderDetailView, /order-spending-summary/)
  assert.match(orderDetailView, /spendingOrderSummaryText/)
})

test('SpendingSettingView 保存乐观锁、自然月勾选拦截与 409 版本冲突重载', async () => {
  const { timeFormat, afterSaleModels, minePres } = loadSpendingUtils()
  let version = 1
  const saveCalls = []
  let nextError = null

  const Page = pageMethods(
    root + 'features/mine/src/main/ets/presentation/views/SpendingSettingView.ets',
    'SpendingSettingView',
    {
      models: { ...timeFormat, ...afterSaleModels },
      '../utils/SpendingSettingPresentation': minePres,
      '../../data/api': {}
    },
    {
      ...timeFormat,
      ...afterSaleModels,
      ...minePres,
      util: { generateRandomUUID: () => 'spend-req-1' },
      getSpendingRulesAPI: async () => ({
        current: {
          id: 'rule-' + version, version, monthlyBudgetCents: 30000, perOrderLimitCents: 10000,
          cooldownThresholdCents: 5000, cooldownHours: 24, enabled: true,
          monthDisclosure: minePres.DEFAULT_MONTH_DISCLOSURE, createdAt: 1700000000000
        },
        history: []
      }),
      getSpendingSummaryAPI: async () => ({
        monthKey: '2026-11', ruleVersion: version, enabled: true,
        monthlyBudgetCents: 30000, perOrderLimitCents: 10000, cooldownThresholdCents: 5000, cooldownHours: 24,
        spentCents: 6000, reservedCents: 0, remainingBudgetCents: 24000, waitingWishlistCount: 1,
        monthDisclosure: minePres.DEFAULT_MONTH_DISCLOSURE
      }),
      saveSpendingRuleAPI: async (input, token) => {
        saveCalls.push({ input, token })
        if (nextError) {
          const err = nextError
          nextError = null
          throw err
        }
        version += 1
        return {
          id: 'rule-' + version, version, ...input,
          monthDisclosure: minePres.DEFAULT_MONTH_DISCLOSURE, createdAt: 1700000001000
        }
      }
    }
  )

  const page = new Page()
  page.active = true
  page.user = { id: 'buyer-1', token: 'tok-1', identity: 'buyer' }
  await page.load()
  assert.equal(page.currentRuleVersion, 1)

  // 未勾选自然月说明禁止提交
  page.disclosureAccepted = false
  await page.save()
  assert.match(page.message, /勾选/)
  assert.equal(saveCalls.length, 0)

  // 409 版本冲突触发自动刷新最新版本号
  page.disclosureAccepted = true
  version = 2
  const err409 = new Error('conflict')
  err409.httpStatus = 409
  err409.response = { status: 409, data: { reason: 'SPENDING_RULE_VERSION_CHANGED' } }
  nextError = err409
  await page.save()
  assert.equal(saveCalls.length, 1)
  assert.equal(page.currentRuleVersion, 2)
  assert.match(page.message, /版本已更新/)

  // 切号后旧负载不写新会话
  const oldQuery = page.query
  page.accountChanged()
  assert.notEqual(page.query, oldQuery)
  assert.equal(page.current(oldQuery, 'tok-1', 'buyer-1'), false)
})

test('WishlistView 调价 409 刷新、取消及 CheckView 暂停与待买分支行为隔离', async () => {
  const { timeFormat, afterSaleModels, minePres, cartPres } = loadSpendingUtils()
  let quotedCents = 60000
  const gate = deferred()
  const replaced = []
  let cancelCalled = false

  const WishPage = pageMethods(
    root + 'features/mine/src/main/ets/presentation/views/WishlistView.ets',
    'WishlistView',
    {
      models: { ...timeFormat, ...afterSaleModels },
      '../utils/SpendingSettingPresentation': minePres,
      '../../data/api': {},
      constants: { GlobalVariable: {}, PAGE_PATH: { PAY_PAGE: 'PayView' } }
    },
    {
      ...timeFormat,
      ...afterSaleModels,
      ...minePres,
      returnPolicyLabel: (g) => g?.returnPolicyReason || '退货限制',
      PAGE_PATH: { PAY_PAGE: 'PayView' },
      util: { generateRandomUUID: () => 'wish-confirm-1' },
      getWishlistAPI: async () => [{
        id: 'w-1', requestKey: 'rk-1', status: 'waiting',
        goods: [{ skuId: 's-1', productId: 'p-1', name: '箱包', spec: '大号', picture: '/a.jpg', unitPriceCents: quotedCents, count: 1 }],
        addressId: 'addr-1', expectedAmountCents: 60000, quotedTotalCents: quotedCents,
        currentQuotedTotalCents: quotedCents, priceChanged: false, promotionRevision: 1,
        ruleVersion: 1, cooldownUntil: 1700000000000, readyToConfirm: true, createdAt: 1699900000000
      }],
      cancelWishlistAPI: async (id) => {
        cancelCalled = true
        return { id, status: 'cancelled' }
      },
      confirmWishlistAPI: async (_id, input) => {
        if (input.expectedReturnPolicyToken === 'stale-fail') {
          const e = new Error('policy changed')
          e.httpStatus = 409
          e.reason = 'RETURN_POLICY_CHANGED'
          e.result = { goods: [{ skuId: 's-1', name: '箱包', returnPolicy: 'confirm-required', returnPolicyReason: 'activated', returnPolicyNote: '' }], returnPolicyToken: 'a'.repeat(64) }
          throw e
        }
        if (input.expectedAmountCents !== quotedCents) {
          const e = new Error('price changed')
          e.httpStatus = 409
          e.response = { status: 409, data: { reason: 'PRICE_CHANGED' } }
          throw e
        }
        return gate.promise
      }
    }
  )

  const wp = new WishPage()
  wp.active = true
  wp.user = { id: 'buyer-1', token: 'tok-1', identity: 'buyer' }
  wp.stackPath = { replacePath: (arg) => replaced.push(arg) }
  await wp.load()
  assert.equal(wp.items.length, 1)

  // 降价为 55000 后按旧价 60000 确认 -> 触发 PRICE_CHANGED 并刷新最新报价
  quotedCents = 55000
  await wp.confirmItem(wp.items[0])
  assert.match(wp.message, /重新核价确认/)
  assert.equal(wp.items[0].quotedTotalCents, 55000)
  assert.equal(replaced.length, 0)

  // 退货政策变更拦截 -> 进入内联重确认状态，勾选并确认新规则后放行下单
  const wishlistSource = sourceOf(root + 'features/mine/src/main/ets/presentation/views/WishlistView.ets')
  assert.match(wishlistSource, /wishlist-policy-panel-/)
  assert.match(wishlistSource, /wishlist-policy-confirm-/)
  assert.match(wishlistSource, /RETURN_POLICY_CHANGED/)

  wp.confirmKeys.clear()
  // 模拟一次政策变化 409 后再勾选新规则确认
  wp.pendingPolicyItemId = wp.items[0].id
  wp.pendingPolicyToken = 'a'.repeat(64)
  wp.pendingPolicyGoods = [{ skuId: 's-1', name: '箱包', returnPolicy: 'confirm-required', returnPolicyReason: 'activated', returnPolicyNote: '' }]
  wp.pendingPolicyConfirmed = false
  await wp.confirmItem(wp.items[0], true)
  assert.match(wp.message, /退货限制/)
  assert.equal(replaced.length, 0)

  wp.pendingPolicyConfirmed = true
  const confirmPromise = wp.confirmItem(wp.items[0], true)
  gate.resolve({ id: 'ord-policy-1', orderId: 'ord-policy-1', wishlistItemId: wp.items[0].id })
  await confirmPromise
  assert.equal(replaced.length, 1)
  assert.equal(replaced[0].param, 'ord-policy-1')
  assert.equal(wp.pendingPolicyItemId, '')

  // 取消操作正常调用
  await wp.cancelItem(wp.items[0])
  assert.equal(cancelCalled, true)

  // CheckView 测试：入待买与硬限暂停分支
  let orderMock = async () => ({ wishlistItemId: 'w-check-1', cooldownUntil: 1700086400000, quotedTotalCents: 12000 })
  const openedCashier = []
  const toasts = []
  const CheckPage = pageMethods(
    root + 'features/cart/src/main/ets/presentation/views/CheckView.ets',
    'CheckView',
    {
      models: { ...timeFormat },
      '../utils/SpendingPresentation': cartPres,
      '../utils/CartPresentation': { normalizeCheckoutAddress: x => x },
      '../utils/QuotePreview': { QuoteMemory: {}, getQuotePreviewAPI: async () => ({}), hasMultipleQuoteItems: () => false, quoteFailureText: () => '', quoteRemovalText: () => '' },
      '../../data/api': {},
      storage: { authCart: { updateCartCount: async () => {} }, checkoutFailure: e => ({ status: e.httpStatus || 0, reason: e.reason || '', result: e.result }), getOrderByRequestAPI: async () => ({}), storeManager: { savePendingOrder: async () => {}, clearPendingOrder: async () => {} } }
    },
    {
      ...timeFormat,
      ...cartPres,
      CheckoutSheet: { None: 0, Address: 2 },
      util: { generateRandomUUID: () => 'check-req-1' },
      GlobalVariable: { DEMO_ORDER_FLOW: false },
      PAGE_PATH: { LOGIN_PAGE: 'LoginView', PAY_PAGE: 'PayView', ORDER_DETAIL_PAGE: 'OrderDetailView' },
      authCart: { updateCartCount: async () => {} },
      storeManager: { savePendingOrder: async () => {}, clearPendingOrder: async () => {} },
      checkoutFailure: e => ({ status: e.httpStatus || 0, reason: e.reason || '', result: e.result }),
      createOrderAPI: (...args) => orderMock(...args)
    }
  )

  const cp = new CheckPage()
  cp.pageActive = true
  cp.pageGeneration = 1
  cp.checkoutToken = 'tok-1'
  cp.user = { id: 'buyer-1', token: 'tok-1', identity: 'buyer' }
  cp.summary = { discountPrice: 0, goodsCount: 1, postFee: 0, totalPayPrice: 120, totalPrice: 120 }
  cp.goodsList = [{ skuId: 's-1', count: 1 }]
  cp.addressId = 'addr-1'
  cp.promotion = { rule: { revision: 1, enabled: false, thresholdCents: 0, discountCents: 0 }, discountCents: 0, amountCents: 12000, remainingCents: 0 }
  cp.exactQuoteMatchesGoods = () => false
  cp.canSubmitOrder = () => true
  cp.isCurrentCheckout = () => true
  cp.openCashier = (id) => openedCashier.push(id)
  cp.safeToast = (m) => toasts.push(m)
  cp.returnPolicy = { confirmed: false, token: '', highlighted: false }

  await cp.createOrderAndOpenCashier()
  assert.equal(openedCashier.length, 0)
  assert.equal(cp.wishlistNotice.wishlistItemId, 'w-check-1')

  orderMock = async () => {
    const err = new Error('paused')
    err.httpStatus = 409
    err.reason = 'SPENDING_PAUSED'
    err.result = { limitType: 'per_order', amountCents: 12000, limitCents: 5000, ruleVersion: 1, monthKey: '2026-11', spentCents: 0, reservedCents: 0, remainingBudgetCents: null }
    throw err
  }
  await cp.createOrderAndOpenCashier()
  assert.equal(cp.wishlistNotice, null)
  assert.equal(cp.spendingPause.limitType, 'per_order')
  assert.equal(cp.spendingPause.limitCents, 5000)
})
