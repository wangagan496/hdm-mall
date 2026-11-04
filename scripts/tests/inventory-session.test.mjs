import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, pageMethods, tick } from './native-harness.mjs'

const test = (name, run) => nodeTest(name, { timeout: 2000 }, run)
const item = { skuId: 'sku', name: '商品', spec: '规格', stock: 20, recordedStock: 20, difference: 0 }
const result = (items = [{ ...item }], page = 1) => ({ items, page, pages: 2, counts: 11, pageSize: 10 })
const draft = { requestKey: 'request', skuId: 'sku', delta: 2, expectedStock: 20, reason: '盘点后增加库存' }
function fixture() {
  const queries = [], writes = [], dialogs = []
  let mutation = async () => ({ balance: 22 }), pending = null
  const api = { read: async () => result(), getForSession: (...args) => { queries.push(args); return api.read(...args) } }
  const flow = { pending: () => pending,
    start: (...args) => { writes.push(['start', ...args]); return mutation() },
    resume: (...args) => { writes.push(['resume', ...args]); return mutation() } }
  const View = pageMethods('mixed-development-h5/features/mine/src/main/ets/presentation/views/InventoryView.ets', 'InventoryView', {},
    { RequestAxios: api, inventoryAdjustment: flow, Scroller: class { scrollEdge() {} }, Edge: { Top: 0 } })
  const page = new View(); page.user = { id: 'merchant', role: 'merchant', token: 'token' }; page.active = true
  page.getUIContext = () => ({ showAlertDialog: dialog => dialogs.push(dialog) })
  const edit = () => { page.select(page.items[0] || item); page.quantity = '2'; page.reason = draft.reason }
  return { page, api, flow, queries, writes, dialogs, edit,
    setMutation: fn => { mutation = fn }, setPending: value => { pending = value } }
}

test('库存首次读取、刷新及失败保留列表时不能提交，重试成功恢复', async () => {
  const f = fixture(); f.edit(); f.page.confirmAdjustment()
  assert.equal(f.dialogs.length, 0)
  await f.page.load(1); f.edit()
  const gate = deferred(); f.api.read = () => gate.promise
  const loading = f.page.load(1); f.page.confirmAdjustment()
  await f.page.submit(item, 2, draft.reason)
  assert.equal(f.dialogs.length, 0); assert.equal(f.writes.length, 0)
  gate.reject(new Error('offline')); await loading
  assert.equal(f.page.items[0].stock, 20); f.page.confirmAdjustment()
  await f.page.submit(item, 2, draft.reason)
  assert.equal(f.dialogs.length, 0); assert.equal(f.writes.length, 0)
  f.api.read = async () => result(); await f.page.load(1); f.edit(); f.page.confirmAdjustment()
  f.dialogs[0].secondaryButton.action(); await tick()
  assert.deepEqual(f.writes, [['start', 'sku', 2, 20, draft.reason, 'token']])
})

test('库存旧确认框在刷新、重进、换账号、换角色、取消或替换后失效', async () => {
  for (const change of ['refresh', 'reenter', 'account', 'role', 'cancel', 'replace']) {
    const f = fixture(); await f.page.load(1); f.edit(); f.page.confirmAdjustment()
    const old = f.dialogs[0].secondaryButton.action
    if (change === 'refresh') await f.page.load(1)
    if (change === 'reenter') { f.page.aboutToDisappear(); f.page.aboutToAppear(); await tick() }
    if (change === 'account') { f.page.user = { ...f.page.user, id: 'other', token: 'other-token' }; f.page.accountChanged(); await tick() }
    if (change === 'role') { f.page.user = { ...f.page.user, role: 'buyer' }; f.page.accountChanged(); await tick() }
    if (change === 'cancel') f.dialogs[0].primaryButton.action()
    if (change === 'replace') f.page.confirmAdjustment()
    old(); await tick(); assert.equal(f.writes.length, 0, change)
    if (change === 'role') continue
    f.edit(); f.page.confirmAdjustment(); const current = f.dialogs.at(-1).secondaryButton.action
    current(); await tick(); current(); await tick()
    assert.equal(f.writes.length, 1, change)
  }
})

test('库存确认复核当前规格、库存差异及表单，不能提交旧内容', async () => {
  for (const change of ['missing', 'stock', 'difference', 'quantity', 'reason', 'direction', 'selected']) {
    const f = fixture(); await f.page.load(1); f.edit(); f.page.confirmAdjustment()
    if (change === 'missing') f.page.items = []
    if (change === 'stock') f.page.items = [{ ...item, stock: 19 }]
    if (change === 'difference') f.page.items = [{ ...item, difference: 1 }]
    if (change === 'quantity') f.page.quantity = '3'
    if (change === 'reason') f.page.reason = '修改后的调整原因'
    if (change === 'direction') f.page.increase = false
    if (change === 'selected') f.page.selected = null
    f.dialogs[0].secondaryButton.action(); await tick(); assert.equal(f.writes.length, 0, change)
  }
  const f = fixture(); await f.page.load(1)
  f.page.select({ ...item, skuId: 'missing' }); assert.equal(f.page.selected, null)
  f.page.items = [{ ...item, difference: 1 }]; f.page.select(f.page.items[0]); assert.equal(f.page.selected, null)
})

