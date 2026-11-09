import { emptyCancelActions, cancelActionFailure } from './cancel-boundaries.mjs'
import { orderWriteFailure, BusinessError } from './order-write-boundaries.mjs'
import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, execute, pageMethods, sourceOf, tick } from './native-harness.mjs'

const test = (name, run) => nodeTest(name, { timeout: 2000 }, run)
const base = 'mixed-development-h5/features/cart/src/main/ets/presentation/'
const states = { ALL_TAB: 0, AWAITING_PAYMENT: 1, AWAITING_SHIPMENT: 2, AWAITING_RECEIPT: 3, AWAITING_REVIEW: 4, COMPLETED: 5, CANCELLED: 6 }
const row = (id = 'order-a', orderState = 3, values = {}) => ({ id, orderState, skus: [], countdown: 0, createTime: id, ...values })
const pageOf = (items = [row()], pages = 1) => ({ items, pages })
const presentation = execute(sourceOf(base + 'utils/OrderPresentation.ets'), { models: { OrderState: states } })
const loader = execute(sourceOf(base + 'utils/OrderTabLoader.ets'), { './OrderPresentation': presentation })

function fixture() {
  const queries = [], writes = [], messages = [], navigations = [], dialogs = []
  let pending = [], mutation = async id => row(id, 4)
  const Page = pageMethods(base + 'views/OrderView.ets', 'OrderView', {}, {
    orderWriteFailure,
    cancelActions: emptyCancelActions, cancelActionFailure,
    ...loader, OrderState: states,
    ...presentation,
    readPhoneClockMillis: () => 0, secondsLeftToPay: remaining => remaining,
    PAGE_PATH: { ORDER_PAGE: 'orders', PAY_PAGE: 'pay', ORDER_DETAIL_PAGE: 'detail', EVALUATION_PAGE: 'evaluation' },
    getOrderListAPI: (params, token) => { const gate = deferred(); queries.push({ ...gate, params, token }); return gate.promise },
    getOrderDetailAPI: async id => row(id),
    remindShipmentAPI: (id, token) => { writes.push({ action: 'remind', id, token }); return mutation(id) },
    receiptOrderAPI: (id, token) => { writes.push({ action: 'receipt', id, token }); return mutation(id) },
    orderCancellation: { pendingIds: () => pending, confirm: (id, resume) => { writes.push({ action: 'cancel', id, resume }); return mutation(id) } },
  })
  const page = new Page()
  page.user = { token: 'buyer-a' }
  page.safeToast = message => messages.push(message)
  page.getUIContext = () => ({ showAlertDialog: dialog => dialogs.push(dialog),
    getPromptAction: () => ({ showToast: value => messages.push(value.message) }) })
  page.stackPath = { pushPath: path => navigations.push(path), getParamByName: () => [] }
  const load = async (value = pageOf()) => {
    const task = page.reloadOrders()
    queries.at(-1).resolve(value)
    await task
  }
  return { page, queries, writes, messages, navigations, dialogs, load,
    setMutation: fn => { mutation = fn }, setPending: ids => { pending = ids } }
}

test('L4-2: 确认收货响应未知锁定卡片，重新查询成功解除待确认', async () => {
  const f = fixture(); f.page.selectedState = 3; await f.load()
  f.setMutation(async () => { throw Object.assign(new Error('Failed to connect to the server'), { isAxiosError: true }) })
  await f.page.runOrderAction('order-a', 'receipt', () => f.page.runReceipt('order-a'), 'received')
  assert.deepEqual(Array.from(f.page.pendingReceipts || []), ['order-a'])
  assert.equal(f.page.canUseOrder('order-a'), false)
  assert.equal(f.page.canUseOrder('order-a', true), false)
  await f.page.runOrderAction('order-a', 'receipt', () => f.page.runReceipt('order-a'), 'received')
  assert.equal(f.writes.length, 1)
  const retry = f.page.reloadOrders(); f.queries.at(-1).reject(new Error('offline')); await retry
  assert.deepEqual(Array.from(f.page.pendingReceipts), ['order-a'])
  await f.load(pageOf([]))
  assert.equal(f.page.pendingReceipts.length, 1)
  await f.page.checkPendingOrder('order-a')
  assert.equal(f.page.pendingReceipts.length, 0); assert.equal(f.page.orders.length, 0)
})

