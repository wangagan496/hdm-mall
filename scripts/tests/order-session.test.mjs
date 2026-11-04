import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, execute, pageMethods, sourceOf, tick } from './native-harness.mjs'

const test = (name, run) => nodeTest(name, { timeout: 2000 }, run)
const base = 'mixed-development-h5/features/cart/src/main/ets/presentation/'
const states = { ALL_TAB: 0, AWAITING_PAYMENT: 1, AWAITING_SHIPMENT: 2, AWAITING_RECEIPT: 3, AWAITING_REVIEW: 4 }
const inTab = (state, tab) => state !== 6 && (!tab || state === tab)
const row = (id = 'order-a', orderState = 3) => ({ id, orderState, skus: [], countdown: 0, createTime: id })
const pageOf = (items = [row()], pages = 1) => ({ items, pages })
const loader = execute(sourceOf(base + 'utils/OrderTabLoader.ets'), { './OrderPresentation': { isOrderStateInTab: inTab } })

function fixture() {
  const queries = [], writes = [], messages = [], navigations = []
  let pending = [], mutation = async id => row(id, 4)
  const Page = pageMethods(base + 'views/OrderView.ets', 'OrderView', {}, {
    ...loader, OrderState: states, isOrderStateInTab: inTab,
    readPhoneClockMillis: () => 0, secondsLeftToPay: remaining => remaining,
    PAGE_PATH: { ORDER_PAGE: 'orders', PAY_PAGE: 'pay', ORDER_DETAIL_PAGE: 'detail', EVALUATION_PAGE: 'evaluation' },
    getOrderListAPI: (params, token) => { const gate = deferred(); queries.push({ ...gate, params, token }); return gate.promise },
    remindShipmentAPI: (id, token) => { writes.push({ action: 'remind', id, token }); return mutation(id) },
    receiptOrderAPI: (id, token) => { writes.push({ action: 'receipt', id, token }); return mutation(id) },
    orderCancellation: { pendingIds: () => pending, confirm: (id, resume) => { writes.push({ action: 'cancel', id, resume }); return mutation(id) } },
  })
  const page = new Page()
  page.user = { token: 'buyer-a' }
  page.safeToast = message => messages.push(message)
  page.stackPath = { pushPath: path => navigations.push(path), getParamByName: () => [] }
  const load = async (value = pageOf()) => {
    const task = page.reloadOrders()
    queries.at(-1).resolve(value)
    await task
  }
  return { page, queries, writes, messages, navigations, load,
    setMutation: fn => { mutation = fn }, setPending: ids => { pending = ids } }
}

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
