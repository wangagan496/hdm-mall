import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf, deferred, tick } from './native-harness.mjs'
const source = sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/utils/OrderCancellation.ets')
function fixture() {
  let user = { id: 'a', token: 'token-a' }, state = 1
  const saved = new Map(), reads = [], writes = [], delays = []
  let read = async () => ({ id: 'order', orderState: state, skus: [] })
  let cancel = async () => { state = 6; return read() }
  const store = { getSync: (key, fallback) => saved.get(key) ?? fallback,
    putSync: (key, value) => saved.set(key, value), flush: async () => {} }
  const { OrderCancellation } = execute(source, {
    storage: { auth: { getUserInfo: () => user }, storeManager: { getStore: () => store } },
    network: { RequestAxios: { getForSession: async (url, token) => { reads.push(token); return read(url) } } },
    '../../data/api/cart': { cancelOrderWithFallback: async (id, token) => { writes.push(token); return cancel(id) } },
    './OrderPresentation': { OrderState: { AWAITING_PAYMENT: 1, CANCELLED: 6 } },
  }, { setTimeout: (callback, delay) => { delays.push(delay); queueMicrotask(callback); return 1 } })
  return { manager: new OrderCancellation(), saved, reads, writes, delays,
    setState: value => { state = value }, setUser: value => { user = value },
    setRead: fn => { read = fn }, setCancel: fn => { cancel = fn }, store }
}
test('取消回应丢失时先查询确认，库存操作不重复提交', async () => {
  const f = fixture()
  f.setCancel(async () => { f.setState(6); throw new Error('response lost') })
  assert.equal((await f.manager.confirm('order')).orderState, 6)
  assert.equal(f.writes.length, 1)
  assert.equal(f.reads.length, 2)
  assert.equal(f.manager.pendingIds().length, 0)
})
test('未到达服务器的取消最多重试三次，保留未知状态和恢复意图', async () => {
  const f = fixture(); f.setCancel(async () => { throw new Error('offline') })
  await assert.rejects(f.manager.confirm('order'), /待确认/)
  assert.equal(f.writes.length, 3)
  assert.deepEqual(f.delays, [500, 1000])
  assert.equal(f.manager.pendingIds()[0], 'order')
  f.setState(6)
  assert.equal((await f.manager.confirm('order', true)).orderState, 6)
  assert.equal(f.writes.length, 3)
})
test('重试前已付款或服务器明确拒绝，立即停止并清除意图', async () => {
  const paid = fixture()
  paid.setCancel(async () => { paid.setState(2); throw new Error('response lost') })
  await assert.rejects(paid.manager.confirm('order'), /状态已变化/)
  assert.equal(paid.writes.length, 1)
  assert.equal(paid.manager.pendingIds().length, 0)
  const refused = fixture()
  refused.setCancel(async () => { throw Object.assign(new Error('refused'), { response: { status: 403 } }) })
  await assert.rejects(refused.manager.confirm('order'), /拒绝/)
  assert.equal(refused.writes.length, 1)
  assert.equal(refused.delays.length, 0)
})
test('连续点击复用一个任务；只有已保存意图才能恢复取消', async () => {
  const f = fixture(), wait = deferred()
  f.setCancel(() => wait.promise)
  const one = f.manager.confirm('order'), two = f.manager.confirm('order')
  assert.equal(one, two)
  await tick(); assert.equal(f.writes.length, 1)
  wait.resolve({ id: 'order', orderState: 6, skus: [] }); await one
  await assert.rejects(f.manager.confirm('ordinary-order', true), /没有待确认/)
  assert.equal(f.writes.length, 1)
})
test('会话变化后不再取消，旧意图不能串入新账号', async () => {
  const f = fixture(), wait = deferred(); f.setRead(() => wait.promise)
  const running = f.manager.confirm('order'); await tick()
  f.setUser({ id: 'b', token: 'token-b' })
  wait.resolve({ id: 'order', orderState: 1, skus: [] })
  await assert.rejects(running, /登录状态已变化/)
  assert.equal(f.writes.length, 0)
  assert.equal(f.manager.pendingIds().length, 0)
  assert.equal(JSON.parse(f.saved.get('cancel-intents:a'))[0], 'order')
})
test('持久化失败不发送取消，持续断网查询也有次数上限', async () => {
  const f = fixture(); f.store.flush = async () => { throw new Error('disk') }
  await assert.rejects(f.manager.confirm('order'), /disk/)
  assert.equal(f.writes.length, 0)
  const offline = fixture(); offline.setRead(async () => { throw new Error('offline') })
  await assert.rejects(offline.manager.confirm('order'), /待确认/)
  assert.equal(offline.reads.length, 4)
  assert.equal(offline.writes.length, 0)
})