test('L4-3: 取消待确认禁止普通操作，恢复取消仍能执行', async () => {
  const f = fixture(); await f.load(pageOf([row('order-a', 1, { canPay: true, countdown: 100 })]))
  f.setPending(['order-a']); f.page.pendingCancellations = ['order-a']
  assert.equal(f.page.canUseOrder('order-a'), false)
  assert.equal(f.page.canUseOrder('order-a', true), true)
  f.page.goPay('order-a'); assert.equal(f.navigations.length, 0)
  f.setMutation(async id => { f.setPending([]); return row(id, 6) })
  await f.page.recoverCancellations()
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].resume, true)
  assert.equal(f.page.pendingCancellations.length, 0); assert.equal(f.page.orders[0].orderState, 6)
})

test('L4-2: 收货未知状态分类、未变恢复可点及明确业务错误不锁定', async () => {
  for (const status of [408, 429, 500, 503, 400, 200]) {
    const f = fixture(); await f.load()
    f.setMutation(async () => { throw new BusinessError('订单不能收货', status) })
    await f.page.runOrderAction('order-a', 'receipt', () => f.page.runReceipt('order-a'), 'received')
    assert.equal(f.page.pendingReceipts.length, [400, 200].includes(status) ? 0 : 1)
    if ([400, 200].includes(status)) assert.deepEqual(f.messages, ['订单不能收货'])
    await f.load()
    await f.page.checkPendingOrder('order-a')
    assert.equal(f.page.pendingReceipts.length, 0); assert.equal(f.page.canUseOrder('order-a'), true)
  }
})

test('L4-2: 收货迟到错误不跨会话写回，旧查询不清除新待确认', async () => {
  for (const transition of ['account', 'hidden', 'refresh']) {
    const f = fixture(); await f.load()
    const gate = deferred(); f.setMutation(() => gate.promise)
    const action = f.page.runOrderAction('order-a', 'receipt', () => f.page.runReceipt('order-a'), 'received')
    if (transition === 'account') { f.page.user = { token: 'buyer-b' }; f.page.onUserChanged() }
    if (transition === 'hidden') f.page.hideOrders()
    const refresh = transition === 'refresh' ? f.page.reloadOrders() : null
    gate.reject(Object.assign(new Error('offline'), { isAxiosError: true })); await action
    if (transition === 'refresh') {
      f.queries.at(-1).resolve(pageOf()); await refresh
      assert.deepEqual(Array.from(f.page.pendingReceipts), ['order-a'])
      await f.load(); assert.equal(f.page.pendingReceipts.length, 1)
      await f.page.checkPendingOrder('order-a'); assert.equal(f.page.pendingReceipts.length, 0)
    } else {
      assert.equal(f.page.pendingReceipts.length, 0); assert.equal(f.messages.length, 0)
    }
  }
  const f = fixture(); await f.load(); f.page.pendingReceipts = ['order-a']
  f.page.user = { token: 'buyer-b' }; f.page.onUserChanged()
  assert.equal(f.page.pendingReceipts.length, 0)
})

test('订单查询固定发起凭证，账号监听前的旧结果不能写回或继续补取下一页', async () => {
  const f = fixture()
  const loading = f.page.reloadOrders()
  assert.equal(f.queries[0].token, 'buyer-a')
  f.page.user = { token: 'buyer-b' }
  f.queries[0].resolve(pageOf([row('private-a')], 3))
  await loading
  assert.equal(f.queries.length, 1)
  assert.equal(f.page.orders.length, 0)
  f.page.onUserChanged()
  assert.equal(f.queries[1].token, 'buyer-b')
  f.queries[1].resolve(pageOf([row('order-b')]))
  await tick()
  assert.equal(f.page.orders[0].id, 'order-b')
})

