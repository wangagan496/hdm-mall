import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf, deferred, tick, pageMethods } from './native-harness.mjs'
import { evaluationFixture } from './evaluation-harness.mjs'
const base = 'mixed-development-h5/'
test('评价资格慢查或失败不丢输入，退出再进恢复且账号与订单隔离', async () => {
  const f = evaluationFixture(), gate = deferred(); f.setLoad(() => gate.promise)
  const page = f.newPage(); page.aboutToAppear()
  page.content = '查询期间输入的评价'; page.setScore(4)
  gate.reject(new Error('offline')); await tick()
  assert.equal(page.loadFailed, true); assert.equal(page.content, '查询期间输入的评价')
  page.aboutToDisappear(); await tick()
  const restored = f.newPage(); restored.aboutToAppear(); await tick()
  assert.equal(restored.content, page.content); assert.equal(restored.score, 4)
  f.setOrderId('order-b'); const otherOrder = f.newPage(); otherOrder.aboutToAppear(); await tick(); assert.equal(otherOrder.content, '')
  f.setOrderId('order-a'); f.setUser({ id: 'b', token: 'b-token' }); const otherUser = f.newPage(); otherUser.aboutToAppear(); await tick(); assert.equal(otherUser.content, '')
})
test('已评价和无资格只提示，不跳走或清除用户草稿', async () => {
  const f = evaluationFixture(); f.setLoad(async () => ({ id: 'order-a', canEvaluate: false, evaluation: { score: 5, content: '旧评价' } }))
  const page = f.newPage(); page.aboutToAppear(); page.content = '未提交的新输入'; await tick()
  assert.match(page.errorText, /已评价/); assert.equal(f.navigations(), 0)
  await page.submitEvaluation(); assert.equal(f.submissions.length, 0)
  page.aboutToDisappear(); assert.equal(f.saved.size, 1)
})
test('评价回应丢失但服务端内容一致才确认成功和清理草稿', async () => {
  const f = evaluationFixture(), page = f.newPage(); page.aboutToAppear(); await tick()
  page.content = '这是本次提交评价'; page.saveDraft()
  f.setSubmit(async () => { throw new Error('response lost') })
  f.setLoad(async () => ({ id: 'order-a', evaluation: { score: 5, content: page.content } }))
  await page.submitEvaluation()
  assert.equal(page.submitted, true); assert.equal(f.saved.size, 0); assert.equal(f.navigations(), 1)
  assert.equal(f.submissions[0][2], 'a-token')
})
test('不同评价不冒充本次成功，换会话不能提交旧草稿，写盘失败有反馈', async () => {
  const f = evaluationFixture(), page = f.newPage(); page.aboutToAppear(); await tick()
  page.content = '本次未成功的评价'; page.saveDraft()
  f.setSubmit(async () => { throw new Error('not confirmed') }); f.setLoad(async () => ({ evaluation: { score: 1, content: '别的评价' } }))
  await page.submitEvaluation(); assert.equal(page.submitted, false); assert.equal(f.saved.size, 1); assert.equal(f.navigations(), 0)
  f.failFlush(); page.saveDraft(); await tick(); assert.ok(f.messages.some(text => text.includes('草稿保存失败')))
  const messages = f.messages.length
  f.setUser({ id: 'b', token: 'b-token' }); await page.submitEvaluation(); assert.equal(f.submissions.length, 1)
  assert.match(page.errorText, /登录状态/)
  page.saveDraft(); await tick(); assert.equal(f.messages.length, messages)
})

