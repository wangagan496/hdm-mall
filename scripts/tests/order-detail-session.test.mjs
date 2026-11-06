import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, execute, pageMethods, sourceOf, tick } from './native-harness.mjs'

const base = 'mixed-development-h5/features/cart/src/main/ets/presentation/'
const states = { AWAITING_PAYMENT: 1, AWAITING_SHIPMENT: 2, AWAITING_RECEIPT: 3, AWAITING_REVIEW: 4, CANCELLED: 6 }
const test = (name, run) => nodeTest(name, { timeout: 1500 }, run)
const row = (id = 'order-a', orderState = 3) => ({ id, orderState, serverManaged: true, skus: [], evaluation: { content: id } })

function fixture() {
  const queries = [], writes = [], messages = [], navigations = [], overlays = [], dialogs = []
  let pending = [], mutation = async () => {}, cancelling = async () => {}
  const flow = execute(sourceOf(base + 'utils/DemoOrderFlow.ets'), {
    constants: { GlobalVariable: { DEMO_ORDER_FLOW: false } },
    storage: { demoOrderStore: { setOverlay: async (...args) => overlays.push(args) } },
  })
  const Page = pageMethods(base + 'views/OrderDetailView.ets', 'OrderDetailView', {}, {
    ...flow, OrderState: states, readPhoneClockMillis: () => 123,
    PAGE_PATH: { PAY_PAGE: 'pay', EVALUATION_PAGE: 'evaluation' },
    getOrderDetailAPI: (id, token) => { const gate = deferred(); queries.push({ ...gate, id, token }); return gate.promise },
    receiptOrderAPI: (id, token) => { writes.push({ action: 'receipt', id, token }); return mutation() },
    remindShipmentAPI: (id, token) => { writes.push({ action: 'remind', id, token }); return mutation() },
    orderCancellation: { pendingIds: () => pending, confirm: (id, resume) => { writes.push({ action: 'cancel', id, resume }); return cancelling() } },
  })
  const page = new Page()
  page.user = { token: 'buyer-a' }
  page.orderId = 'order-a'
  page.safeToast = message => messages.push(message)
  page.getUIContext = () => ({ showAlertDialog: dialog => dialogs.push(dialog),
    getPromptAction: () => ({ showToast: value => messages.push(value.message) }) })
  page.stackPath = { pushPath: path => navigations.push(path), getParamByName: () => ['order-a'] }
  const load = async (value = row()) => {
    const task = page.loadOrderDetail()
    queries.at(-1).resolve(value)
    await task
  }
  return { page, queries, writes, messages, navigations, overlays, dialogs, load,
    setMutation: fn => { mutation = fn }, setCancel: fn => { cancelling = fn }, setPending: ids => { pending = ids } }
}

test('换账号清除订单地址和评价，旧详情成功或失败不能覆盖新会话', async () => {
  for (const fails of [false, true]) {
    const f = fixture()
    await f.load()
    const old = f.page.loadOrderDetail()
    f.page.user = { token: 'buyer-b' }
    const current = f.page.loadOrderDetail()
    assert.equal(f.page.order, null)
    assert.equal(f.page.evaluation, null)
    assert.equal(f.page.displayedOrderState, 0)
    if (fails) f.queries[1].reject(new Error('old failure'))
    else f.queries[1].resolve(row('private-a'))
    await old
    assert.equal(f.page.loading, true)
    assert.deepEqual(f.messages, [])
    f.queries[2].reject(new Error('forbidden'))
    await current
    assert.equal(f.page.order, null)
    assert.equal(f.page.loadFailed, true)
    assert.equal(f.queries[2].token, 'buyer-b')
  }
})

test('匿名不查询，同账号资料更新不重读，隐藏页忽略前台刷新且返回后重新查询', async () => {
  const f = fixture()
  f.page.user = { token: '' }
  const anonymous = f.page.loadOrderDetail()
  assert.equal(f.queries.length, 0)
  await anonymous
  assert.equal(f.page.loading, false)
  f.page.user = { token: 'buyer-a' }
  await f.load()
  f.page.user = { token: 'buyer-a', nickname: 'new' }
  f.page.reloadForCurrentAccount()
  assert.equal(f.queries.length, 1)
  f.page.hideOrderDetail()
  f.page.refreshAfterForeground()
  assert.equal(f.queries.length, 1)
  f.page.user = { token: 'buyer-b' }
  f.page.reloadForCurrentAccount()
  assert.equal(f.page.order, null)
  assert.equal(f.queries.length, 1)
  f.page.showOrderDetail()
  assert.equal(f.queries.length, 2)
  f.queries[1].resolve(row())
  await tick()
  assert.equal(f.page.loading, false)
})

test('离页重进后旧详情不能写回或结束新查询，查询固定发起凭证', async () => {
  for (const fails of [false, true]) {
    const f = fixture()
    const old = f.page.loadOrderDetail()
    assert.equal(f.queries[0].token, 'buyer-a')
    f.page.aboutToDisappear()
    f.page.showOrderDetail()
    if (fails) f.queries[0].reject(new Error('old failure'))
    else f.queries[0].resolve(row('old'))
    await old
    assert.equal(f.page.loading, true)
    assert.deepEqual(f.messages, [])
    f.queries[1].resolve(row())
    await tick()
    assert.equal(f.page.order.id, 'order-a')
  }
})