test('隐藏订单页不刷新或恢复取消，返回重读，同账号资料更新不重复查询且退出不发匿名请求', async () => {
  const f = fixture()
  await f.load()
  f.page.user = { token: 'buyer-a', nickname: 'new' }
  f.page.onUserChanged()
  assert.equal(f.queries.length, 1)
  f.page.hideOrders()
  f.setPending(['old-intent'])
  f.page.refreshAfterForeground()
  await f.page.recoverCancellations()
  assert.equal(f.queries.length, 1)
  assert.equal(f.writes.length, 0)
  f.page.user = { token: 'buyer-b' }
  f.setPending([])
  f.page.onUserChanged()
  assert.equal(f.page.orders.length, 0)
  assert.equal(f.page.pendingCancellations.length, 0)
  assert.equal(f.queries.length, 1)
  f.page.refreshOnReturn()
  assert.equal(f.queries.length, 2)
  f.queries[1].resolve(pageOf([row('order-b')]))
  await tick()
  f.page.user = { token: '' }
  f.page.onUserChanged()
  assert.equal(f.page.orders.length, 0)
  assert.equal(f.page.loading, false)
  assert.equal(f.queries.length, 2)
})

test('刷新和失败保留的旧订单不能操作或跳转，重试成功后恢复且缺失订单不提交', async () => {
  const f = fixture()
  await f.load()
  const refreshing = f.page.reloadOrders()
  await f.page.runOrderAction('order-a', 'receipt', () => f.page.runReceipt('order-a'), 'received')
  assert.equal(f.writes.length, 0)
  f.queries[1].reject(new Error('offline'))
  await refreshing
  await f.page.runOrderAction('order-a', 'receipt', () => f.page.runReceipt('order-a'), 'received')
  f.page.goPay('order-a'); f.page.openOrderDetail('order-a'); await f.page.runComment('order-a')
  assert.equal(f.writes.length, 0)
  assert.equal(f.navigations.length, 0)
  await f.load()
  f.page.openOrderDetail('order-a')
  assert.equal(f.navigations.length, 1)
  await f.page.runOrderAction('missing', 'receipt', () => f.page.runReceipt('missing'), 'wrong')
  assert.equal(f.writes.length, 0)
  f.page.user = { token: 'buyer-b' }
  await f.page.runOrderAction('order-a', 'receipt', () => f.page.runReceipt('order-a'), 'wrong')
  f.page.goPay('order-a')
  assert.equal(f.writes.length, 0)
  assert.equal(f.navigations.length, 1)
})

test('账号切换和离页重进后旧操作成功失败及收尾不干扰新操作', async () => {
  for (const transition of ['account', 'reenter']) for (const fails of [false, true]) {
    const f = fixture()
    await f.load()
    const oldGate = deferred(), currentGate = deferred()
    f.setMutation(() => oldGate.promise)
    const old = f.page.runOrderAction('order-a', 'receipt', () => f.page.runReceipt('order-a'), 'old success')
    assert.equal(f.writes[0].token, 'buyer-a')
    if (transition === 'account') {
      f.page.user = { token: 'buyer-b' }
      f.page.onUserChanged()
    } else {
      f.page.aboutToDisappear()
      f.page.refreshOnReturn()
    }
    f.queries.at(-1).resolve(pageOf([row('order-b')]))
    await tick()
    f.setMutation(() => currentGate.promise)
    const current = f.page.runOrderAction('order-b', 'receipt', () => f.page.runReceipt('order-b'), 'current success')
    assert.equal(f.writes.length, 2)
    if (fails) oldGate.reject(new Error('old failure'))
    else oldGate.resolve(row('order-a', 4))
    await old
    assert.equal(f.page.busyOrderId, 'order-b')
    assert.deepEqual(f.messages, [])
    currentGate.resolve(row('order-b', 4))
    await current
    assert.equal(f.page.busyOrderId, '')
    assert.equal(f.page.orders[0].orderState, 4)
    assert.deepEqual(f.messages, ['current success'])
  }
})

