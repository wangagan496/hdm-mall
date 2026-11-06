import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, execute, pageMethods, sourceOf, tick } from './native-harness.mjs'

const base = 'mixed-development-h5/features/cart/src/main/ets/presentation/'
const OrderState = { ALL_TAB: 0, AWAITING_PAYMENT: 1, AWAITING_SHIPMENT: 2, AWAITING_RECEIPT: 3,
  AWAITING_REVIEW: 4, COMPLETED: 5, CANCELLED: 6 }
const presentation = execute(sourceOf(base + 'utils/OrderPresentation.ets'), { models: { OrderState } })
const row = (state = 1, id = 'order-a', canPay = true) => ({ id, orderState: state, canPay, serverManaged: true, payMoney: 19 })

function fakeTimers() {
  let now = 0, nextId = 0
  const tasks = new Map()
  const schedule = (callback, delay, interval = 0) => {
    const id = ++nextId
    tasks.set(id, { callback, due: now + delay, interval })
    return id
  }
  return {
    setTimeout: (callback, delay) => schedule(callback, delay),
    clearTimeout: id => tasks.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, delay),
    clearInterval: id => tasks.delete(id),
    advance(milliseconds) {
      const target = now + milliseconds
      while (true) {
        const next = [...tasks.entries()].filter(([, task]) => task.due <= target)
          .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0]
        if (!next) break
        const [id, task] = next
        now = task.due
        if (task.interval) task.due += task.interval
        else tasks.delete(id)
        task.callback()
      }
      now = target
    },
    size: () => tasks.size,
    ids: () => [...tasks.keys()],
  }
}

function fixture() {
  let params = [{ orderId: 'order-a', payResult: true }], overlay = null
  let cancel = id => Promise.resolve({ ...row(6, id), skus: [] })
  const queries = [], refreshes = [], navigations = [], demoReads = [], dialogs = [], cancellations = [], timers = fakeTimers()
  const config = { DEMO_ORDER_FLOW: false }
  const Page = pageMethods(base + 'views/PayResultView.ets', 'PayResultView', {}, {
    ...presentation, GlobalVariable: config, PAGE_PATH: { PAY_RESULT_PAGE: 'result', PAY_PAGE: 'pay', ORDER_PAGE: 'orders' },
    getOrderDetailAPI: (id, token) => { const gate = deferred(); queries.push({ ...gate, id, token }); return gate.promise },
    refreshPaymentAPI: (id, token) => { const gate = deferred(); refreshes.push({ ...gate, id, token }); return gate.promise },
    orderCancellation: { confirm: id => { cancellations.push(id); return cancel(id) } },
    demoOrderStore: { getOverlay: id => { demoReads.push(id); return overlay }, getEvaluation: () => null },
    ...timers,
  })
  const page = new Page(); page.user = { token: 'token-a' }
  page.getUIContext = () => ({ showAlertDialog: dialog => dialogs.push(dialog),
    getPromptAction: () => ({ showToast: () => {} }) })
  page.stackPath = { getParamByName: () => params, pushPath: path => navigations.push({ type: 'push', ...path }),
    replacePath: path => navigations.push({ type: 'replace', ...path }) }
  const start = () => page.aboutToAppear()
  const finish = async (value = row()) => { queries.at(-1).resolve(value); await tick() }
  const switchUser = user => { page.user = user; page.reloadForCurrentAccount?.() }
  return { page, queries, refreshes, navigations, demoReads, dialogs, cancellations, config, timers, start, finish, switchUser,
    setParams: value => { params = value }, setOverlay: value => { overlay = value }, setCancel: value => { cancel = value } }
}

test('支付结果查询中不能进入收银台，查询失败只可查看订单并允许重查', async () => {
  const f = fixture(); f.start()
  f.page.openOrderListOrCashier(); assert.equal(f.navigations.length, 0)
  assert.equal(f.page.paymentSucceeded, false)
  f.queries[0].reject(new Error('offline')); await tick()
  assert.equal(f.page.paymentResultUnconfirmed, true); assert.equal(f.page.getPaymentResultTitle(), '支付结果待确认')
  f.page.openOrderListOrCashier(); assert.equal(f.navigations.at(-1).name, 'orders')
  const retry = f.page.confirmPaymentResult(); await f.finish(row(1)); await retry
  assert.equal(f.page.paymentResultUnconfirmed, false); assert.equal(f.page.paymentSucceeded, false)
  f.page.openOrderListOrCashier(); assert.equal(f.navigations.at(-1).name, 'pay')
})

