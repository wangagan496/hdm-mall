import { emptyCancelActions, cancelActionFailure } from './cancel-boundaries.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, execute, pageMethods, sourceOf, tick } from './native-harness.mjs'

const base = 'mixed-development-h5/'
const states = { ALL_TAB: 0, AWAITING_PAYMENT: 1, AWAITING_SHIPMENT: 2, AWAITING_RECEIPT: 3, AWAITING_REVIEW: 4, CANCELLED: 6 }
const presentation = execute(sourceOf(base + 'features/cart/src/main/ets/presentation/utils/OrderPresentation.ets'), { models: { OrderState: states } })
const inTab = presentation.isOrderStateInTab
const loader = execute(sourceOf(base + 'features/cart/src/main/ets/presentation/utils/OrderTabLoader.ets'), {
  './OrderPresentation': { isOrderStateInTab: inTab },
})

test('全部分页把已取消订单计入一屏，末页和状态筛选后的拼页不提前结束', async () => {
  const calls = []
  const pages = [[row('cancelled', 6), row('pending', 1)], [row('last', 6)]]
  const api = { isCurrent: () => true, getPage: async params => {
    calls.push(params.page); return { items: pages[params.page - 1] || [], pages: 2 }
  } }
  const first = await loader.loadOrderTabPage({ page: 1, pageSize: 2, state: 0 }, api)
  assert.deepEqual(calls, [1])
  assert.equal(first.items.length, 2); assert.equal(first.nextPage, 2); assert.equal(first.finished, false)
  const last = await loader.loadOrderTabPage({ page: first.nextPage, pageSize: 2, state: 0 }, api)
  assert.deepEqual(Array.from(last.items, item => item.id), ['last'])
  assert.equal(last.finished, true)
  const merged = loader.mergeOrdersForTab(first.items, [row('pending', 6), ...last.items], { state: 0 })
  assert.equal(merged.length, 3); assert.ok(merged.every(item => item.orderState === 6))
  calls.length = 0
  const filtered = await loader.loadOrderTabPage({ page: 1, pageSize: 2, state: 1 }, api)
  assert.deepEqual(calls, [1, 2]); assert.equal(filtered.items.length, 1); assert.equal(filtered.finished, true)
})

function row(id, state = 1) {
  return { id, orderState: state, skus: [], countdown: 0, createTime: id }
}

function fixture() {
  let fetch = async () => ({ items: [], pages: 0 })
  const messages = []
  const Page = pageMethods(base + 'features/cart/src/main/ets/presentation/views/OrderView.ets', 'OrderView', {}, {
    cancelActions: emptyCancelActions, cancelActionFailure,
    GlobalVariable: { APP_FOREGROUND_SEQUENCE: 'foreground', USER_INFO_KEY: 'user' },
    PAGE_PATH: { ORDER_PAGE: 'orders', PAY_PAGE: 'pay' },
    OrderState: states,
    isOrderStateInTab: inTab,
    readPhoneClockMillis: () => 0,
    secondsLeftToPay: remaining => remaining,
    ...loader,
    getOrderListAPI: params => fetch(params),
    orderCancellation: { pendingIds: () => [] },
  })
  const page = new Page()
  page.user = { token: 'buyer-a' }
  page.safeToast = message => messages.push(message)
  page.stackPath = { getParamByName: () => [], pushPath() {}, pop() {} }
  return { page, messages, setFetch: fn => { fetch = fn } }
}

test('同一账号刷新保留订单，失败显示重试而不是空列表，成功才替换', async () => {
  const f = fixture()
  f.setFetch(async () => ({ items: [row('old')], pages: 1 }))
  await f.page.reloadOrders()
  f.page.isFinished = true
  const failed = deferred()
  f.setFetch(() => failed.promise)
  const reload = f.page.reloadOrders()
  assert.deepEqual(Array.from(f.page.orders, order => order.id), ['old'])
  failed.reject(new Error('offline'))
  await reload
  assert.deepEqual(Array.from(f.page.orders, order => order.id), ['old'])
  assert.equal(f.page.loadFailed, true)
  const fresh = deferred()
  f.setFetch(() => fresh.promise)
  const retry = f.page.reloadOrders()
  fresh.resolve({ items: [row('new')], pages: 1 })
  await retry
  assert.deepEqual(Array.from(f.page.orders, order => order.id), ['new'])
  assert.equal(f.page.loadFailed, false)
})