test('操作期间刷新或换栏目后仍确认成功并重读当前栏目，旧查询不能覆盖更新', async () => {
  for (const changeTab of [false, true]) {
    const f = fixture()
    await f.load()
    const gate = deferred()
    f.setMutation(() => gate.promise)
    const action = f.page.runOrderAction('order-a', 'receipt', () => f.page.runReceipt('order-a'), 'received')
    if (changeTab) f.page.selectedState = 4
    const refresh = f.page.reloadOrders()
    gate.resolve(row('order-a', 4))
    await tick()
    assert.equal(f.queries.length, 3)
    assert.equal(f.queries[2].params.orderState, changeTab ? 4 : 0)
    f.queries[1].resolve(pageOf([row('stale', changeTab ? 4 : 3)]))
    await refresh
    assert.equal(f.page.loading, true)
    f.queries[2].resolve(pageOf([row('order-a', 4)]))
    await action
    assert.equal(f.page.orders[0].orderState, 4)
    assert.equal(f.page.busyOrderId, '')
    assert.deepEqual(f.messages, ['received'])
  }
})

test('恢复取消等待列表确认且允许处理未显示的已保存意图，离页后停止剩余队列', async () => {
  const f = fixture(), gate = deferred()
  f.setPending(['hidden-order', 'next-order'])
  f.setMutation(() => gate.promise)
  const loading = f.page.reloadOrders()
  const premature = f.page.recoverCancellations()
  assert.equal(f.writes.length, 0)
  await premature
  f.queries[0].resolve(pageOf())
  await loading
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0].id, 'hidden-order')
  assert.equal(f.writes[0].resume, true)
  f.page.hideOrders()
  gate.resolve(row('hidden-order', 6))
  await tick()
  assert.equal(f.writes.length, 1)
  assert.deepEqual(f.messages, [])
})

test('提醒发货绑定原会话且不改变状态，重复操作受锁保护', async () => {
  const f = fixture(), gate = deferred()
  await f.load(pageOf([row('order-a', 2)]))
  f.setMutation(() => gate.promise)
  const action = f.page.runOrderAction('order-a', 'remind', () => f.page.runConsignment('order-a'), 'reminded')
  await f.page.runOrderAction('order-a', 'remind', () => f.page.runConsignment('order-a'), 'duplicate')
  assert.deepEqual(f.writes, [{ action: 'remind', id: 'order-a', token: 'buyer-a' }])
  gate.resolve(row('order-a', 2))
  await action
  assert.equal(f.page.orders[0].orderState, 2)
  assert.deepEqual(f.messages, ['reminded'])
})

test('确认中列表保留待付款行，隐藏支付与倒计时并展示提示退款和未读红点', async () => {
  const f = fixture()
  const confirming = row('pending-payment', 1, { paymentState: 'confirming', canPay: false, countdown: 0,
    paymentNotice: '正在确认付款结果，请勿重复付款', needsAttention: true,
    refunds: [{ id: 'refund-a', amount: 19, payerAccount: 'payer-a', paidAt: 1793865600000, state: '退款中' }] })
  await f.load(pageOf([confirming]))
  assert.equal(f.page.orders[0].paymentState, 'confirming')
  assert.equal(f.page.orders[0].needsAttention, true)
  assert.equal(f.page.canUseOrder('pending-payment'), true)
  assert.equal(f.page.goPay('pending-payment'), undefined)
  assert.equal(f.navigations.length, 0)
  const viewSource = sourceOf(base + 'views/OrderView.ets')
  assert.match(viewSource, /if \(shouldShowPaymentCountdown\(order\)\)/)
  assert.match(viewSource, /Text\(getPaymentDisplayLabel\(order\)\)/)
  assert.match(viewSource, /Text\(getRefundDisplayLine\(refund\)\)/)
  assert.match(viewSource, /if \(hasUnreadPaymentNotice\(order\)\)/)
})