test('库存开始和恢复操作的旧成功失败不干扰同账号重进后的新操作', async () => {
  for (const action of ['start', 'resume']) for (const failed of [false, true]) {
    const f = fixture(), old = deferred(), current = deferred(); await f.page.load(1)
    if (action === 'resume') { f.setPending(draft); f.page.readPending() }
    f.setMutation(() => old.promise)
    const first = action === 'start' ? f.page.submit(item, 2, draft.reason) : f.page.submit()
    assert.equal(f.writes.length, 1)
    f.page.aboutToDisappear(); f.setPending(null); f.page.aboutToAppear(); await tick()
    f.edit(); f.setMutation(() => current.promise); const second = f.page.submit(item, 2, draft.reason)
    assert.equal(f.writes.length, 2)
    const count = f.queries.length
    if (failed) old.reject(new Error('old failure')); else old.resolve({ balance: 22 })
    await first
    assert.equal(f.page.submitting, true); assert.equal(f.page.selected.skuId, 'sku')
    assert.equal(f.page.message, ''); assert.equal(f.queries.length, count)
    assert.equal(f.writes[0].at(-1), 'token')
    current.resolve({ balance: 22 }); await second; assert.equal(f.page.submitting, false)
  }
})

test('库存隐藏页面不读写，资料变化保留编辑，账号和角色变化清除旧数据', async () => {
  const f = fixture(); await f.page.load(1); f.edit(); const count = f.queries.length
  f.page.user = { ...f.page.user, nickname: 'new' }; f.page.accountChanged(); await tick()
  assert.equal(f.queries.length, count); assert.equal(f.page.quantity, '2')
  f.page.aboutToDisappear(); await f.page.load(1); await f.page.submit(item, 2, draft.reason)
  f.page.refreshAfterForeground?.(); assert.equal(f.queries.length, count); assert.equal(f.writes.length, 0)
  f.page.user = { ...f.page.user, role: 'buyer' }; f.page.accountChanged()
  assert.equal(f.page.items.length, 0); assert.equal(f.page.selected, null); assert.equal(f.page.reason, '')
  f.page.showInventory(); await tick(); assert.equal(f.queries.length, count)
  f.page.user = { id: 'other', token: 'new-token', role: 'merchant' }; f.page.accountChanged(); await tick()
  assert.equal(f.queries.at(-1)[1], 'new-token')
  f.page.refreshAfterForeground(); await tick(); assert.equal(f.queries.length, count + 2)
})

test('库存旧查询不能解除新加载或覆盖新数据，重试成功清除读取错误', async () => {
  for (const failed of [false, true]) {
    const f = fixture(), old = deferred(), current = deferred(); f.api.read = () => old.promise
    const first = f.page.load(1); f.page.aboutToDisappear(); f.api.read = () => current.promise; f.page.aboutToAppear()
    if (failed) old.reject(new Error('old')); else old.resolve(result([{ ...item, stock: 1 }]))
    await first; assert.equal(f.page.loading, true); assert.equal(f.page.items.length, 0)
    current.resolve(result()); await tick(); assert.equal(f.page.items[0].stock, 20)
    f.api.read = async () => { throw new Error('offline') }; await f.page.load(1)
    assert.match(f.page.loadError || f.page.message, /失败/)
    f.api.read = async () => result(); await f.page.load(1)
    assert.equal(f.page.loadError || f.page.message, '')
  }
})

test('库存结果未知使旧查询失效，但待确认记录可恢复，成功刷新失败不再写入', async () => {
  const f = fixture(), mutation = deferred(), query = deferred(); await f.page.load(1)
  f.setMutation(() => mutation.promise); const write = f.page.submit(item, 2, draft.reason)
  f.api.read = () => query.promise; const read = f.page.load(1); f.setPending(draft)
  mutation.reject(new Error('调整结果待确认')); await write
  query.resolve(result()); await read; assert.ok(f.page.pending)
  f.setPending(null); f.page.readPending(); await f.page.submit(item, 2, draft.reason)
  assert.equal(f.writes.length, 1)
  f.setPending(draft); f.page.readPending(); f.setMutation(async () => { f.setPending(null); return { balance: 22 } })
  f.api.read = async () => { throw new Error('refresh failed') }; await f.page.submit()
  assert.deepEqual(f.writes[1], ['resume', 'token']); assert.equal(f.page.pending, null)
  assert.match(f.page.message, /调整已记录/); assert.match(f.page.loadError || f.page.message, /刷新失败/)
  await f.page.submit(item, 2, draft.reason); assert.equal(f.writes.length, 2)
})

test('库存待办损坏时保留错误并拦截新操作，恢复正常读取后才重新开放', async () => {
  const f = fixture(); f.flow.pending = () => { throw new Error('本地待确认记录异常') }
  f.page.aboutToAppear(); await tick(); f.edit(); f.page.confirmAdjustment()
  await f.page.submit(item, 2, draft.reason); await f.page.submit()
  assert.equal(f.writes.length, 0); assert.equal(f.dialogs.length, 0)
  assert.match(f.page.pendingError || f.page.message, /记录异常/)
  f.flow.pending = () => null; await f.page.load(1); f.edit(); f.page.confirmAdjustment()
  assert.equal(f.dialogs.length, 1)
})
