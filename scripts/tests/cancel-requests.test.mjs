import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, pageMethods, sourceOf, deferred, tick } from './native-harness.mjs'
const cart = 'mixed-development-h5/features/cart/src/main/ets/'
const storage = 'mixed-development-h5/commons/storage/src/main/ets/'
const states = { ALL_TAB: 0, AWAITING_PAYMENT: 1, AWAITING_SHIPMENT: 2, AWAITING_RECEIPT: 3, CANCELLED: 6 }
const paid = (message = '取消申请提交后，商家同意即不再发货，¥12.30将原路退回付款账户。确定申请取消吗？') => ({ id: 'order', orderState: 2, serverManaged: true, canRequestCancel: true, canCancel: false, skus: [], totalNum: 1, createTime: '2026-11-06', payMoney: 12.3, cancelRequest: null, cancelConfirmation: { message }, serverNow: 1000 })
function buyerFixture(demo = false) {
  const dialogs = [], writes = [], messages = []
  const legacy = { pendingIds: () => [], confirm: async () => { writes.push('old') } }
  const Page = pageMethods(cart + 'presentation/views/OrderView.ets', 'OrderView', {}, {
    OrderState: states, GlobalVariable: { DEMO_ORDER_FLOW: demo },
    cancelActions: { pending: () => [], confirm: async intent => { writes.push(intent) } },
    orderCancellation: legacy,
  })
  const page = new Page()
  page.user = { id: 'buyer', token: 'token' }; page.sessionToken = 'token'; page.loadedToken = 'token'
  page.loadedState = 0; page.orders = [paid()]
  page.safeToast = text => messages.push(text)
  page.getUIContext = () => ({ showAlertDialog: dialog => dialogs.push(dialog) })
  page.reloadOrders = async () => {}
  return { page, dialogs, writes, messages, legacy }
}
function renderBuilder(path, name, page, order) {
  const source = sourceOf(path)
  const start = source.indexOf('  private ' + name + '(')
  let end = source.indexOf('  @', start)
  if (end < 0) end = source.indexOf('  build()', start)
  let body = source.slice(start, end).replace('private ' + name, 'function render')
  body = body.replace(/^(\s*)(Row|Column)\((.*)\) \{/gm, '$1$2($3); {')
    .replace(/}\n(\s*)\./g, '}\n$1UI.')
  const buttons = [], texts = [], controls = []
  const chain = new Proxy({}, { get: () => () => chain })
  const globals = { OrderState: states, GlobalVariable: { DEMO_ORDER_FLOW: false }, UI: chain,
    Row: () => chain, Column: () => chain, Blank: () => {}, Text: value => { texts.push(value); return chain },
    Button: label => {
      buttons.push(label); const entry = { label, enabled: true }; controls.push(entry)
      const button = new Proxy({}, { get: (target, prop) => value => { if (prop === 'enabled') entry.enabled = value; if (prop === 'onClick') entry.click = value; return button } })
      return button
    }, $r: value => value,
    Color: { White: 'white' }, HorizontalAlign: { Start: 'start' },
    ForEach: (items, build) => items.forEach(build), TextArea: () => chain,
    Date: class extends Date { static now() { return 9999999999999 } },
    canOpenPayment: () => false, getPaymentDisplayLabel: () => '', getRefundDisplayLine: () => '' }
  execute('export ' + body.trim(), {}, globals).render.call(page, order)
  return { buttons, texts, controls }
}
function managerFixture(saved = new Map()) {
  let user = { id: 'buyer', token: 'token' }, counter = 0
  const calls = [], events = []
  const store = { getSync: (key, fallback) => saved.get(key) ?? fallback,
    putSync: (key, value) => { events.push('put'); saved.set(key, value) }, flush: async () => { events.push('flush') } }
  const api = { send: async () => ({ id: 'receipt' }), query: async () => ({ id: 'receipt' }) }
  const wire = execute(sourceOf(storage + 'CancelActionAPI.ets'), { network: { RequestAxios: {
    postWithSession: async (...args) => { events.push('send'); calls.push(['post', ...args]); return api.send(...args) },
    getForSession: async (...args) => { calls.push(['get', ...args]); return api.query(...args) }
  } } })
  const make = () => new (execute(sourceOf(storage + 'CancelActions.ets'), {
    '@kit.ArkTS': { util: { generateRandomUUID: () => '00000000-0000-4000-8000-' + String(++counter).padStart(12, '0') } },
    './Auth': { auth: { getUserInfo: () => user } }, './StoreManager': { storeManager: { getStore: () => store } }, './CancelActionAPI': wire,
  }).CancelActions)()
  return { manager: make(), make, saved, store, api, calls, events, setUser: value => { user = value } }
}
const intent = (action = 'request') => ({ orderId: 'order', cancelRequestId: action === 'request' ? '' : 'request-1', action, reason: action === 'reject-and-ship' ? '已打包' : '' })
const failure = status => Object.assign(new Error('服务端原文'), { httpStatus: status })
test('B-78 四动作持久化先于发送，账号空间独立，写盘失败绝不发送或自动恢复误发', async () => {
  for (const action of ['request', 'withdraw', 'approve', 'reject-and-ship']) {
    const fixture = managerFixture(); const gate = deferred(); fixture.store.flush = () => gate.promise
    const task = fixture.manager.confirm(intent(action), 'token'); await tick()
    assert.equal(fixture.calls.length, 0)
    assert.equal(JSON.parse(fixture.saved.get('order-cancel-actions:buyer'))[0].action, action)
    gate.resolve(); await task
    assert.equal(fixture.calls[0][1], action === 'request' ? '/member/order/order/cancel-requests' : action === 'withdraw' ? '/member/order/order/cancel-requests/request-1/withdraw' : '/merchant/orders/order/cancel-requests/request-1/resolve')
    assert.equal(fixture.calls[0][3], 'token'); assert.equal(fixture.manager.pending().length, 0)
    if (action === 'approve') assert.equal('reason' in fixture.calls[0][2], false)
  }
  const fixture = managerFixture(); fixture.store.flush = async () => { throw Error('disk') }
  await assert.rejects(fixture.manager.confirm(intent(), 'token'), /保存失败/)
  await fixture.make().recover('order', 'token'); assert.equal(fixture.calls.length, 0)
})
test('B-78 断网408 429 5xx保留原号，回执查到只清记录不重发', async () => {
  for (const status of [0, 408, 429, 500, 503]) {
    const fixture = managerFixture(); fixture.api.send = async () => { throw failure(status) }
    await assert.rejects(fixture.manager.confirm(intent(), 'token'), /操作结果待确认，请重新查询/)
    const record = fixture.manager.pending()[0]
    await assert.rejects(fixture.manager.confirm(intent(), 'token'), /待确认/)
    await fixture.manager.recover('order', 'token')
    assert.equal(fixture.calls.length, 2); assert.equal(fixture.calls[1][1], '/order-cancel-actions/by-request/' + record.requestKey)
    assert.equal(fixture.manager.pending().length, 0)
  }
})
test('B-78 杀进程同账号新token恢复，404按原号原参重发；其他账号不查询不发送', async () => {
  const fixture = managerFixture(); fixture.api.send = async () => { throw failure(503) }
  await assert.rejects(fixture.manager.confirm(intent('reject-and-ship'), 'token'))
  const original = structuredClone(fixture.calls[0][2])
  fixture.setUser({ id: 'other', token: 'other-token' }); const restarted = fixture.make()
  assert.equal(restarted.pending().length, 0); await restarted.recover('order', 'other-token'); assert.equal(fixture.calls.length, 1)
  fixture.setUser({ id: 'buyer', token: 'new-token' }); fixture.api.query = async () => { throw failure(404) }; fixture.api.send = async () => ({})
  await restarted.recover('order', 'new-token')
  assert.deepEqual(structuredClone(fixture.calls[2][2]), original); assert.equal(fixture.calls[2][3], 'new-token')
  assert.equal(restarted.pending().length, 0)
})
test('B-78 永久4xx清记录提示原文，查询5xx不重发，迟到跨账号响应不清原账号记录', async () => {
  for (const status of [400, 401, 403, 404, 409]) {
    const fixture = managerFixture(); fixture.api.send = async () => { throw failure(status) }
    await assert.rejects(fixture.manager.confirm(intent(), 'token'), /服务端原文/); assert.equal(fixture.manager.pending().length, 0)
  }
  const fixture = managerFixture(); fixture.api.send = async () => { throw failure(503) }
  await assert.rejects(fixture.manager.confirm(intent(), 'token'))
  fixture.api.query = async () => { throw failure(500) }; await assert.rejects(fixture.manager.recover('order', 'token'), /待确认/)
  assert.equal(fixture.calls.filter(call => call[0] === 'post').length, 1)
  const gate = deferred(); fixture.api.query = () => gate.promise
  const task = fixture.manager.recover('order', 'token'); fixture.setUser({ id: 'other', token: 'other-token' }); gate.resolve({})
  await assert.rejects(task, /登录状态已变化/)
  assert.equal(JSON.parse(fixture.saved.get('order-cancel-actions:buyer')).length, 1)
})
const { cancelActionFailure } = execute(sourceOf(storage + 'CancelActions.ets'))
const familyPath = 'mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets'
function merchantFixture() {
  const writes = [], queries = [], messages = [], dialogs = []
  const order = { ...paid(), canRequestCancel: false, canResolveCancel: true, canShip: false, payerAccount: 'friend', paymentMode: 'family', cancelRequest: { id: 'request-1', state: 'pending', deadlineAt: 99999 } }
  const api = { mutate: async () => {}, ship: async () => {}, merchant: async page => ({ items: [order], page, pages: 1 }) }
  const actions = { pending: () => [], confirm: async value => { writes.push(value); await api.mutate(value) }, recover: async () => {} }
  const Page = pageMethods(familyPath, 'FamilyView', {}, { OrderState: states, cancelActions: actions, cancelActionFailure,
    getFamilyRelationsPageAPI: async () => ({ items: [], page: 1, pages: 0 }),
    getFamilyOrdersPageAPI: async () => ({ items: [], page: 1, pages: 0 }),
    getMerchantOrdersPageAPI: async page => { queries.push(page); return api.merchant(page) },
    shipOrderAPI: async (...args) => { writes.push(args); await api.ship(...args) },
  })
  const page = new Page(); page.user = { id: 'merchant', token: 'token', role: 'merchant' }
  page.sessionToken = 'token'; page.sessionRole = 'merchant'; page.loadedToken = 'token'; page.ordersToShip = [order]
  page.getUIContext = () => ({ showAlertDialog: dialog => dialogs.push(dialog) })
  page.safeToast = text => messages.push(text)
  return { page, order, api, actions, writes, queries, messages, dialogs }
}
function detailFixture(demo = false, coordinator) {
  const dialogs = [], writes = [], messages = [], queries = []
  const api = { read: async () => paid(), submit: async () => {}, pending: [] }
  const actions = { pending: () => api.pending, confirm: async value => { writes.push(value); await api.submit(value) }, recover: async id => { writes.push({ recover: id }); await api.submit() } }
  const legacy = { pendingIds: () => [], confirm: async () => {} }
  const Page = pageMethods(cart + 'presentation/views/OrderDetailView.ets', 'OrderDetailView', {}, {
    OrderState: states, GlobalVariable: { DEMO_ORDER_FLOW: demo }, cancelActions: coordinator || actions, orderCancellation: legacy,
    readPhoneClockMillis: () => 1234,
    getOrderDetailAPI: async (...args) => { queries.push(args); return api.read(...args) },
  })
  const page = new Page(); page.user = { id: 'buyer', token: 'token' }; page.orderId = 'order'; page.detailOrderId = 'order'; page.detailToken = 'token'; page.order = paid(); page.loading = false; page.displayedOrderState = 2
  page.safeToast = text => messages.push(text)
  page.getUIContext = () => ({ showAlertDialog: dialog => dialogs.push(dialog) })
  return { page, dialogs, writes, messages, queries, api, actions, legacy }
}
test('B-78 真实详情串联持久化网络：结果不明禁用，重进查404原号重发后刷新', async () => {
  const network = managerFixture(); network.api.send = async () => { throw failure(503) }
  const fixture = detailFixture(false, network.manager)
  fixture.page.requestCancelOrder(); fixture.dialogs[0].secondaryButton.action(); await tick(); await tick()
  assert.equal(fixture.page.cancelActionPending, true); assert.ok(fixture.messages.includes('操作结果待确认，请重新查询'))
  const controls = renderBuilder(cart + 'presentation/views/OrderDetailView.ets', 'DetailActions', fixture.page).controls
  assert.ok(controls.every(control => !control.enabled))
  const original = structuredClone(network.calls[0][2])
  network.api.query = async () => { throw failure(404) }; network.api.send = async () => ({ appliedState: 'withdrawn' })
  const restarted = detailFixture(false, network.make())
  restarted.api.read = async () => ({ ...paid(), cancelRequest: { id: 'current', state: 'pending' }, canRequestCancel: false, canWithdrawCancel: true })
  await restarted.page.loadOrderDetail(); await tick(); await tick(); await tick()
  assert.deepEqual(structuredClone(network.calls[2][2]), original)
  assert.equal(restarted.page.cancelActionPending, false); assert.equal(restarted.page.order.cancelRequest.id, 'current')
  assert.equal(restarted.queries.length, 2)
})
test('B-78 列表进入时恢复本账号已保存动作，离页响应不刷新新页面', async () => {
  const fixture = buyerFixture(), gate = deferred(); let refresh = 0
  fixture.page.pendingCancelActions = ['order']; fixture.page.reloadOrders = async () => { refresh++ }
  fixture.page.runCancelAction = async (...args) => { fixture.writes.push(args); await gate.promise }
  const task = fixture.page.recoverAllCancellations(); await tick(); fixture.page.hideOrders(); gate.resolve(); await task
  assert.deepEqual(fixture.writes, [['order', 'request', true]]); assert.equal(refresh, 0)
})
test('B-78 原号重发永久4xx及回执查询永久4xx都清记录并显示axios msg', async () => {
  for (const queryStatus of [403, 404]) {
    const fixture = managerFixture(); fixture.api.send = async () => { throw failure(503) }
    await assert.rejects(fixture.manager.confirm(intent(), 'token'))
    fixture.api.query = async () => { throw Object.assign(new Error('transport'), { response: { status: queryStatus, data: { msg: '回执拒绝' } } }) }
    fixture.api.send = async () => { throw Object.assign(new Error('transport'), { response: { status: 409, data: { msg: '原号已被拒绝' } } }) }
    await assert.rejects(fixture.manager.recover('order', 'token'), queryStatus === 403 ? /回执拒绝/ : /原号已被拒绝/)
    assert.equal(fixture.manager.pending().length, 0)
  }
})
test('B-78 多订单并发写盘不丢记录、四动作连点不创建第二号', async () => {
  const fixture = managerFixture(); fixture.api.send = async () => { throw failure(503) }
  const first = fixture.manager.confirm(intent(), 'token')
  const duplicate = fixture.manager.confirm(intent('withdraw'), 'token')
  const other = fixture.manager.confirm({ ...intent(), orderId: 'other-order' }, 'token')
  await Promise.all([assert.rejects(first), assert.rejects(duplicate), assert.rejects(other)])
  assert.equal(fixture.calls.length, 2); assert.equal(fixture.manager.pending().length, 2)
  assert.equal(new Set(fixture.manager.pending().map(item => item.requestKey)).size, 2)
})
test('B-81 支付先成功令旧取消409，补查一次携带待发货状态且不重发取消', async () => {
  let state = 1, writes = 0, queries = 0
  const saved = new Map()
  const manager = execute(sourceOf(cart + 'presentation/utils/OrderCancellation.ets'), {
    storage: { auth: { getUserInfo: () => ({ id: 'buyer', token: 'token' }) }, storeManager: { getStore: () => ({ getSync: (key, fallback) => saved.get(key) ?? fallback, putSync: (key, value) => saved.set(key, value), flush: async () => {} }) } },
    network: { RequestAxios: { getForSession: async () => { queries++; return { ...paid(), orderState: state } } } },
    '../../data/api/cart': { cancelOrderWithFallback: async () => { writes++; state = 2; throw failure(409) } },
    './OrderPresentation': { OrderState: states },
  }).orderCancellation
  await assert.rejects(manager.confirm('order'), error => error.orderState === 2)
  assert.equal(writes, 1); assert.equal(queries, 2); assert.equal(manager.pendingIds().length, 0)
})
test('B-78 原生页面新启用条件依赖可观察状态，pending按钮实际禁用', () => {
  const fixture = buyerFixture(); fixture.page.pendingCancelActions = ['order']
  let result = renderBuilder(cart + 'presentation/views/OrderView.ets', 'OrderActions', fixture.page, fixture.page.orders[0])
  assert.ok(result.controls.every(control => !control.enabled))
  const merchant = merchantFixture(); merchant.page.OrderSummary = () => {}; merchant.page.pendingCancelActions = ['order']
  result = renderBuilder(familyPath, 'MerchantOrderCard', merchant.page, merchant.order)
  assert.equal(result.controls[0].enabled, false)
  for (const [path, fields] of [[cart + 'presentation/views/OrderView.ets', ['pageGeneration', 'pendingCancelActions']], [cart + 'presentation/views/OrderDetailView.ets', ['pageGeneration', 'orderId', 'cancelActionPending']], [familyPath, ['pageGeneration', 'pendingCancelActions', 'rejectReason']]]) {
    for (const field of fields) assert.match(sourceOf(path), new RegExp('@State ' + field + ':'))
  }
})
test('B-78 旧详情与商家操作离页/换账号返回不清新操作锁，不弹旧结果', async () => {
  const fixture = detailFixture(), gate = deferred(); fixture.api.submit = () => gate.promise
  const task = fixture.page.runCancelAction('request'); fixture.page.aboutToDisappear()
  fixture.page.pageActive = true; fixture.page.busy = 'new-action'; gate.resolve(); await task
  assert.equal(fixture.page.busy, 'new-action'); assert.equal(fixture.queries.length, 0); assert.equal(fixture.messages.length, 0)
  const merchant = merchantFixture(), wait = deferred(); merchant.api.mutate = () => wait.promise
  merchant.page.openCancelResolution(merchant.order); merchant.page.rejectReason = '已打包'
  const send = merchant.page.rejectCancellation(); merchant.page.user = { id: 'other', token: 'other', role: 'merchant' }
  merchant.page.synchronizeFamilySession(); merchant.page.isSubmitting = true; wait.reject(Error('old-failure')); await send
  assert.equal(merchant.page.isSubmitting, true); assert.equal(merchant.queries.length, 0); assert.equal(merchant.messages.length, 0)
})
test('B-74 撤回和再次申请生成不同UUID并锁定各自申请号', async () => {
  const fixture = managerFixture()
  await fixture.manager.confirm(intent('withdraw'), 'token'); await fixture.manager.confirm(intent(), 'token')
  assert.notEqual(fixture.calls[0][2].requestKey, fixture.calls[1][2].requestKey)
  assert.equal(fixture.calls[0][1], '/member/order/order/cancel-requests/request-1/withdraw')
  assert.equal(fixture.calls[1][1], '/member/order/order/cancel-requests')
})
test('RED9 B-78 401使会话过期也清除被永久拒绝的原操作，不在下次登录重发', async () => {
  const fixture = managerFixture()
  fixture.api.send = async () => { fixture.setUser(undefined); throw failure(401) }
  await assert.rejects(fixture.manager.confirm(intent(), 'token'))
  fixture.setUser({ id: 'buyer', token: 'new-token' })
  assert.equal(fixture.manager.pending().length, 0)
  await fixture.make().recover('order', 'new-token'); assert.equal(fixture.calls.length, 1)
})
test('RED8 B-81 旧取消确认已转待发货时携带当前状态，待付款栏目可切换新入口', async () => {
  const saved = new Map()
  const legacy = execute(sourceOf(cart + 'presentation/utils/OrderCancellation.ets'), {
    storage: { auth: { getUserInfo: () => ({ id: 'buyer', token: 'token' }) }, storeManager: { getStore: () => ({ getSync: (key, fallback) => saved.get(key) ?? fallback, putSync: (key, value) => saved.set(key, value), flush: async () => {} }) } },
    network: { RequestAxios: { getForSession: async () => paid() } },
    './OrderPresentation': { OrderState: states },
  }).orderCancellation
  await assert.rejects(legacy.confirm('order'), error => error.orderState === 2)
  const fixture = buyerFixture(); fixture.page.selectedState = 1; fixture.page.loadedState = 1
  fixture.page.orders = [{ ...paid(), orderState: 1, canCancel: true, canRequestCancel: false, paymentState: 'confirming' }]
  fixture.legacy.confirm = async () => { throw Object.assign(new Error('状态已变化'), { orderState: 2 }) }
  fixture.page.reloadOrders = async () => { fixture.page.orders = fixture.page.selectedState === 2 ? [paid()] : [] }
  fixture.page.requestCancelOrder(fixture.page.orders[0]); fixture.dialogs[0].secondaryButton.action(); await tick()
  assert.equal(fixture.page.selectedState, 2); assert.equal(fixture.page.orders[0].canRequestCancel, true)
  assert.ok(fixture.messages.includes('付款已确认，请重新申请取消')); assert.equal(fixture.writes.length, 0)
})
test('RED7 B-78 未决动作禁用详情冲突操作，但允许重新查询', () => {
  const fixture = detailFixture(); fixture.page.cancelActionPending = true
  fixture.page.order = { ...paid(), orderState: 3, canRequestCancel: false }; fixture.page.displayedOrderState = 3
  const controls = renderBuilder(cart + 'presentation/views/OrderDetailView.ets', 'DetailActions', fixture.page).controls
  assert.equal(controls.find(control => control.label === '确认收货').enabled, false)
})
test('B-62 B-65 B-73 详情本人代付弹窗、确认新动作及亲友无入口', async () => {
  for (const message of [paid().cancelConfirmation.message, '取消申请提交后，商家同意即不再发货，¥12.30将原路退回亲友 friend 的付款账户。确定申请取消吗？']) {
    const fixture = detailFixture(); fixture.page.order = paid(message)
    fixture.page.requestCancelOrder(); assert.equal(fixture.dialogs[0].message, message)
    fixture.dialogs[0].primaryButton.action(); await tick(); assert.equal(fixture.writes.length, 0)
    fixture.page.requestCancelOrder(); fixture.dialogs[1].secondaryButton.action(); await tick()
    assert.equal(fixture.writes[0].action, 'request'); assert.equal(fixture.queries.length, 1)
  }
  const fixture = detailFixture(); fixture.page.order = { ...paid(), canRequestCancel: false, canWithdrawCancel: false, cancelConfirmation: null }
  fixture.page.requestCancelOrder(); await fixture.page.runCancelAction('withdraw')
  assert.equal(fixture.dialogs.length, 0); assert.equal(fixture.writes.length, 0)
})
test('B-74 列表和详情撤回后再次明确确认才申请，无次数限制', async () => {
  const fixture = detailFixture()
  for (let index = 0; index < 3; index++) {
    fixture.page.order = { ...paid(), canRequestCancel: false, canWithdrawCancel: true, cancelRequest: { id: 'request-' + index, state: 'pending' } }
    await fixture.page.runCancelAction('withdraw')
    assert.equal(fixture.writes.at(-1).cancelRequestId, 'request-' + index)
    assert.equal(fixture.page.order.canRequestCancel, true)
    fixture.page.requestCancelOrder(); assert.equal(fixture.writes.length, index * 2 + 1)
    fixture.dialogs.at(-1).secondaryButton.action(); await tick()
    assert.equal(fixture.writes.at(-1).action, 'request')
  }
  const list = buyerFixture(); list.page.orders = [{ ...paid(), canRequestCancel: false, canWithdrawCancel: true, cancelRequest: { id: 'old', state: 'pending' } }]
  list.page.reloadOrders = async () => { list.page.orders = [paid()] }
  await list.page.runCancelAction('order', 'withdraw'); list.page.requestCancelOrder(list.page.orders[0])
  assert.equal(list.writes.length, 1); list.dialogs[0].secondaryButton.action(); await tick()
  assert.equal(list.writes[1].action, 'request')
})
test('B-76 到期服务端只读文案和能力决定操作，不用手机时钟自行取消', () => {
  for (const time of [9998, 9999, 10000]) {
    const fixture = detailFixture(); fixture.page.order = { ...paid(), serverNow: time, canRequestCancel: false,
      canWithdrawCancel: time < 9999, cancelRequest: { id: 'request-1', state: 'pending', deadlineAt: 9999 },
      cancelRequestNotice: time < 9999 ? '商家将在72小时内处理，超时自动同意' : '已到自动处理时间，正在处理' }
    const result = renderBuilder(cart + 'presentation/views/OrderDetailView.ets', 'DetailActions', fixture.page)
    assert.equal(result.buttons.includes('撤回申请'), time < 9999)
    assert.ok(!result.buttons.includes('提醒发货')); assert.equal(fixture.page.order.orderState, 2)
    assert.equal(fixture.writes.length, 0)
  }
})
test('B-62 B-77 商家同意确认包含金额去向，关闭不操作，同意后刷新补末页', async () => {
  const fixture = merchantFixture(); fixture.page.openCancelResolution(fixture.order); fixture.page.closeCancelResolution()
  fixture.page.approveCancellation(); assert.equal(fixture.writes.length, 0); assert.equal(fixture.dialogs.length, 0)
  fixture.page.openCancelResolution(fixture.order); fixture.page.approveCancellation()
  assert.match(fixture.dialogs[0].message, /¥12.30将原路退回亲友 friend 的付款账户/)
  fixture.dialogs[0].primaryButton.action(); assert.equal(fixture.writes.length, 0)
  fixture.page.approveCancellation(); fixture.page.merchantPage = 2
  fixture.api.merchant = async page => ({ items: page === 2 ? [] : [{ id: 'boundary' }], page, pages: 1 })
  fixture.dialogs[1].secondaryButton.action(); await tick(); await tick()
  assert.equal(fixture.writes[0].action, 'approve'); assert.deepEqual(fixture.queries, [2, 1]); assert.equal(fixture.page.merchantPages, 1)
})
test('B-65 B-73 B-75 亲友只读审核拒绝及本人退款，商家按canResolveCancel/canShip显示', () => {
  const fixture = merchantFixture(); fixture.page.OrderSummary = () => {}
  let result = renderBuilder(familyPath, 'FamilyOrderCard', fixture.page, fixture.order)
  assert.ok(!result.buttons.some(label => /取消|撤回|发货/.test(label)))
  result = renderBuilder(familyPath, 'MerchantOrderCard', fixture.page, fixture.order)
  assert.ok(result.buttons.includes('处理取消申请')); assert.ok(!result.buttons.includes('确认发货'))
  result = renderBuilder(familyPath, 'MerchantOrderCard', fixture.page, { ...paid(), canShip: false })
  assert.ok(!result.buttons.includes('确认发货'))
  result = renderBuilder(familyPath, 'MerchantOrderCard', fixture.page, { ...paid(), canShip: true })
  assert.ok(result.buttons.includes('确认发货'))
  for (const notice of ['取消申请审核中；商家将在72小时内处理，超时自动同意', '商家拒绝取消申请：已打包。如有问题请联系客服']) {
    result = renderBuilder(familyPath, 'OrderSummary', fixture.page, { ...fixture.order, cancelRequestNotice: notice, paymentNotice: '本人原路退款原文' })
    assert.ok(result.texts.includes(notice)); assert.ok(result.texts.includes('本人原路退款原文'))
  }
})
test('B-77 五种冲突保留服务端msg并刷新，包括axios错误体', async () => {
  for (const reason of ['CANCEL_REQUEST_BLOCKS_SHIPMENT', 'CANCELLED_ORDER_BLOCKS_SHIPMENT', 'CANCEL_REQUEST_EXPIRED', 'CANCEL_REQUEST_WITHDRAWN', 'CANCEL_REQUEST_RESOLVED']) {
    const fixture = merchantFixture(); fixture.page.ordersToShip = [{ ...paid(), canShip: true }]
    fixture.api.ship = async () => { throw Object.assign(new Error('Request failed'), { response: { status: 409, data: { reason, msg: '服务器-' + reason } } }) }
    fixture.page.shipOrder(fixture.page.ordersToShip[0]); await tick(); await tick()
    assert.ok(fixture.messages.includes('服务器-' + reason)); assert.equal(fixture.queries.length, 1)
  }
})
test('B-78 商家处理失效申请提示原文并刷新，不处理新一轮申请', async () => {
  const fixture = merchantFixture(); fixture.page.openCancelResolution(fixture.order); fixture.page.approveCancellation()
  fixture.page.ordersToShip = [{ ...fixture.order, cancelRequest: { id: 'new', state: 'pending' } }]
  fixture.dialogs[0].secondaryButton.action(); await tick(); assert.equal(fixture.writes.length, 0)
  fixture.page.openCancelResolution(fixture.page.ordersToShip[0]); fixture.page.rejectReason = '已打包'
  fixture.api.mutate = async () => { throw new Error('取消申请已撤回，请刷新订单') }
  await fixture.page.rejectCancellation(); assert.ok(fixture.messages.includes('取消申请已撤回，请刷新订单')); assert.equal(fixture.queries.length, 1)
})
test('B-78 列表详情旧弹窗跨刷新、换账号、新申请均不提交', async () => {
  for (const change of ['query', 'account', 'request']) {
    const fixture = buyerFixture(); fixture.page.requestCancelOrder(fixture.page.orders[0])
    if (change === 'query') fixture.page.requestGeneration++
    if (change === 'account') fixture.page.user.token = 'other'
    if (change === 'request') fixture.page.orders[0].cancelRequest = { id: 'new', state: 'withdrawn' }
    fixture.dialogs[0].secondaryButton.action(); await tick(); assert.equal(fixture.writes.length, 0)
    const detail = detailFixture(); detail.page.requestCancelOrder()
    if (change === 'query') detail.page.querySequence++
    if (change === 'account') detail.page.user.token = 'other'
    if (change === 'request') detail.page.order.cancelRequest = { id: 'new', state: 'withdrawn' }
    detail.dialogs[0].secondaryButton.action(); await tick(); assert.equal(detail.writes.length, 0)
  }
})
test('B-78 迟到回执不覆盖详情新一轮申请或新页、商家新查询', async () => {
  const fixture = detailFixture(), gate = deferred(); fixture.api.submit = () => gate.promise
  const task = fixture.page.runCancelAction('request'); fixture.page.querySequence++
  fixture.page.order = { ...paid(), cancelRequest: { id: 'new', state: 'pending' } }; gate.resolve({ appliedState: 'withdrawn' }); await task
  assert.equal(fixture.page.order.cancelRequest.id, 'new'); assert.equal(fixture.queries.length, 0); assert.equal(fixture.messages.length, 0)
  const merchant = merchantFixture(), wait = deferred(); merchant.api.mutate = () => wait.promise
  merchant.page.openCancelResolution(merchant.order); merchant.page.rejectReason = '已打包'
  const sending = merchant.page.rejectCancellation(); merchant.page.loadRequestId++
  merchant.page.ordersToShip = [{ id: 'new-page' }]; wait.resolve(); await sending
  assert.equal(merchant.page.ordersToShip[0].id, 'new-page'); assert.equal(merchant.queries.length, 0); assert.equal(merchant.messages.length, 0)
})
test('B-78 进入详情和商家页恢复保存号，只刷新最新服务端投影', async () => {
  const fixture = detailFixture(); fixture.api.pending = [{ orderId: 'order', action: 'request' }]
  fixture.api.submit = async () => { fixture.api.pending = [] }; fixture.api.read = async () => ({ ...paid(), cancelRequest: { id: 'newer', state: 'pending' } })
  await fixture.page.loadOrderDetail(); await tick(); await tick()
  assert.equal(fixture.writes[0].recover, 'order'); assert.equal(fixture.queries.length, 2); assert.equal(fixture.page.order.cancelRequest.id, 'newer')
  const merchant = merchantFixture(); let pending = [{ orderId: 'order', action: 'approve' }], recovered = []
  merchant.actions.pending = () => pending; merchant.actions.recover = async (...args) => { recovered.push(args); pending = [] }
  await merchant.page.loadFamilyCenter(); await tick(); await tick()
  assert.deepEqual(recovered, [['order', 'token']]); assert.equal(merchant.queries.length, 2)
})
test('B-64 B-79 取消退款状态、原paymentNotice及needsAttention沿用，不制造红点', () => {
  const presentation = execute(sourceOf(cart + 'presentation/utils/OrderPresentation.ets'), { models: { OrderState: states } })
  const fixture = merchantFixture()
  for (const state of ['退款中', '退款失败重试中', '已退款']) {
    const order = { ...paid(), orderState: 6, canRequestCancel: false, cancelRequest: { state: 'approved' }, refunds: [{ id: 'refund', amount: 12.3, payerAccount: 'friend', paidAt: null, state }], needsAttention: true, paymentNotice: '¥12.30（时间 由 friend 付款）正在退回付款账户。' }
    assert.equal(presentation.getPaymentDisplayLabel(order), '已取消 · ' + state)
    assert.equal(fixture.page.familyOrderStatus(order), '已取消 · ' + state)
    const result = renderBuilder(familyPath, 'OrderSummary', fixture.page, order)
    assert.ok(result.texts.includes(order.paymentNotice)); assert.ok(result.texts.includes('●'))
    order.needsAttention = false
    assert.ok(!renderBuilder(familyPath, 'OrderSummary', fixture.page, order).texts.includes('●'))
  }
})
test('B-81 详情旧取消被拒刷新后提示Q3，不自动转申请', async () => {
  const fixture = detailFixture(); fixture.page.order = { ...paid(), orderState: 1, paymentState: 'confirming', canCancel: true, canRequestCancel: false }
  fixture.legacy.confirm = async () => { throw failure(409) }
  fixture.page.requestCancelOrder(); fixture.dialogs[0].secondaryButton.action(); await tick(); await tick()
  assert.ok(fixture.messages.includes('付款已确认，请重新申请取消')); assert.equal(fixture.writes.length, 0)
})
test('B-81 DEMO_ORDER_FLOW开启时本地演示单不进入新取消流程', () => {
  const fixture = buyerFixture(true); fixture.page.orders = [{ ...paid(), serverManaged: false }]
  fixture.page.requestCancelOrder(fixture.page.orders[0]); assert.equal(fixture.dialogs.length, 0)
  const detail = detailFixture(true); detail.page.order = { ...paid(), serverManaged: false }
  detail.page.requestCancelOrder(); assert.equal(detail.dialogs.length, 0)
})
test('RED6 B-81 旧确认中取消被拒，刷新待发货提示重新申请且不自动提交', async () => {
  const fixture = buyerFixture(); fixture.page.orders = [{ ...paid(), orderState: 1, canRequestCancel: false, canCancel: true, paymentState: 'confirming' }]
  fixture.legacy.confirm = async () => { throw failure(409) }
  fixture.page.reloadOrders = async () => { fixture.page.orders = [paid()] }
  fixture.page.requestCancelOrder(fixture.page.orders[0]); fixture.dialogs[0].secondaryButton.action(); await tick()
  assert.ok(fixture.messages.includes('付款已确认，请重新申请取消'))
  assert.equal(fixture.page.orders[0].canRequestCancel, true); assert.equal(fixture.writes.length, 0)
})
test('RED5 B-77 发货冲突显示服务端原文并刷新页数', async () => {
  const fixture = merchantFixture(); fixture.page.ordersToShip = [{ ...paid(), canShip: true }]
  fixture.api.ship = async () => { throw Object.assign(new Error('买家已申请取消，请先处理取消申请'), { httpStatus: 409, reason: 'CANCEL_REQUEST_BLOCKS_SHIPMENT' }) }
  fixture.page.shipOrder(fixture.page.ordersToShip[0]); await tick(); await tick()
  assert.ok(fixture.messages.includes('买家已申请取消，请先处理取消申请'))
  assert.equal(fixture.queries.length, 1); assert.equal(fixture.page.ordersToShip[0].canResolveCancel, true)
})
test('RED4 B-75 拒绝原因空白超长不提交，三字通过并补读消失末页', async () => {
  const fixture = merchantFixture(); fixture.page.openCancelResolution(fixture.order)
  for (const reason of ['   ', '字'.repeat(201)]) {
    fixture.page.rejectReason = reason; await fixture.page.rejectCancellation()
  }
  assert.deepEqual(fixture.messages, ['请填写拒绝原因', '拒绝原因最多填写200字'])
  assert.equal(fixture.writes.length, 0)
  fixture.page.merchantPage = 2
  fixture.api.merchant = async page => ({ items: page === 2 ? [] : [{ id: 'boundary' }], page, pages: 1 })
  fixture.page.rejectReason = ' 已打包 '; await fixture.page.rejectCancellation()
  assert.equal(fixture.writes[0].reason, '已打包'); assert.equal(fixture.writes[0].action, 'reject-and-ship')
  assert.deepEqual(fixture.queries, [2, 1]); assert.equal(fixture.page.merchantPage, 1); assert.equal(fixture.page.ordersToShip[0].id, 'boundary')
})
test('RED3 B-73 审核中仅有撤回，没有提醒发货或取消订单', () => {
  const fixture = buyerFixture()
  const order = { ...paid(), canRequestCancel: false, canWithdrawCancel: true, cancelRequest: { id: 'request-1', state: 'pending', deadlineAt: 9999 }, cancelRequestNotice: '取消申请审核中' }
  fixture.page.orders = [order]
  const result = renderBuilder(cart + 'presentation/views/OrderView.ets', 'OrderActions', fixture.page, order)
  assert.ok(result.buttons.includes('撤回申请'))
  assert.ok(!result.buttons.includes('提醒发货'))
  assert.ok(!result.buttons.includes('取消订单'))
})
test('RED2 B-78 确认后才提交新申请动作', async () => {
  const fixture = buyerFixture(); fixture.page.requestCancelOrder(fixture.page.orders[0])
  fixture.dialogs[0].secondaryButton.action(); await tick()
  assert.equal(fixture.writes.length, 1)
  assert.equal(fixture.writes[0].action, 'request')
})
test('RED1 B-62 B-65 B-73 本人代付弹窗使用原文，放弃不写入', async () => {
  for (const message of [paid().cancelConfirmation.message, '取消申请提交后，商家同意即不再发货，¥12.30将原路退回亲友 friend 的付款账户。确定申请取消吗？']) {
    const fixture = buyerFixture(); fixture.page.orders = [paid(message)]
    fixture.page.requestCancelOrder(fixture.page.orders[0])
    assert.equal(fixture.dialogs.length, 1)
    assert.equal(fixture.dialogs[0].message, message)
    assert.equal(fixture.dialogs[0].primaryButton.value, '再等等')
    assert.equal(fixture.dialogs[0].secondaryButton.value, '确定申请')
    fixture.dialogs[0].primaryButton.action(); await tick()
    assert.equal(fixture.writes.length, 0)
    fixture.dialogs[0].secondaryButton.action(); await tick()
    assert.equal(fixture.writes.length, 0)
  }
})