test('列表确认中取消先弹退款提示，取消弹窗不提交，确认后才取消', async () => {
  const f = fixture(), confirming = row('pending-payment', 1, { paymentState: 'confirming', canPay: false,
    canCancel: true, payMoney: 24.5, paymentNotice: '正在确认付款结果，请勿重复付款' })
  await f.load(pageOf([confirming]))
  f.page.requestCancelOrder(confirming)
  assert.equal(f.dialogs.length, 1)
  assert.equal(f.dialogs[0].message, '付款可能已经成功。取消后，如已扣款，¥24.50将原路退回付款账户。确定取消吗？')
  f.dialogs[0].primaryButton.action()
  assert.equal(f.writes.length, 0)
  f.dialogs[0].secondaryButton.action(); await tick()
  assert.equal(f.writes.length, 0)
  f.page.requestCancelOrder(confirming)
  f.dialogs[1].secondaryButton.action(); await tick()
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0].action, 'cancel')
})

test('B-53：多扣退款保留有效付款人，查看详情返回后列表红点消失', async () => {
  const f = fixture(), paid = row('order-a', 2, { serverManaged: true, paymentState: 'paid', payerAccount: 'buyer-a',
    needsAttention: true, paymentNotice: '多付的 ¥19.00 已原路退回付款账户。',
    refunds: [{ id: 'refund-a', amount: 19, payerAccount: 'friend-a', paidAt: null, state: '已退款' }] })
  await f.load(pageOf([paid]))
  assert.equal(presentation.hasUnreadPaymentNotice(f.page.orders[0]), true)
  assert.equal(presentation.getRefundDisplayLine(f.page.orders[0].refunds[0]), '¥19.00 · friend-a · 付款时间待确认 · 已退款')
  f.page.openOrderDetail('order-a'); assert.equal(f.navigations[0].param, 'order-a')
  f.page.hideOrders(); f.page.refreshOnReturn()
  f.queries.at(-1).resolve(pageOf([{ ...paid, needsAttention: false }])); await tick()
  assert.equal(presentation.hasUnreadPaymentNotice(f.page.orders[0]), false)
  assert.equal(f.page.orders[0].payerAccount, 'buyer-a')
  assert.equal(f.page.orders[0].orderState, 2)
})

test('全部取消后原位保留已取消卡片，待付款取消后移除且不再允许操作', async () => {
  for (const tab of [0, 1]) {
    const f = fixture(); f.page.selectedState = tab
    const pending = row('order-a', 1, { canCancel: true, payMoney: 19 })
    await f.load(pageOf([row('before', 1), pending, row('after', 1)]))
    const beforeIds = Array.from(f.page.orders, order => order.id)
    f.setMutation(async id => row(id, 6, { canCancel: false, canPay: false }))
    f.page.requestCancelOrder(pending); await tick()
    assert.deepEqual(Array.from(f.page.orders, order => order.id), tab === 0 ? beforeIds : beforeIds.filter(id => id !== 'order-a'))
    if (tab === 0) {
      const cancelled = f.page.orders.find(order => order.id === 'order-a')
      assert.equal(cancelled.orderState, 6)
      assert.equal(f.page.hasOrderActions(cancelled), false)
      assert.equal(presentation.shouldShowPaymentCountdown(cancelled), false)
      f.page.goPay('order-a'); f.page.requestCancelOrder(cancelled)
      assert.equal(f.writes.length, 1); assert.equal(f.navigations.length, 0)
      f.page.openOrderDetail('order-a'); assert.equal(f.navigations[0].param, 'order-a')
    }
  }
  assert.match(sourceOf(base + 'views/OrderView.ets'), /if \(this.hasOrderActions\(order\)\)/)
})

test('已取消退款订单详情返回后仍可找到且红点消失', async () => {
  const f = fixture(), cancelled = row('cancelled', 6, { needsAttention: true,
    refunds: [{ id: 'refund', amount: 19, payerAccount: 'buyer', paidAt: null, state: '已退款' }] })
  await f.load(pageOf([cancelled]))
  assert.equal(f.page.orders.length, 1)
  f.page.openOrderDetail('cancelled'); f.page.hideOrders(); f.page.refreshOnReturn()
  f.queries.at(-1).resolve(pageOf([{ ...cancelled, needsAttention: false }])); await tick()
  assert.equal(f.page.orders[0].needsAttention, false)
  assert.equal(presentation.getPaymentDisplayLabel(f.page.orders[0]), '已取消 · 已退款')
})
