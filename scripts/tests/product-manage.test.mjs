import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceOf, execute, deferred, tick } from './native-harness.mjs'

export function productFixture() {
  let user = { id: 'merchant', role: 'merchant', token: 'token' }, sequence = 0
  const disk = new Map(), writes = [], reads = [], uploads = []
  const store = { getSync: (key, fallback) => disk.get(key) ?? fallback, putSync: (key, value) => disk.set(key, value), flush: async () => {} }
  const api = { getForSession: async (...args) => { reads.push(args); return api.get(...args) },
    postWithSession: async (...args) => { writes.push(args); return api.write(...args) },
    putForSession: async (...args) => { writes.push(args); return api.write(...args) },
    postMultipartForSession: async (...args) => { uploads.push(args); return { imageId: 'image' } },
    get: async () => { throw { response: { status: 404 } } }, write: async (url, body) => ({ id: url === '/merchant/products' ? 'product' : url.split('/').at(-1), name: body.name, revision: 2, skus: body.skus }) }
  const { ProductSave } = execute(sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/utils/ProductSave.ets'), {
    '@kit.ArkTS': { util: { generateRandomUUID: () => 'key-' + ++sequence, Base64Helper: class { decodeSync(value) { return Uint8Array.from(Buffer.from(value, 'base64')) } } } },
    network: { RequestAxios: api }, storage: { auth: { getUserInfo: () => user }, storeManager: { getStore: () => store, getUserInfo: () => user } }
  })
  return { flow: new ProductSave(), disk, api, store, writes, reads, uploads, setUser: value => { user = value } }
}
const body = () => ({ name: '商品', categoryId: 'category', description: '', skus: [{ spec: '标准款', priceCents: 1900, stock: 20, enabled: true }] })

test('只改价格的保存也清除原草稿，上下架不清除未保存表单', async () => {
  const f = productFixture()
  f.disk.set('product-draft:merchant:one', 'draft')
  await f.flow.start('one', { expectedRevision: 1, skus: [{ id: 's', priceCents: 2200 }] }, '', 'token')
  assert.equal(f.disk.get('product-draft:merchant:one'), '')
  f.disk.set('product-draft:merchant:one', 'keep')
  await f.flow.start('one', { status: 'off' }, '', 'token')
  assert.equal(f.disk.get('product-draft:merchant:one'), 'keep')
})

test('商品保存先落盘、自动传图后一次提交，连续点击复用同一任务', async () => {
  const f = productFixture(), gate = deferred()
  f.store.flush = () => gate.promise
  const first = f.flow.start('', body(), 'aW1hZ2U=', 'token'), second = f.flow.start('', body(), '', 'token')
  assert.equal(first, second); assert.equal(f.writes.length, 0); assert.equal(f.uploads.length, 0)
  gate.resolve(); await first
  assert.equal(f.uploads.length, 1); assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0][1].imageId, 'image'); assert.equal(f.writes[0][2], 'token')
  assert.equal(f.flow.pending('merchant', ''), null)
})

test('响应丢失后恢复同一内容和编号，待确认只锁本商品', async () => {
  const f = productFixture(), success = f.api.write
  f.api.write = async () => { throw new Error('offline') }
  await assert.rejects(f.flow.start('one', { ...body(), expectedRevision: 1 }, '', 'token'))
  const saved = JSON.stringify(f.flow.pending('merchant', 'one').body)
  await assert.rejects(f.flow.start('one', body(), '', 'token'))
  f.api.write = success
  await f.flow.start('two', { ...body(), expectedRevision: 1 }, '', 'token')
  await f.flow.resume('one', 'token')
  assert.equal(JSON.stringify(f.writes.at(-1)[1]), saved)
  assert.equal(f.flow.pending('merchant', 'one'), null)
})

test('保存成功回应丢失时查到回执即结束，不再写入', async () => {
  const f = productFixture()
  f.api.write = async (_url, input) => { f.api.get = async () => ({ id: 'saved', name: input.name }); throw new Error('lost') }
  assert.equal((await f.flow.start('', body(), '', 'token')).id, 'saved')
  assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 1)
})

test('落盘失败不写服务端；版本冲突保留错误最新内容但清除原待确认请求', async () => {
  const f = productFixture()
  f.store.flush = async () => { throw new Error('disk') }
  await assert.rejects(f.flow.start('', body(), '', 'token'))
  assert.equal(f.writes.length, 0)
  f.store.flush = async () => {}
  const conflict = { response: { status: 409, data: { reason: 'PRODUCT_REVISION_CHANGED', result: { revision: 4 } } } }
  f.api.write = async () => { throw conflict }
  await assert.rejects(f.flow.start('one', body(), '', 'token'), error => error === conflict)
  assert.equal(f.flow.pending('merchant', 'one'), null)
})

test('保存中换账号不清旧账号待确认，恢复不借用新身份', async () => {
  const f = productFixture(), gate = deferred()
  f.api.write = () => gate.promise
  const task = f.flow.start('one', body(), '', 'token'); await tick()
  f.setUser({ id: 'other', role: 'merchant', token: 'other-token' })
  gate.resolve({ id: 'one' }); await assert.rejects(task)
  assert.ok(f.flow.pending('merchant', 'one')); assert.equal(f.flow.pending('other', 'one'), null)
  await assert.rejects(f.flow.resume('one', 'token'))
  assert.equal(f.writes.length, 1)
})