test('支付结果乱序成功和失败不能覆盖最新结果或提前结束等待', async () => {
  for (const failed of [false, true]) {
    const f = fixture(); f.start()
    const newer = f.page.confirmPaymentResult()
    if (failed) f.queries[0].reject(new Error('old failure')); else f.queries[0].resolve(row(2))
    await tick(); assert.equal(f.page.isCheckingPayment, true); assert.equal(f.page.paymentSucceeded, false)
    f.queries[1].resolve(row(1)); await newer
    assert.equal(f.page.paymentSucceeded, false); assert.equal(f.page.displayedOrderState, 1)
    assert.equal(f.page.paymentResultUnconfirmed, false)
    const old = f.page.confirmPaymentResult(), latest = f.page.confirmPaymentResult()
    f.queries[3].resolve(row(3)); await latest
    f.queries[2].reject(new Error('late failure')); await old
    assert.equal(f.page.paymentSucceeded, true); assert.equal(f.page.displayedOrderState, 3)
    assert.equal(f.page.paymentResultUnconfirmed, false)
  }
})

test('支付结果切换账号清空旧状态，所有查询固定凭证且迟到回应不读旧演示缓存', async () => {
  for (const failed of [false, true]) {
    const f = fixture(); f.start(); await f.finish(row(2))
    const old = f.page.confirmPaymentResult()
    f.switchUser({ token: 'token-b' })
    assert.equal(f.page.paymentSucceeded, false); assert.equal(f.page.displayedOrderState, 0)
    assert.equal(f.queries.at(-1).token, 'token-b')
    const reads = f.demoReads.length
    if (failed) f.queries[1].reject(new Error('old failure')); else f.queries[1].resolve(row(2))
    await old
    assert.equal(f.demoReads.length, reads); assert.equal(f.page.isCheckingPayment, true)
    f.queries[2].reject(new Error('forbidden')); await tick()
    assert.equal(f.page.paymentResultUnconfirmed, true); assert.equal(f.page.paymentSucceeded, false)
    assert.deepEqual(f.queries.map(query => query.token), ['token-a', 'token-a', 'token-b'])
  }
})

test('支付结果离页重进和切换订单隔离旧请求，返回前台只刷新可见页面', async () => {
  for (const sameOrder of [false, true]) {
    const f = fixture(); f.start()
    f.page.aboutToDisappear?.()
    f.page.refreshAfterForeground?.(); assert.equal(f.queries.length, 1)
    const id = sameOrder ? 'order-a' : 'order-b'
    f.setParams([{ orderId: id, payResult: false }]); f.page.aboutToAppear()
    f.queries[0].resolve(row(2)); await tick()
    assert.equal(f.page.isCheckingPayment, true); assert.equal(f.page.paymentSucceeded, false)
    f.queries[1].resolve(row(1, id)); await tick()
    assert.equal(f.page.orderId, id); assert.equal(f.page.displayedOrderState, 1)
    f.page.refreshAfterForeground?.(); assert.equal(f.queries.length, 3)
    await f.finish(row(2, id)); assert.equal(f.page.paymentSucceeded, true)
  }
})

test('支付结果注销和缺失参数清空旧结果，资料更新不重复查询且监听前不接受旧会话', async () => {
  const f = fixture(); f.start(); await f.finish(row(2))
  f.switchUser({ token: 'token-a', nickname: 'new name' }); assert.equal(f.queries.length, 1)
  const old = f.page.confirmPaymentResult()
  f.page.user = { token: 'token-b' }
  f.queries[1].resolve(row(2)); await old
  assert.equal(f.page.paymentSucceeded, false)
  f.page.openOrderListOrCashier(); assert.equal(f.navigations.length, 0)
  f.switchUser({}); assert.equal(f.queries.length, 2)
  assert.equal(f.page.isCheckingPayment, false); assert.equal(f.page.paymentResultUnconfirmed, true)
  assert.equal(f.page.paymentSucceeded, false); assert.equal(f.page.displayedOrderState, 0)
  f.page.aboutToDisappear?.(); f.setParams([]); f.page.aboutToAppear()
  assert.equal(f.page.orderId, ''); assert.equal(f.page.paymentSucceeded, false)
  assert.equal(f.queries.length, 2)
})