const states = { ALL_TAB: 0, AWAITING_PAYMENT: 1, AWAITING_SHIPMENT: 2, AWAITING_RECEIPT: 3, AWAITING_REVIEW: 4, COMPLETED: 5, CANCELLED: 6 }
const presentation = execute(sourceOf(base + 'features/cart/src/main/ets/presentation/utils/OrderPresentation.ets'), { models: { OrderState: states } })
const inTab = presentation.isOrderStateInTab
const tabLogic = execute(sourceOf(base + 'features/cart/src/main/ets/presentation/utils/OrderTabLoader.ets'), { './OrderPresentation': { isOrderStateInTab: inTab } })
function orderFixture() {
  let clock = 10000, fetch = async () => ({ items: [], pages: 0 })
  const messages = []
  const Page = pageMethods(base + 'features/cart/src/main/ets/presentation/views/OrderView.ets', 'OrderView', {}, {
    OrderState: states, isOrderStateInTab: inTab, readPhoneClockMillis: () => clock,
    secondsLeftToPay: (remaining, baseline) => Math.max(0, remaining - Math.floor((clock - baseline) / 1000)),
    ...tabLogic, getOrderListAPI: params => fetch(params), orderCancellation: { pendingIds: () => [] },
  })
  const page = new Page(); page.user = { token: 'a' }; page.safeToast = message => messages.push(message)
  page.sessionToken = 'a'; page.loadedToken = 'a'
  return { page, messages, setFetch: fn => { fetch = fn }, advance: millis => { clock += millis } }
}
test('订单操作原地替换或移出栏目，缺失返回才回退刷新', async () => {
  const f = orderFixture(); f.page.orders = [{ id: 'a', orderState: 3, skus: [], countdown: 0 }, { id: 'b', orderState: 3, skus: [], countdown: 0 }]
  f.page.selectedState = 3; f.page.loadedState = 3; f.page.page = 3
  await f.page.runOrderAction('a', 'receipt', async () => ({ id: 'a', orderState: 4, skus: [], countdown: 0 }), 'ok')
  assert.deepEqual(Array.from(f.page.orders, row => row.id), ['b']); assert.equal(f.page.page, 2)
  f.page.selectedState = 0; f.page.loadedState = 0
  await f.page.runOrderAction('b', 'remind', async () => ({ id: 'b', orderState: 3, skus: [], countdown: 0, updated: true }), 'ok')
  assert.equal(f.page.orders[0].updated, true)
  let reloads = 0; f.page.reloadOrders = async () => { reloads++ }
  await f.page.runOrderAction('b', 'remind', async () => ({ id: 'b' }), 'ok'); assert.equal(reloads, 1)
})
test('待付款栏目取消后重读边界页，追加去重不漏单，旧翻页不会复活已取消订单', async () => {
  const f = orderFixture()
  f.page.selectedState = 1; f.page.loadedState = 1
  const orders = Array.from({ length: 21 }, (_, i) => ({ id: String(30 - i), orderState: 1, skus: [], countdown: 90, createTime: '2026-10-28' }))
  f.page.orders = orders.slice(0, 20); f.page.page = 3; f.page.countdownBaseAt = 10000
  const stale = deferred(); f.setFetch(() => stale.promise); const loading = f.page.loadMore()
  f.advance(5000)
  await f.page.runOrderAction('30', 'cancel', async () => ({ ...orders[0], orderState: 6 }), 'ok')
  stale.resolve({ items: orders.slice(20), pages: 3 }); await loading
  assert.equal(f.page.orders.length, 19); assert.equal(f.page.page, 2)
  const current = orders.slice(1)
  f.setFetch(async params => ({ items: current.slice((params.page - 1) * params.pageSize, params.page * params.pageSize), pages: 2 }))
  await f.page.loadMore()
  assert.equal(f.page.orders.length, 20); assert.equal(new Set(f.page.orders.map(order => order.id)).size, 20)
  assert.ok(f.page.orders.some(order => order.id === '10')); assert.ok(!f.page.orders.some(order => order.id === '30'))
  assert.equal(f.page.orders.find(order => order.id === '29').countdown, 85)
})
test('持久会话立即更新并串行落盘，旧资料不能盖掉正在保存的新登录', async () => {
  const saved = new Map(), flushes = []
  const pref = { putSync: (key, value) => saved.set(key, value), getSync: (key, fallback) => saved.get(key) ?? fallback,
    flush: () => { const gate = deferred(); flushes.push(gate); return gate.promise } }
  const { StoreManager } = execute(sourceOf(base + 'commons/storage/src/main/ets/StoreManager.ets'), {
    constants: { GlobalVariable: { USER_INFO_KEY: 'user' } }, '@kit.ArkData': { preferences: { getPreferencesSync: () => pref } },
  })
  const store = new StoreManager(); store.ctx = {}
  const first = store.saveUserInfo({ token: 'a' }); await tick()
  const newer = store.saveUserInfo({ token: 'b' })
  await assert.rejects(store.saveProfileForSession({ token: 'a', nickname: 'old' }, 'a'), /登录状态/)
  assert.equal(store.getUserInfo().token, 'b'); assert.equal(flushes.length, 1)
  flushes[0].resolve(); await first; await tick(); assert.equal(flushes.length, 2)
  flushes[1].resolve(); await newer
  assert.equal(store.getUserInfo().token, 'b')
})
