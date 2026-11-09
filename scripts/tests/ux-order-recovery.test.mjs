import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageMethods, tick, deferred } from './native-harness.mjs'
const base = 'mixed-development-h5/features/cart/src/main/ets/presentation/views/'
function fixture(detail = false) {
  const timers = new Map(), queries = [], writes = []; let timer = 0
  const P = pageMethods(base + (detail ? 'OrderDetailView.ets' : 'OrderView.ets'), detail ? 'OrderDetailView' : 'OrderView', {}, {
    OrderState: { ALL_TAB: 0 }, setTimeout: (fn, delay) => { timers.set(++timer, {fn, delay}); return timer }, clearTimeout: id => timers.delete(id),
    getOrderDetailAPI: (id, token) => { const d = deferred(); queries.push({id, token, ...d}); return d.promise },
    orderCancellation: { pendingIds: () => [], inspectPending: async () => {}, confirm: () => writes.push('cancel') },
    cancelActions: { pending: () => [], inspectPending: async () => {}, recover: () => writes.push('recover') },
    isOrderStateInTab: () => true, readPhoneClockMillis: () => 0,
  })
  const p = new P(); p.user = {token:'a'}; p.sessionToken = 'a'; p.detailToken = 'a'; p.orderId = 'o'; p.detailOrderId = 'o'; p.loading = false
  p.orders = [{id:'o',orderState:3}]; p.order = p.orders[0]; p.pendingReceipts = ['o']; p.receiptPending = true
  p.updateOrderStatusAndEvaluation = () => {}; p.safeToast = () => {}
  return {p, timers, queries, writes, fire: async () => { const [id, job] = timers.entries().next().value; timers.delete(id); job.fn(); await tick(); return job.delay }}
}
test('UX15 列表按订单自动核对，不重发收货，有上限且横幅去重', async () => {
  const f = fixture(); f.p.schedulePendingChecks(); f.p.schedulePendingChecks()
  assert.equal(f.timers.size, 1); assert.deepEqual(Array.from(f.p.pendingOrderIds()), ['o'])
  const delays = []
  for (let i=0;i<6;i++) { delays.push(await f.fire()); assert.equal(f.queries.at(-1).id, 'o'); f.queries.at(-1).reject(new Error('offline')); await tick() }
  assert.deepEqual(delays,[2000,5000,10000,20000,30000,60000]); assert.equal(f.timers.size,0); assert.equal(f.writes.length,0)
  assert.equal(f.p.isCheckingOrder('o'),false); assert.equal(f.p.pendingReceipts.length,1)
})
test('UX15 查询未确认前列表仍锁定，定向详情确认后释放；离页旧响应无效', async () => {
  for (const detail of [false,true]) for (const hidden of [false,true]) {
    const f=fixture(detail); f.p.schedulePendingChecks(); await f.fire()
    if(hidden) detail ? f.p.hideOrderDetail() : f.p.hideOrders()
    f.queries[0].resolve({id:'o',orderState:4,skus:[]}); await tick()
    assert.equal(detail ? f.p.receiptPending : f.p.pendingReceipts.length > 0,hidden)
    assert.equal(f.timers.size,0); assert.equal(f.writes.length,0)
  }
})
test('UX15 定向查询的旧结果不能覆盖之后刷新的订单', async () => {
 for (const detail of [false,true]) {
  const f=fixture(detail);f.p.schedulePendingChecks();await f.fire()
  if(detail) f.p.querySequence++; else f.p.requestGeneration++
  const newer={id:'o',orderState:5,skus:[]};f.p.order=newer;f.p.orders=[newer]
  f.queries[0].resolve({id:'o',orderState:3,skus:[]});await tick()
  assert.equal((detail?f.p.order:f.p.orders[0]).orderState,5)
  assert.equal(detail?f.p.receiptPending:f.p.pendingReceipts.length>0,true)
  f.p.stopPendingChecks()
 }
})