test('只有已确认待付款且有权限的订单可继续支付，已付已取消和无权限均查看订单', async () => {
  for (const state of [1, 2, 3, 4, 5, 6]) for (const canPay of [false, true]) {
    const f = fixture(); f.setOverlay({ advancedState: 5 }); f.start(); await f.finish(row(state, 'order-a', canPay))
    assert.equal(f.page.displayedOrderState, state)
    assert.equal(f.page.paymentSucceeded, state >= 2 && state <= 5)
    f.page.openOrderListOrCashier()
    assert.equal(f.navigations[0].name, state === 1 && canPay ? 'pay' : 'orders', `state=${state} canPay=${canPay}`)
  }
})

test('演示兜底不把已取消当支付成功，服务端失败仍为待确认且错误订单结果不采用', async () => {
  for (const demoEnabled of [false, true]) for (const state of [2, 6]) {
    const f = fixture(); f.config.DEMO_ORDER_FLOW = demoEnabled; f.setOverlay({ advancedState: state })
    f.start(); f.queries[0].reject(new Error('offline')); await tick()
    assert.equal(f.page.paymentSucceeded, demoEnabled && state === 2)
    assert.equal(f.page.paymentResultUnconfirmed, !(demoEnabled && state === 2))
  }
  const f = fixture(); f.start(); await f.finish(row(2, 'different-order'))
  assert.equal(f.page.paymentSucceeded, false); assert.equal(f.page.paymentResultUnconfirmed, true)
})

test('确认中结果每两秒刷新，30秒后停止自动请求', async () => {
  const f = fixture(), confirming = row(1)
  confirming.paymentState = 'confirming'; confirming.paymentNotice = '正在确认付款结果，请勿重复付款'; confirming.canPay = false
  f.start(); await f.finish(confirming)
  for (let attempt = 1; attempt <= 15; attempt++) {
    f.timers.advance(2000); await tick()
    assert.equal(f.refreshes.length, attempt, `第 ${attempt} 次刷新`)
    assert.deepEqual([f.refreshes.at(-1).id, f.refreshes.at(-1).token], ['order-a', 'token-a'])
    f.refreshes.at(-1).resolve({ paymentState: 'confirming', canPay: false, countdown: 0 }); await tick()
    assert.equal(f.queries.length, 1)
  }
  assert.equal(f.page.paymentResultUnconfirmed, true)
  const refreshCount = f.refreshes.length
  f.timers.advance(10000); await tick()
  assert.equal(f.refreshes.length, refreshCount)
})

test('离开结果页后清除自动刷新，迟到刷新不能回写当前结果', async () => {
  const f = fixture(), confirming = row(1)
  confirming.paymentState = 'confirming'; confirming.paymentNotice = '正在确认付款结果，请勿重复付款'
  f.start(); await f.finish(confirming)
  f.timers.advance(2000); await tick()
  assert.equal(f.refreshes.length, 1)
  f.refreshes[0].resolve({}); await tick()
  const lateDetail = f.queries.at(-1)
  f.page.aboutToDisappear()
  f.timers.advance(10000); await tick()
  lateDetail.resolve({ ...row(2), paymentState: 'paid' }); await tick()
  assert.equal(f.refreshes.length, 1)
  assert.equal(f.page.paymentSucceeded, false)
})

