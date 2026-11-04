import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, execute, pageMethods, sourceOf, tick } from './native-harness.mjs'

const base = 'mixed-development-h5/features/cart/src/main/ets/presentation/'
const OrderState = { ALL_TAB: 0, AWAITING_PAYMENT: 1, AWAITING_SHIPMENT: 2, AWAITING_RECEIPT: 3,
  AWAITING_REVIEW: 4, COMPLETED: 5, CANCELLED: 6 }
const presentation = execute(sourceOf(base + 'utils/OrderPresentation.ets'), { models: { OrderState } })
const row = (state = 1, id = 'order-a', canPay = true) => ({ id, orderState: state, canPay, serverManaged: true })

function fixture() {
  let params = [{ orderId: 'order-a', payResult: true }], overlay = null
  const queries = [], navigations = [], demoReads = []
  const config = { DEMO_ORDER_FLOW: false }
  const Page = pageMethods(base + 'views/PayResultView.ets', 'PayResultView', {}, {
    ...presentation, GlobalVariable: config, PAGE_PATH: { PAY_RESULT_PAGE: 'result', PAY_PAGE: 'pay', ORDER_PAGE: 'orders' },
    getOrderDetailAPI: (id, token) => { const gate = deferred(); queries.push({ ...gate, id, token }); return gate.promise },
    demoOrderStore: { getOverlay: id => { demoReads.push(id); return overlay }, getEvaluation: () => null },
  })
  const page = new Page(); page.user = { token: 'token-a' }
  page.stackPath = { getParamByName: () => params, pushPath: path => navigations.push({ type: 'push', ...path }),
    replacePath: path => navigations.push({ type: 'replace', ...path }) }
  const start = () => page.aboutToAppear()
  const finish = async (value = row()) => { queries.at(-1).resolve(value); await tick() }
  const switchUser = user => { page.user = user; page.reloadForCurrentAccount?.() }
  return { page, queries, navigations, demoReads, config, start, finish, switchUser,
    setParams: value => { params = value }, setOverlay: value => { overlay = value } }
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
