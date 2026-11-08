import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageMethods, tick } from './native-harness.mjs'

function fixture(registerFails = false) {
  const timers = new Map(), queries = [], paths = [], writes = []
  let timerId = 0, registered = 0, unregistered = 0, callback, cleared = false
  let lookup = async () => { throw { httpStatus: 404 } }
  const monitor = {
    on: (event, handler) => { assert.equal(event, 'netAvailable'); callback = handler },
    register: done => { registered++; done(registerFails ? { code: 201 } : undefined) },
    unregister: done => { unregistered++; done?.() },
  }
  const Page = pageMethods('mixed-development-h5/features/cart/src/main/ets/presentation/views/CheckView.ets', 'CheckView', {}, {
    CheckoutSheet: { None: 0 }, GlobalVariable: { DEMO_ORDER_FLOW: false },
    util: { generateRandomUUID: () => 'new-key' },
    connection: { createNetConnection: () => monitor },
    storeManager: { getPendingOrder: () => cleared ? null : { requestKey: 'original', accountId: 'buyer' },
      clearPendingOrder: async () => { cleared = true } },
    getOrderByRequestAPI: (key, token) => { queries.push({ key, token }); return lookup() },
    createOrderAPI: request => writes.push(request), checkoutFailure: error => ({ status: error.httpStatus || 0 }),
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId },
    clearTimeout: id => timers.delete(id),
    emitter: { off() {} }, BusinessVariable: {}, authCart: { updateCartCount: async () => {} },
    AppStorage: { setOrCreate() {} }, PAGE_PATH: { PAY_PAGE: 'pay' },
  })
  const page = new Page(); page.user = { id: 'buyer', token: 'token' }
  page.checkoutAccountId = 'buyer'; page.checkoutToken = 'token'
  page.stackPath = { replacePath: path => paths.push(path), clear() {} }; page.safeToast = () => {}
  return { page, queries, timers, paths, writes, registered: () => registered, unregistered: () => unregistered,
    callback: () => callback(), cleared: () => cleared, lookup: fn => { lookup = fn },
    fireTimer: async () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); await tick() } }
}

test('临时404保留原请求，有限退避只查询且用尽后保留手动入口', async () => {
  const f = fixture()
  await f.page.confirmPendingOrder()
  assert.equal(f.cleared(), false)
  assert.equal(f.page.confirmingOrder, true)
  assert.equal(f.registered(), 1)
  const delays = []
  while (f.timers.size) { delays.push([...f.timers.values()][0].delay); await f.fireTimer(); assert.ok(delays.length <= 3) }
  assert.deepEqual(delays, [1000, 3000, 8000])
  assert.equal(f.queries.length, 4)
  assert.ok(f.queries.every(query => query.key === 'original'))
  assert.equal(f.page.confirmationExhausted, true)
  assert.equal(f.writes.length, 0)
})

test('网络恢复只查原订单，确认完成注销监听并取消退避', async () => {
  const f = fixture(); await f.page.confirmPendingOrder()
  f.lookup(async () => ({ id: 'existing', orderState: 1 }))
  f.callback(); await tick()
  assert.equal(f.queries.length, 2)
  assert.equal(f.writes.length, 0)
  assert.equal(f.cleared(), true)
  assert.equal(f.unregistered(), 1)
  assert.equal(f.timers.size, 0)
  assert.equal(f.paths[0].param, 'existing')
})

test('监听注册失败降级到有限退避与回前台查询，不抛错不重复注册', async () => {
  const f = fixture(true); await f.page.confirmPendingOrder()
  assert.equal(f.timers.size, 1)
  await f.fireTimer()
  f.page.refreshAfterForeground(); await tick()
  assert.equal(f.queries.length, 3)
  assert.equal(f.registered(), 1)
  assert.equal(f.writes.length, 0)
})

test('离页或换账号注销，迟到网络回调与计时器不再查询', async () => {
  for (const transition of ['leave', 'account']) {
    const f = fixture(); await f.page.confirmPendingOrder()
    const lateTimer = [...f.timers.values()][0].callback
    if (transition === 'leave') f.page.aboutToDisappear()
    else { f.page.user = { id: 'other', token: 'other' }; f.page.synchronizeCheckoutAccount() }
    f.callback(); lateTimer(); await tick()
    assert.equal(f.queries.length, 1)
    assert.equal(f.unregistered(), 1)
    assert.equal(f.timers.size, 0)
    assert.equal(f.cleared(), false)
  }
})