test('切换账号后停止旧订单轮询，迟到刷新不能覆盖新账号结果', async () => {
  const f = fixture(), confirming = row(1)
  confirming.paymentState = 'confirming'
  f.start(); await f.finish(confirming)
  f.timers.advance(2000); await tick()
  const oldRefresh = f.refreshes[0]
  f.switchUser({ token: 'token-b' })
  assert.equal(f.queries.at(-1).token, 'token-b')
  oldRefresh.resolve({ paymentState: 'paid', paymentNotice: '旧账号结果' }); await tick()
  assert.notEqual(f.page.paymentState, 'paid')
  f.queries.at(-1).resolve({ ...confirming, paymentNotice: '新账号确认中' }); await tick()
  f.timers.advance(10000); await tick()
  assert.deepEqual(f.refreshes.map(refresh => refresh.token), ['token-a', 'token-b'])
})

test('确认中取消先展示退款二次确认，取消弹窗不发起取消请求', async () => {
  const f = fixture(), confirming = row(1)
  Object.assign(confirming, { paymentState: 'confirming', paymentNotice: '正在确认付款结果，请勿重复付款', canCancel: true, payMoney: 24.5 })
  f.start(); await f.finish(confirming)
  for (let attempt = 0; attempt < 15; attempt++) {
    f.timers.advance(2000); await tick()
    f.refreshes.at(-1).resolve({ paymentState: 'confirming', canCancel: true }); await tick()
    f.queries.at(-1).resolve(confirming); await tick()
  }
  f.page.requestCancelOrder()
  assert.equal(f.dialogs.length, 1)
  assert.equal(f.dialogs[0].message, '付款可能已经成功。取消后，如已扣款，¥24.50将原路退回付款账户。确定取消吗？')
  f.dialogs[0].primaryButton.action()
  assert.deepEqual(f.cancellations, [])
  f.dialogs[0].secondaryButton.action(); await tick()
  assert.deepEqual(f.cancellations, [])
  f.page.requestCancelOrder()
  f.dialogs[1].secondaryButton.action(); await tick()
  assert.deepEqual(f.cancellations, ['order-a'])
})

test('取消后的确认中付款显示服务端退款提示，核实和退款终态提示原样展示', async () => {
  for (const [state, paymentState, notice] of [
    [6, 'confirming', '订单已取消。如已扣款，确认后将原路退款。'],
    [1, 'review', '我们正在核实这笔付款。'],
    [2, 'paid', '多付的 ¥19.00 已退回付款账户'],
  ]) {
    const f = fixture(); f.start()
    await f.finish({ ...row(state), paymentState, paymentNotice: notice, canPay: false })
    assert.equal(f.page.getPaymentResultHint(), notice)
    if (state === 6) {
      assert.equal(f.page.getPaymentResultTitle(), '订单已取消')
      assert.equal(f.page.getPageTitle(), '订单已取消')
    }
  }
})

test('旧取消响应不能触发新订单查询或重启轮询', async () => {
  const f = fixture(), gate = deferred()
  f.start(); await f.finish({ ...row(), paymentState: 'confirming', canCancel: true })
  f.setCancel(() => gate.promise)
  f.page.requestCancelOrder(); f.dialogs[0].secondaryButton.action()
  f.page.aboutToDisappear(); f.setParams([{ orderId: 'order-b' }]); f.start()
  await f.finish({ ...row(2, 'order-b'), paymentState: 'paid' })
  const count = f.queries.length
  gate.resolve(row(6)); await tick()
  assert.equal(f.queries.length, count)
  assert.equal(f.page.paymentSucceeded, true)
  f.timers.advance(32000); await tick()
  assert.equal(f.refreshes.length, 0)
})

test('换订单立即清除旧定时器，旧刷新返回不能覆盖新订单', async () => {
  const f = fixture(); f.start(); await f.finish({ ...row(), paymentState: 'confirming' })
  f.timers.advance(2000); await tick()
  const oldTimers = f.timers.ids()
  f.setParams([{ orderId: 'order-b' }]); f.page.aboutToAppear()
  assert.ok(oldTimers.every(id => !f.timers.ids().includes(id)))
  assert.equal(f.timers.size(), 1)
  assert.equal(f.queries.at(-1).id, 'order-b')
  await f.finish({ ...row(2, 'order-b'), paymentState: 'paid' })
  f.refreshes[0].resolve({ paymentState: 'review', paymentNotice: '旧订单' }); await tick()
  assert.equal(f.page.paymentState, 'paid')
  f.timers.advance(32000); await tick()
  assert.equal(f.refreshes.length, 1)
})