test('换账号刷新先清空旧订单，旧回应不能覆盖新账号列表', async () => {
  const f = fixture()
  f.page.orders = [row('account-a')]
  f.page.isFinished = true
  const old = deferred()
  f.setFetch(() => old.promise)
  const first = f.page.reloadOrders()
  f.page.user = { token: 'buyer-b' }
  const current = deferred()
  f.setFetch(() => current.promise)
  const second = f.page.reloadOrders()
  assert.equal(f.page.orders.length, 0)
  current.resolve({ items: [row('account-b')], pages: 1 })
  await second
  old.resolve({ items: [row('late-a')], pages: 1 })
  await first
  assert.deepEqual(Array.from(f.page.orders, order => order.id), ['account-b'])
  assert.equal(f.page.loadFailed, false)
})

test('同一账号刷新期间旧请求结束不关闭新加载状态', async () => {
  const f = fixture()
  f.page.orders = [row('old')]
  const first = deferred(), second = deferred()
  let calls = 0
  f.setFetch(() => ++calls === 1 ? first.promise : second.promise)
  const old = f.page.reloadOrders()
  const current = f.page.reloadOrders()
  first.resolve({ items: [row('stale')], pages: 1 })
  await old
  assert.equal(f.page.loading, true)
  second.resolve({ items: [row('current')], pages: 1 })
  await current
  assert.equal(f.page.loading, false)
  assert.equal(f.page.orders[0].id, 'current')
})

test('切换栏目立即移除其他栏目订单，失败重试不混入旧列表', async () => {
  const f = fixture()
  f.setFetch(async () => ({ items: [row('unpaid', 1)], pages: 1 }))
  await f.page.reloadOrders()
  const pending = deferred()
  f.setFetch(() => pending.promise)
  f.page.selectTab(3)
  assert.equal(f.page.selectedState, 3)
  assert.equal(f.page.orders.length, 0)
  pending.reject(new Error('offline'))
  await tick()
  assert.equal(f.page.loadFailed, true)
  assert.equal(f.page.orders.length, 0)
  const requests = []
  f.setFetch(async params => {
    requests.push({ ...params })
    return { items: [row('awaiting-receipt', 3)], pages: 1 }
  })
  await f.page.loadMore()
  assert.deepEqual(requests, [{ page: 1, pageSize: 10, orderState: 3 }])
  assert.deepEqual(Array.from(f.page.orders, order => order.id), ['awaiting-receipt'])
})

test('刷新失败后列表内重试替换第一页，再翻页追加且不复活旧订单', async () => {
  const f = fixture()
  const oldRows = Array.from({ length: 10 }, (_, i) => row(`old-${i}`))
  f.setFetch(async () => ({ items: oldRows, pages: 2 }))
  await f.page.reloadOrders()
  f.setFetch(async () => { throw new Error('offline') })
  await f.page.reloadOrders()
  assert.equal(f.page.orders.length, 10)
  const requests = []
  const newRows = Array.from({ length: 10 }, (_, i) => row(`new-${i}`))
  f.setFetch(async params => {
    requests.push(params.page)
    return { items: params.page === 1 ? newRows : [row('next-page')], pages: 2 }
  })
  await f.page.loadMore()
  assert.equal(f.page.orders.length, 10)
  assert.ok(f.page.orders.every(order => order.id.startsWith('new-')))
  await f.page.loadMore()
  assert.deepEqual(requests, [1, 2])
  assert.equal(f.page.orders.length, 11)
  assert.equal(f.page.isFinished, true)
})

test('同栏目刷新确认空结果后清除保留列表，其他栏目迟到响应不覆盖当前页', async () => {
  const f = fixture()
  f.setFetch(async () => ({ items: [row('unpaid', 1)], pages: 1 }))
  await f.page.reloadOrders()
  const pending = deferred()
  f.setFetch(() => pending.promise)
  const old = f.page.reloadOrders()
  assert.equal(f.page.orders.length, 1)
  f.setFetch(async () => ({ items: [row('receipt', 3)], pages: 1 }))
  f.page.selectTab(3)
  await tick()
  pending.resolve({ items: [], pages: 0 })
  await old
  assert.equal(f.page.orders[0].id, 'receipt')
  assert.equal(f.page.loading, false)
  f.setFetch(async () => ({ items: [], pages: 0 }))
  await f.page.reloadOrders()
  assert.equal(f.page.orders.length, 0)
  assert.equal(f.page.isFinished, true)
  assert.equal(f.page.loadFailed, false)
})
