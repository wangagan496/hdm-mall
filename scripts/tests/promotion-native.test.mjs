import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf, pageMethods, deferred } from './native-harness.mjs'

test('买家售后入口明确使用主题红，不使用系统蓝', () => {
  const page = sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderDetailView.ets')
  const button = page.slice(page.indexOf("Button('申请售后')"), page.indexOf("if(this.order.afterSaleNotice)"))
  assert.match(button, /backgroundColor\(\$r\('\[ui_components\]\.color\.red'\)\)/)
  assert.match(button, /fontColor\(Color.White\)/)
})

test('商家售后卡片的所有操作明确设置主题颜色', () => {
  const page = sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/views/AfterSaleManageView.ets')
  const card = page.slice(page.indexOf('private Card('), page.indexOf('  build()'))
  const buttons = card.split('Button(').slice(1)
  assert.equal(buttons.length, 5)
  for (const button of buttons) {
    assert.match(button, /backgroundColor\(\$r\('\[ui_components\]\.color\.(red|white)'\)\)/)
    assert.match(button, /fontColor\(/)
  }
})

test('部分退款按原分摊累计取差，零元不凭空退1分', () => {
  const models = execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/AfterSaleModels.ets'))
  const line = { skuId: 's', priceCents: 3300, count: 1, boughtCount: 3, discountShareCents: 1000 }
  assert.deepEqual([3, 2, 1].map(remaining => models.afterSaleAmount([{ ...line, remaining }])), [2967, 2967, 2966])
  assert.equal(models.afterSaleAmount([{ priceCents: 1, count: 1, remaining: 1, boughtCount: 2, discountShareCents: 1 }]), 0)
})

test('运费金额拒绝多位小数和越界，商家下调须原因', () => {
  const model = execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/AfterSaleModels.ets'))
  for (const text of ['0', '-1', '100.01', '1.001', '', '1e1']) assert.ok(model.returnShippingError(text, 1))
  for (const text of ['0.01', '100', '10.50']) assert.equal(model.returnShippingError(text, 1), '')
  assert.ok(model.returnShippingError('10', 0))
  assert.equal(model.shippingAdjustmentError('10', 1000, ''), '')
  assert.ok(model.shippingAdjustmentError('5', 1000, '太短'))
  assert.ok(model.shippingAdjustmentError('10.01', 1000, '金额超过实际运费'))
  assert.equal(model.shippingAdjustmentError('0', 1000, '买家提供的是免运费凭据'), '')
})

test('结算缺省报价清除旧规则，未达标提示能回首页', () => {
  const navigation = []
  const Page = pageMethods('mixed-development-h5/features/cart/src/main/ets/presentation/views/CheckView.ets', 'CheckView', {}, {
    CheckoutSheet: { None: 0 }, GlobalVariable: { DEMO_ORDER_FLOW: false }, util: { generateRandomUUID: () => 'key' },
    AppStorage: { setOrCreate: (...args) => navigation.push(args) }
  })
  const page = new Page()
  page.stackPath = { clear: () => navigation.push('clear') }
  page.promotion = { rule: { thresholdCents: 9900, discountCents: 1000, revision: 1, enabled: true }, remainingCents: 3300, discountCents: 0, amountCents: 6600 }
  assert.equal(page.promotionText(), '再买 ¥33.00 可减 ¥10.00，回首页继续选购')
  page.continueShopping()
  assert.deepEqual(navigation, [['currentTabIndex', 0], 'clear'])
  page.clearPromotion()
  assert.equal(page.promotion.rule.enabled, false)
  assert.equal(page.buildOrderRequest().expectedPromotionRevision, undefined)
})

test('满减页展示达标优惠与未达门槛提示，并带规则版本下单', () => {
  const models = sourceOf('mixed-development-h5/commons/models/src/main/ets/BusinessModels.ets')
  const checkout = sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/views/CheckView.ets')
  assert.match(models, /interface PromotionQuote/)
  assert.match(checkout, /promotion\.remainingCents/)
  assert.match(checkout, /expectedPromotionRevision/)
  assert.match(checkout, /再买/)
})

test('零元售后显示已完成和无需退款说明', () => {
  const models = execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/AfterSaleModels.ets'))
  assert.equal(models.afterSaleStatus({ state: 'completed', amountCents: 0 }), '已完成')
  const card = sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/components/AfterSaleCard.ets')
  assert.match(card, /amountMessage/)
  const apply = sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/views/AfterSaleApplyView.ets')
  assert.match(apply, /该商品实付 ¥0\.00（满减已抵扣），退货后无需退款/)
})

test('商家满减设置可进入，且提醒低价商品可能被抵扣为零', () => {
  const mine = sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets')
  const phone = sourceOf('mixed-development-h5/products/phone/src/main/ets/pages/Index.ets')
  const page = sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/views/PromotionSettingView.ets')
  assert.match(mine, /PromotionSettingView/)
  assert.match(phone, /PromotionSettingView/)
  assert.match(page, /优惠金额较大时，低价商品可能被抵扣为 0 元/)
})

test('满减设置校验、未知结果同号重试、账号切换隔离迟到响应', async () => {
  const disk = new Map(), calls = [], gate = deferred()
  const rule = { thresholdCents: 9900, discountCents: 1000, enabled: true, revision: 1 }
  let fail = true
  const model = execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/AfterSaleModels.ets'))
  const Page = pageMethods('mixed-development-h5/features/mine/src/main/ets/presentation/views/PromotionSettingView.ets', 'PromotionSettingView', {}, {
    ...model, util: { generateRandomUUID: () => 'fixed-key' },
    storeManager: { getStore: () => ({ getSync: (key, fallback) => disk.get(key) || fallback, putSync: (key, value) => disk.set(key, value), flush: async () => {} }) },
    RequestAxios: { getForSession: () => gate.promise, putForSession: async (url, body) => { calls.push(structuredClone(body)); if (fail) throw Error('unknown'); return { ...rule, revision: 2 } } }
  })
  const page = new Page()
  page.active = true; page.user = { id: 'merchant', token: 'token', role: 'merchant' }; page.rule = rule
  page.threshold = '99'; page.discount = '99'
  await page.save(); assert.equal(calls.length, 0); assert.match(page.message, /小于/)
  page.discount = '10'
  await page.save(); assert.ok(page.pending); assert.equal(calls.length, 1)
  fail = false; await page.save(); assert.deepEqual(calls[0], calls[1]); assert.equal(page.pending, null)
  assert.ok([...disk.values()].every(value => !value.includes('token')))
  const loading = page.load()
  page.user = { id: 'other', token: 'other', role: 'merchant' }; page.query++; page.threshold = '5'
  gate.resolve(rule); await loading
  assert.equal(page.threshold, '5')
})

test('PRICE_CHANGED更新商品总价优惠实付和版本，等待用户再次确认', async () => {
  let writes = 0
  const rule = { thresholdCents: 9900, discountCents: 2000, enabled: true, revision: 2 }
  const Page = pageMethods('mixed-development-h5/features/cart/src/main/ets/presentation/views/CheckView.ets', 'CheckView', {}, {
    CheckoutSheet: { None: 0 }, GlobalVariable: { DEMO_ORDER_FLOW: false }, util: { generateRandomUUID: () => 'new-key' },
    storeManager: { savePendingOrder: async () => {}, clearPendingOrder: async () => {} }, checkoutFailure: error => error,
    createOrderAPI: async () => { writes++; throw { status: 409, reason: 'PRICE_CHANGED', result: { totalAmountCents: 7900, goods: [], promotion: { rule, discountCents: 2000, amountCents: 7900, remainingCents: 0 } } } }
  })
  const page = new Page()
  page.user = { id: 'buyer', token: 't' }; page.checkoutToken = 't'; page.pageActive = true
  page.canSubmitOrder = () => true; page.safeToast = () => {}; page.summary = { goodsCount: 3, postFee: 0, totalPrice: 99, totalPayPrice: 89, discountPrice: 10 }
  await page.createOrderAndOpenCashier()
  assert.equal(writes, 1); assert.equal(page.summary.totalPrice, 99); assert.equal(page.summary.discountPrice, 20); assert.equal(page.summary.totalPayPrice, 79)
  assert.equal(page.buildOrderRequest().expectedPromotionRevision, 2)
})

test('商家验收默认全额运费，下调缺原因不提交，填写后含运费单独金额', async () => {
  const calls = []
  const Page = pageMethods('mixed-development-h5/features/mine/src/main/ets/presentation/views/AfterSaleManageView.ets', 'AfterSaleManageView', {}, {
    afterSaleActions: { pending: () => null, start: async (...args) => calls.push(args) }
  })
  const page = new Page()
  page.active = true; page.user = { id: 'merchant', token: 't', role: 'merchant' }; page.token = 't'; page.accountId = 'merchant'; page.load = async () => {}
  page.open({ id: 'sale', orderId: 'order', amountCents: 0, shippingAmountCents: 1000, items: [] }, 'inspect')
  assert.equal(page.shippingCompensation, '10.00'); assert.equal(page.actionLabel(), '验收并退款 ¥10.00')
  page.shippingCompensation = '5'; await page.submit(); assert.equal(calls.length, 0); assert.match(page.message, /原因/)
  page.shippingReason = '运单实际支付五元'; await page.submit(); assert.equal(calls.length, 1)
  assert.equal(calls[0][2].shippingCompensationCents, 500); assert.equal(calls[0][2].shippingAdjustmentReason, '运单实际支付五元')
})

test('审计满减和运费补偿显示白话前后金额', () => {
  const audit = execute(sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/utils/AuditPresentation.ets'))
  assert.equal(audit.auditActionLabel('promotion.edit'), '修改满减规则')
  assert.equal(audit.auditActionLabel('aftersale.shipping_comp'), '补偿退货运费')
  assert.equal(audit.auditChange({ action: 'aftersale.shipping_comp', summary: { before: 1000, after: 500, reason: '运单实付五元' } }), '实付运费 ¥10.00，补偿 ¥5.00，原因：运单实付五元')
  assert.equal(audit.auditChange({ action: 'promotion.edit', summary: { before: JSON.stringify({ enabled: true, thresholdCents: 9900, discountCents: 1000 }), after: JSON.stringify({ enabled: false, thresholdCents: 9900, discountCents: 1000 }) } }), '满 ¥99.00 减 ¥10.00 → 已停用')
})

test('从系统选图返回刷新订单时保留售后表单，不卸载整页', () => {
  const source = sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderDetailView.ets')
  const render = source.slice(source.indexOf('  build()'))
  assert.ok(render.includes('if (this.loading && !this.order)'), '后台刷新不能用加载动画替换已有订单和寄回表单')
  assert.ok(render.includes('else if (!this.order)'), '后台刷新失败也不能销毁已有寄回表单')
})