test('30秒后的手动刷新可替换挂起请求，自动刷新不再启动', async () => {
  const f = fixture(); f.start(); await f.finish({ ...row(), paymentState: 'confirming' })
  f.timers.advance(30000); await tick()
  assert.equal(f.page.automaticRefreshExpired, true)
  assert.equal(f.page.getPaymentResultHint(), '付款结果仍在确认中，可能需要几分钟。不会重复扣款，确认后订单会自动更新。')
  f.page.refreshPaymentStatus(true); await tick()
  assert.equal(f.refreshes.length, 2)
  f.refreshes[1].resolve({ paymentState: 'paid' }); await tick()
  await f.finish({ ...row(2), paymentState: 'paid' })
  f.refreshes[0].resolve({ paymentState: 'confirming' }); await tick()
  assert.equal(f.page.paymentSucceeded, true)
  f.timers.advance(32000); await tick(); assert.equal(f.refreshes.length, 2)
})

test('B-41/B-54：确认结果失败恢复支付入口，重进确认中后成功则停止刷新', async () => {
  for (const succeeded of [false, true]) {
    const f = fixture(); f.start(); await f.finish({ ...row(), canPay: false, paymentState: 'confirming' })
    f.page.aboutToDisappear(); f.start()
    await f.finish({ ...row(), canPay: false, paymentState: 'confirming' })
    assert.equal(f.page.shouldOpenCashier(), false)
    f.timers.advance(2000); await tick()
    f.refreshes[0].resolve({ paymentState: succeeded ? 'paid' : 'none', canPay: !succeeded }); await tick()
    const notice = succeeded ? '' : '付款未成功，未扣款。可以重新付款。'
    await f.finish({ ...row(succeeded ? 2 : 1, 'order-a', !succeeded), paymentState: succeeded ? 'paid' : 'none', paymentNotice: notice })
    assert.equal(f.page.paymentSucceeded, succeeded)
    assert.equal(f.page.shouldOpenCashier(), !succeeded)
    if (!succeeded) assert.equal(f.page.getPaymentResultHint(), notice)
    f.timers.advance(32000); await tick(); assert.equal(f.refreshes.length, 1)
  }
})

test('演示开关保留旧网络提示和手动查询，不启动新支付轮询', async () => {
  const f = fixture(); f.config.DEMO_ORDER_FLOW = true; f.start()
  assert.equal(f.page.getPaymentResultHint(), '正在确认支付结果…')
  f.queries[0].reject(new Error('offline')); await tick()
  assert.equal(f.page.getPaymentResultHint(), '网络开小差了，请稍后在订单列表查看状态')
  f.timers.advance(32000); await tick(); assert.equal(f.refreshes.length, 0)
})

test('初次订单查询挂起也从进入页面计时，迟到详情不覆盖刷新成功', async () => {
  const f = fixture(); f.start()
  const initial = f.queries[0]
  f.timers.advance(2000); await tick()
  assert.equal(f.refreshes.length, 1)
  f.refreshes[0].resolve({ paymentState: 'paid' }); await tick()
  await f.finish({ ...row(2), paymentState: 'paid' })
  initial.resolve({ ...row(), paymentState: 'confirming' }); await tick()
  assert.equal(f.page.paymentSucceeded, true)
  assert.equal(f.timers.size(), 0)
})

test('刷新接口未提供金额时不弹出零元退款确认，详情到达后使用真实金额', async () => {
  const f = fixture(); f.start(); f.timers.advance(30000); await tick()
  f.refreshes[0].resolve({ paymentState: 'confirming', canCancel: true }); await tick()
  f.page.requestCancelOrder(); assert.equal(f.dialogs.length, 0)
  await f.finish({ ...row(), paymentState: 'confirming', canCancel: true, payMoney: 24.5 })
  f.page.requestCancelOrder()
  assert.match(f.dialogs[0].message, /¥24\.50/)
})
