import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceOf, execute, pageMethods, deferred, tick } from './native-harness.mjs'

const path = 'mixed-development-h5/features/mine/src/main/ets/presentation/utils/InventoryAdjustment.ets'
const failure = status => Object.assign(new Error('network failure'), { response: { status, data: { msg: '库存已变化，请刷新后重新确认' } } })
function fixture() {
  let user = { id: 'merchant', role: 'merchant', token: 'token' }, storedUser = user, sequence = 0
  const values = new Map(), writes = [], reads = []
  const store = { getSync: (key, fallback) => values.get(key) ?? fallback, putSync: (key, value) => values.set(key, value), flush: async () => {} }
  const api = {
    getForSession: async (...args) => { reads.push(args); return api.get(...args) },
    putForSession: async (...args) => { writes.push(args); return api.put(...args) },
    get: async () => { throw failure(404) },
    put: async (_url, data) => ({ id: 1, skuId: data.skuId, delta: data.delta, balance: data.expectedStock + data.delta, reason: data.reason, createdAt: 1 })
  }
  const { InventoryAdjustment } = execute(sourceOf(path), { '@kit.ArkTS': { util: { generateRandomUUID: () => `request-${++sequence}` } },
    network: { RequestAxios: api }, storage: { auth: { getUserInfo: () => user }, storeManager: { getStore: () => store, getUserInfo: () => storedUser } } })
  return { flow: new InventoryAdjustment(), newFlow: () => new InventoryAdjustment(), values, writes, reads, api, store,
    setUser: value => { user = value; storedUser = value }, setStored: value => { storedUser = value } }
}
const start = f => f.flow.start('sku', 2, 20, '盘点后增加库存', 'token')

test('库存调用方凭证失效时不使用新账号启动或恢复调整', async () => {
  const f = fixture()
  f.setUser({ id: 'other', role: 'merchant', token: 'new-token' })
  await assert.rejects(f.flow.start('sku', 2, 20, '盘点后增加库存', 'token'), /登录状态已变化/)
  assert.equal(f.writes.length, 0); assert.equal(f.values.size, 0)
  f.values.set('stock-adjustment:other', JSON.stringify({ requestKey: 'existing', skuId: 'sku', delta: 2, expectedStock: 20, reason: '盘点后增加库存' }))
  await assert.rejects(f.flow.resume('token'), /登录状态已变化/)
  assert.equal(f.writes.length, 0); assert.equal(f.reads.length, 0)
})

test('库存连续点击复用一笔，保存请求内容后才发送，确认成功清待办', async () => {
  const f = fixture(), gate = deferred()
  f.store.flush = () => gate.promise
  const first = start(f), second = start(f)
  assert.equal(first, second); assert.equal(f.writes.length, 0)
  gate.resolve(); await first
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0][2], 'token')
  assert.equal(f.flow.pending('merchant'), null)
})

test('调整回应丢失后查询到同一凭据即确认，不重复加库存', async () => {
  const f = fixture()
  f.api.put = async (_url, draft) => { f.api.get = async () => ({ id: 1, ...draft, balance: 22 }); throw new Error('response lost') }
  assert.equal((await start(f)).balance, 22)
  assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 1)
  assert.equal(f.flow.pending('merchant'), null)
})

test('持续断网保留固定草稿，重进后查询再沿用同一编号重试', async () => {
  const f = fixture(), originalPut = f.api.put
  f.api.put = async () => { throw new Error('offline') }
  f.api.get = async () => { throw new Error('offline') }
  await assert.rejects(start(f), /待确认/)
  const draft = f.flow.pending('merchant')
  assert.ok(draft)
  await assert.rejects(start(f), /上一笔/)
  f.api.get = async () => { throw failure(404) }; f.api.put = originalPut
  f.flow = f.newFlow()
  await f.flow.resume('token')
  assert.equal(f.writes.length, 2)
  assert.deepEqual(f.writes[0][1], f.writes[1][1])
  assert.equal(f.flow.pending('merchant'), null)
})

test('本地保存失败不发请求，明确拒绝会清待办以便重新确认最新库存', async () => {
  const f = fixture()
  f.store.flush = async () => { throw new Error('disk failure') }
  await assert.rejects(start(f), /保存失败/)
  assert.equal(f.writes.length, 0)
  f.store.flush = async () => {}; f.api.put = async () => { throw failure(409) }
  await assert.rejects(start(f), /库存已变化/)
  assert.equal(f.flow.pending('merchant'), null)
})

