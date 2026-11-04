import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, execute, sourceOf, tick } from './native-harness.mjs'

const item = id => ({ id, name: id, desc: '', price: '19', picture: 'picture', orderNum: 0, updatedAt: 1 })
const ids = values => Array.from(values, value => value.id)
function fixture() {
  let user = { account: 'a', token: 'a-token' }, flush = async () => {}
  const values = new Map(), puts = []
  const store = { getSync: (key, fallback) => values.get(key) ?? fallback,
    putSync: (key, value) => { puts.push(key); values.set(key, value) }, deleteSync: key => values.delete(key), flush: () => flush() }
  const auth = { getUserInfo: () => user }
  const scope = execute(sourceOf('mixed-development-h5/commons/storage/src/main/ets/AccountScope.ets'), { './Auth': { auth } })
  const { LocalGoodsStore } = execute(sourceOf('mixed-development-h5/commons/storage/src/main/ets/LocalGoodsStore.ets'), {
    './Auth': { auth }, './AccountScope': scope, './StoreManager': { storeManager: { getStore: () => store } },
  })
  const local = new LocalGoodsStore()
  return { local, values, puts, store, setFlush: fn => { flush = fn }, setUser: value => { user = value } }
}

test('本地列表读取失败交由页面提示重试，商品收藏探测仍可降级', () => {
  const f = fixture(), read = f.store.getSync
  f.store.getSync = () => { throw new Error('storage unavailable') }
  assert.throws(() => f.local.getFavorites(), /storage unavailable/)
  assert.throws(() => f.local.getHistory(), /storage unavailable/)
  assert.equal(f.local.isFavorite('first'), false)
  f.store.getSync = read; f.values.set('favorite_goods_account_a', [item('first')])
  assert.deepEqual(ids(f.local.getFavorites()), ['first'])
  assert.equal(f.local.isFavorite('first'), true)
})

test('实际删除或清空写盘失败后重新读取仍保留原收藏与足迹', async () => {
  for (const action of ['removeFavorite', 'removeHistory', 'clearHistory']) {
    const f = fixture(); f.values.set('favorite_goods_account_a', [item('first')])
    f.values.set('browse_history_account_a', [item('first')]); f.setFlush(async () => { throw new Error('disk') })
    await assert.rejects(() => f.local[action]('first'), /保存失败/)
    assert.equal(f.local.getFavorites().length, 1, action); assert.equal(f.local.getHistory().length, 1, action)
  }
})

test('本机收藏足迹写盘失败恢复原记录，返回列表不能提前修改存储', async () => {
  const f = fixture(); f.values.set('favorite_goods_account_a', [item('first')])
  f.values.set('browse_history_account_a', [item('first')])
  f.local.getFavorites().splice(0, 1); assert.equal(f.local.getFavorites().length, 1)
  f.local.getHistory().splice(0, 1); assert.equal(f.local.getHistory().length, 1)
  f.setFlush(async () => { throw new Error('disk') })
  for (const action of [() => f.local.removeFavorite('first'), () => f.local.toggleFavorite(item('first')),
    () => f.local.removeHistory('first'), () => f.local.clearHistory(), () => f.local.recordHistory(item('second'))]) {
    await assert.rejects(action, /保存失败/)
    assert.deepEqual(ids(f.local.getFavorites()), ['first'])
    assert.deepEqual(ids(f.local.getHistory()), ['first'])
  }
  f.setFlush(async () => {}); await f.local.removeFavorite('first'); await f.local.clearHistory()
  assert.equal(f.local.getFavorites().length, 0); assert.equal(f.local.getHistory().length, 0)
})

test('本机同类操作按顺序写入，失败后下一笔使用原数据且固定发起账号', async () => {
  const f = fixture(), first = deferred(); let flushes = 0
  f.values.set('favorite_goods_account_a', [item('first')]); f.setFlush(() => ++flushes === 1 ? first.promise : Promise.resolve())
  const removing = f.local.removeFavorite('first'); const failed = assert.rejects(removing, /保存失败/)
  const adding = f.local.toggleFavorite(item('second')); await tick()
  assert.equal(flushes, 1)
  f.setUser({ account: 'b', token: 'b-token' }); first.reject(new Error('disk')); await failed; await adding
  assert.deepEqual(ids(f.values.get('favorite_goods_account_a')), ['second', 'first'])
  assert.equal(f.values.has('favorite_goods_account_b'), false)
  await f.local.toggleFavorite(item('b-only')); assert.deepEqual(ids(f.local.getFavorites()), ['b-only'])
})

test('足迹排队保存固定商品快照并维持去重和五十条上限', async () => {
  const f = fixture(), gate = deferred(); let flushes = 0
  f.values.set('browse_history_account_a', Array.from({ length: 50 }, (_, index) => item(String(index))))
  f.setFlush(() => ++flushes === 1 ? gate.promise : Promise.resolve())
  const first = f.local.recordHistory(item('next')), incoming = item('last'), second = f.local.recordHistory(incoming)
  incoming.name = 'later mutation'; await tick(); assert.equal(flushes, 1)
  gate.resolve(); await first; await second
  const history = f.local.getHistory(); assert.equal(history.length, 50)
  assert.equal(history[0].id, 'last'); assert.equal(history[0].name, 'last'); assert.equal(history[1].id, 'next')
  await f.local.recordHistory(item('next')); assert.equal(f.local.getHistory().filter(value => value.id === 'next').length, 1)
})

test('旧本机数据迁移与当前写入串行，失败保留旧键并可再次恢复', async () => {
  const f = fixture(), gate = deferred(); let flushes = 0
  f.values.set('favorite_goods', [item('legacy')]); f.values.set('browse_history', [item('legacy')])
  f.setFlush(() => ++flushes === 1 ? gate.promise : Promise.resolve())
  const migration = f.local.migrateLegacyData(), failed = assert.rejects(migration, /迁移失败/)
  const next = f.local.toggleFavorite(item('new')); await tick(); assert.equal(flushes, 1)
  gate.reject(new Error('disk')); await failed; await next
  assert.deepEqual(ids(f.values.get('favorite_goods')), ['legacy'])
  assert.deepEqual(ids(f.local.getFavorites()), ['new'])
  await f.local.migrateLegacyData()
  assert.deepEqual(ids(f.local.getFavorites()), ['new', 'legacy'])
  assert.deepEqual(ids(f.local.getHistory()), ['legacy'])
  assert.equal(f.values.has('favorite_goods'), false); assert.equal(f.values.has('browse_history'), false)
})
