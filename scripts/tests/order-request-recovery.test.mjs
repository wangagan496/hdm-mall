import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf, deferred } from './native-harness.mjs'

const { checkoutFailure } = execute(sourceOf('mixed-development-h5/commons/storage/src/main/ets/OrderRequest.ets'))

function fixture(state = 'pending') {
  const disk = new Map(), messages = [], dialogs = [], paths = [], queries = []
  const preferences = { getPreferencesSync: () => ({ getSync: (key, fallback) => disk.get(key) ?? fallback,
    putSync: (key, value) => disk.set(key, value), deleteSync: key => disk.delete(key), flush: async () => {} }) }
  const { StoreManager } = execute(sourceOf('mixed-development-h5/commons/storage/src/main/ets/StoreManager.ets'), {
    '@kit.ArkData': { preferences }, constants: { GlobalVariable: { USER_INFO_KEY: 'user' } }
  })
  const storeManager = new StoreManager(); storeManager.ctx = {}
  let lookup = async () => {
    if (state === 'missing') throw { response: { status: 404 } }
    if (state === 'offline') throw new Error('offline')
    return { id: 'recovered', orderState: state === 'pending' ? 1 : 6, expiresAt: 900000 }
  }
  let source = sourceOf('mixed-development-h5/products/phone/src/main/ets/pages/Index.ets')
  source = source.slice(source.indexOf('struct Index')).split('  @Builder')[0]
    .replace('struct Index', 'export class Index').replace(/@\w+(?:\([^)]*\))?\s*/g, '') + '\n}'
  const { Index } = execute(source, {}, { storeManager, GlobalVariable: { DEMO_ORDER_FLOW: false },
    checkoutFailure,
    getOrderByRequestAPI: (key, token) => { queries.push({ key, token }); return lookup() },
    NavPathStack: class {}, TabIndex: { HOME: 0 }, PAGE_PATH: { PAY_PAGE: 'pay' }
  })
  const page = new Index(); page.user = { id: 'buyer', token: 'token' }
  page.stackPath = { pushPath: path => paths.push(path), getAllPathName: () => [] }
  page.getUIContext = () => ({ getPromptAction: () => ({ showToast: value => messages.push(value.message),
    showDialog: async value => { dialogs.push(value); return { index: 0 } } }) })
  return { page, disk, storeManager, messages, dialogs, paths, queries, lookup: fn => { lookup = fn },
    reopenStore: () => { const fresh = new StoreManager(); fresh.ctx = {}; return fresh } }
}

for (const state of ['pending', 'cancelled', 'missing', 'offline']) {
  test('B-34: 启动恢复 ' + state, async () => {
    const f = fixture(state)
    await f.storeManager.savePendingOrder({ accountId: 'buyer', requestKey: 'old-key', summary: 'quoted-request' })
    await f.page.recoverPendingOrder()
    assert.deepEqual(f.queries, [{ key: 'old-key', token: 'token' }])
    assert.equal(f.dialogs.length, state === 'pending' ? 1 : 0)
    assert.equal(f.messages.length, state === 'missing' ? 1 : 0)
    if (state === 'missing') assert.equal(f.messages[0], '上次提交没有成功，商品仍在购物车里')
    if (state === 'pending') {
      assert.match(f.dialogs[0].message, /上次提交的订单已生成/)
      assert.equal(f.dialogs[0].buttons[1].text, '去付款')
    }
    assert.equal(f.paths.length, 0)
    assert.equal(f.storeManager.getPendingOrder('buyer') !== null, state === 'offline')
    await f.page.recoverPendingOrder()
    assert.equal(f.dialogs.length, state === 'pending' ? 1 : 0)
  })
}

test('B-34/K8: 其他账号记录和迟到的恢复结果均不处理', async () => {
  const f = fixture()
  await f.storeManager.savePendingOrder({ accountId: 'other', requestKey: 'other-key', summary: 'other' })
  await f.page.recoverPendingOrder()
  assert.equal(f.queries.length, 0)
  assert.ok(f.storeManager.getPendingOrder('other'))
  await f.storeManager.savePendingOrder({ accountId: 'buyer', requestKey: 'old-key', summary: 'old' })
  const gate = deferred(); f.lookup(() => gate.promise)
  const pending = f.page.recoverPendingOrder()
  f.page.user = { id: 'other', token: 'other-token' }
  gate.resolve({ id: 'old-order', orderState: 1 }); await pending
  assert.equal(f.dialogs.length, 0)
  assert.equal(f.paths.length, 0)
  assert.ok(f.storeManager.getPendingOrder('buyer'))
})

test('B-34: 去付款按钮只在原会话有效时打开收银页', async () => {
  const f = fixture()
  await f.storeManager.savePendingOrder({ accountId: 'buyer', requestKey: 'old-key', summary: 'old' })
  f.page.getUIContext = () => ({ getPromptAction: () => ({ showDialog: async () => ({ index: 1 }) }) })
  await f.page.recoverPendingOrder()
  assert.deepEqual(JSON.parse(JSON.stringify(f.paths)), [{ name: 'pay', param: 'recovered' }])
})

test('B-34: 离开首页后的迟到恢复不弹窗，记录留待重进确认', async () => {
  const f = fixture()
  await f.storeManager.savePendingOrder({ accountId: 'buyer', requestKey: 'old-key', summary: 'old' })
  const gate = deferred(); f.lookup(() => gate.promise)
  const checking = f.page.recoverPendingOrder()
  f.page.stackPath.getAllPathName = () => ['checkout']
  gate.resolve({ id: 'old-order', orderState: 1 }); await checking
  assert.equal(f.dialogs.length, 0)
  assert.ok(f.storeManager.getPendingOrder('buyer'))
})

test('B-34: 重建存储实例仍能读到账号请求和摘要，旧结果不能删除新记录', async () => {
  const f = fixture()
  const record = { accountId: 'buyer', requestKey: 'old-key', summary: '{"goods":[{"skuId":"direct","count":1}]}' }
  await f.storeManager.savePendingOrder(record)
  const fresh = f.reopenStore()
  assert.deepEqual(JSON.parse(JSON.stringify(fresh.getPendingOrder('buyer'))), record)
  assert.equal(fresh.getPendingOrder('other'), null)
  await assert.rejects(fresh.savePendingOrder({ ...record, requestKey: 'new-key' }), /正在确认订单/)
  await fresh.clearPendingOrder('buyer', 'wrong-key')
  assert.equal(fresh.getPendingOrder('buyer').requestKey, 'old-key')
  await fresh.clearPendingOrder('buyer', 'old-key')
  await fresh.savePendingOrder({ ...record, requestKey: 'new-key' })
  await f.storeManager.clearPendingOrder('buyer', 'old-key')
  assert.equal(fresh.getPendingOrder('buyer').requestKey, 'new-key')
})