test('换账号或新登录等待落盘时不复用旧身份，迟到调整回应保留原账号待办', async () => {
  const f = fixture(), gate = deferred()
  f.api.put = async () => gate.promise
  const request = start(f)
  await tick()
  f.setUser({ id: 'other', role: 'merchant', token: 'new-token' })
  gate.resolve({ id: 1, skuId: 'sku', delta: 2, balance: 22, reason: '盘点后增加库存' })
  await assert.rejects(request, /登录状态已变化/)
  assert.ok(f.flow.pending('merchant')); assert.equal(f.flow.pending('other'), null)
  f.setStored({ id: 'third', token: 'pending-login' })
  await assert.rejects(start(f), /登录状态已变化/)
  assert.equal(f.writes.length, 1)
})

test('已成功但清理失败时只查原结果；不一致凭据不能清除待确认记录', async () => {
  const f = fixture()
  let flushes = 0
  f.store.flush = async () => { if (++flushes === 2) throw new Error('disk failure') }
  await assert.rejects(start(f), /保存失败/)
  assert.ok(f.flow.pending('merchant'))
  f.api.get = async () => ({ id: 1, skuId: 'different', delta: 2, balance: 22, reason: '盘点后增加库存' })
  await assert.rejects(f.flow.resume('token'), /不一致/)
  assert.ok(f.flow.pending('merchant'))
  f.api.get = async () => ({ id: 1, skuId: 'sku', delta: 2, balance: 22, reason: '盘点后增加库存' })
  await f.flow.resume('token')
  assert.equal(f.writes.length, 1); assert.equal(f.flow.pending('merchant'), null)
})

function pageFixture() {
  const writes = []
  const api = { getForSession: async () => ({ items: [{ skuId: 'sku', stock: 20, difference: 0 }], page: 1, pages: 1 }) }
  const flow = { pending: () => null, start: async (...args) => { writes.push(args); return { balance: 23 } } }
  const View = pageMethods('mixed-development-h5/features/mine/src/main/ets/presentation/views/InventoryView.ets', 'InventoryView', {},
    { RequestAxios: api, inventoryAdjustment: flow, Scroller: class { scrollEdge() {} }, Edge: { Top: 0 } })
  const page = new View()
  page.user = { id: 'merchant', role: 'merchant', token: 'token' }; page.active = true
  return { page, api, flow, writes }
}

test('库存页面只接收最新查询，刷新编辑对象使用最新库存', async () => {
  const { page, api } = pageFixture(), first = deferred()
  api.getForSession = async () => first.promise
  const old = page.load(1)
  page.selected = { skuId: 'sku', stock: 20 }
  api.getForSession = async () => ({ items: [{ skuId: 'sku', stock: 22 }], page: 2, pages: 2 })
  await page.load(2)
  assert.equal(page.selected.stock, 22)
  first.resolve({ items: [{ skuId: 'sku', stock: 18 }], page: 1, pages: 2 }); await old
  assert.equal(page.page, 2); assert.equal(page.items[0].stock, 22)
})

test('库存提交后切换账号，迟到回应不会清空新账号编辑或显示旧成功', async () => {
  const { page, flow } = pageFixture(), gate = deferred()
  await page.load(1)
  let started = 0
  flow.start = async () => { started++; return gate.promise }
  const request = page.submit({ skuId: 'sku', stock: 20 }, 3, '盘点后增加库存')
  assert.equal(started, 1)
  page.user = { id: 'other', role: 'merchant', token: 'new-token' }
  page.accountChanged(); await tick()
  page.selected = { skuId: 'other-sku', stock: 10 }
  gate.resolve({ balance: 23 }); await request
  assert.equal(page.selected.skuId, 'other-sku'); assert.equal(page.message, '')
})

test('库存调整成功但列表刷新失败，仍明确显示已记录，不重发调整', async () => {
  const { page, api, writes } = pageFixture()
  await page.load(1)
  api.getForSession = async () => { throw new Error('refresh failed') }
  await page.submit({ skuId: 'sku', stock: 20 }, 3, '盘点后增加库存')
  assert.match(page.message, /调整已记录/); assert.match(page.loadError, /列表刷新失败/)
  assert.equal(writes.length, 1)
  assert.equal(page.selected, null); assert.equal(page.pending, null)
})