test('加载中、加载失败及账号监听前不能操作旧订单或打开支付评价', async () => {
  const f = fixture()
  await f.load()
  const loading = f.page.loadOrderDetail()
  const blocked = f.page.run('receipt', () => f.page.runReceipt(), 'received')
  assert.equal(f.writes.length, 0)
  await blocked
  f.queries[1].reject(new Error('offline'))
  await loading
  await f.page.run('receipt', () => f.page.runReceipt(), 'received')
  await f.page.runComment()
  f.page.openPayment()
  assert.equal(f.writes.length, 0)
  assert.equal(f.navigations.length, 0)
  await f.load()
  f.page.user = { token: 'buyer-b' }
  await f.page.run('receipt', () => f.page.runReceipt(), 'received')
  await f.page.runComment()
  f.page.openPayment()
  assert.equal(f.writes.length, 0)
  assert.equal(f.navigations.length, 0)
})

test('换账号或离页重进后旧操作成功失败及收尾不提示或解除新操作锁', async () => {
  for (const transition of ['account', 'reenter']) for (const fails of [false, true]) {
    const f = fixture()
    await f.load()
    const oldGate = deferred(), currentGate = deferred()
    f.setMutation(() => oldGate.promise)
    const old = f.page.run('receipt', () => f.page.runReceipt(), 'old success')
    assert.equal(f.writes[0].token, 'buyer-a')
    if (transition === 'account') {
      f.page.user = { token: 'buyer-b' }
      f.page.reloadForCurrentAccount()
    } else {
      f.page.aboutToDisappear()
      f.page.showOrderDetail()
    }
    f.queries.at(-1).resolve(row())
    await tick()
    f.setMutation(() => currentGate.promise)
    const current = f.page.run('receipt', () => f.page.runReceipt(), 'current success')
    assert.equal(f.writes.length, 2)
    if (fails) oldGate.reject(new Error('old failure'))
    else oldGate.resolve()
    await old
    assert.equal(f.page.busy, 'receipt')
    assert.deepEqual(f.messages, [])
    currentGate.resolve()
    await tick()
    f.queries.at(-1).resolve(row('order-a', 4))
    await current
    assert.equal(f.page.busy, '')
    assert.equal(f.page.displayedOrderState, 4)
    assert.deepEqual(f.messages, ['current success'])
  }
})

test('操作期间刷新不吞掉成功结果，重复点击仍只提交一次并重新读取确认状态', async () => {
  const f = fixture()
  await f.load(row('order-a', 2))
  const gate = deferred()
  f.setMutation(() => gate.promise)
  const action = f.page.run('consignment', () => f.page.runConsignment(), 'reminded')
  await f.page.run('consignment', () => f.page.runConsignment(), 'duplicate')
  assert.deepEqual(f.writes, [{ action: 'remind', id: 'order-a', token: 'buyer-a' }])
  await f.load(row('order-a', 2))
  gate.resolve()
  await tick()
  assert.equal(f.queries.length, 3)
  f.queries[2].resolve(row('order-a', 2))
  await action
  assert.deepEqual(f.messages, ['reminded'])
  assert.equal(f.page.displayedOrderState, 2)
  assert.equal(f.page.busy, '')
})

test('只有已有取消意图才恢复取消，成功后不重复恢复，失败保留待确认入口', async () => {
  const f = fixture()
  await f.load(row('order-a', 1))
  assert.equal(f.writes.length, 0)
  f.setPending(['order-a'])
  const gate = deferred()
  f.setCancel(() => gate.promise)
  await f.load(row('order-a', 1))
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0].resume, true)
  gate.reject(new Error('取消结果待确认'))
  await tick()
  assert.equal(f.page.busy, '')
  assert.equal(f.page.cancellationPending, true)
  f.setCancel(async () => { f.setPending([]) })
  const retry = f.page.run('cancel', () => f.page.runCancelWithFallback(true), 'cancelled')
  await tick()
  f.queries.at(-1).resolve(row('order-a', 6))
  await retry
  assert.equal(f.writes.length, 2)
  assert.equal(f.page.cancellationPending, false)
})

test('演示操作迟到结果不写入后来页面的本地覆盖层', async () => {
  for (const fails of [false, true]) {
    const writes = [], gate = deferred()
    let current = true
    const flow = execute(sourceOf(base + 'utils/DemoOrderFlow.ets'), {
      constants: { GlobalVariable: { DEMO_ORDER_FLOW: true } },
      storage: { demoOrderStore: { setOverlay: async (...args) => writes.push(args) } },
    })
    const action = flow.advanceOrderState('old-order', 4, () => gate.promise, () => current)
    current = false
    if (fails) gate.reject(new Error('late failure'))
    else gate.resolve()
    await action
    assert.deepEqual(writes, [])
    current = true
    await flow.advanceOrderState('current-order', 4, async () => {}, () => current)
    assert.deepEqual(writes, [['current-order', 4]])
  }
})

test('详情确认中取消先弹退款提示，取消弹窗不提交，确认后才取消', async () => {
  const f = fixture()
  await f.load({ ...row(), orderState: 1, paymentState: 'confirming', canCancel: true, canPay: false, payMoney: 24.5 })
  f.page.requestCancelOrder()
  assert.equal(f.dialogs.length, 1)
  assert.equal(f.dialogs[0].message, '付款可能已经成功。取消后，如已扣款，¥24.50将原路退回付款账户。确定取消吗？')
  f.dialogs[0].primaryButton.action()
  assert.equal(f.writes.length, 0)
  f.dialogs[0].secondaryButton.action(); await tick()
  assert.equal(f.writes.length, 0)
  f.page.requestCancelOrder()
  f.dialogs[1].secondaryButton.action(); await tick()
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0].action, 'cancel')
})
