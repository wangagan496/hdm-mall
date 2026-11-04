import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, tick } from './native-harness.mjs'
import { addressPage } from './address-harness.mjs'

const test = (name, run) => nodeTest(name, { timeout: 2000 }, run)
const row = (id = 'address-a') => ({ id, receiver: id, contact: '13800000000', address: '一号楼',
  fullLocation: '北京市 北京市 东城区', provinceCode: 11, cityCode: 1101, countyCode: 110101, isDefault: 1 })
function fixture() {
  const reads = [], writes = [], messages = [], events = [], alerts = [], timers = new Map()
  let nextTimer = 0, nextKey = 0, list = async () => [row()], detail = async id => row(id), write = async () => ({ id: 'created' })
  const Page = addressPage({
    util: { generateRandomUUID: () => `key-${++nextKey}` },
    getAddressListAPI: token => { reads.push({ kind: 'list', token }); return list() },
    getAddressDetailAPI: (id, token) => { reads.push({ kind: 'detail', id, token }); return detail(id) },
    createAddressAPI: (data, key, token) => { writes.push({ kind: 'create', data, key, token }); return write() },
    updateAddressAPI: (id, data, token) => { writes.push({ kind: 'update', id, data, token }); return write() },
    deleteAddressAPI: (id, token) => { writes.push({ kind: 'delete', id, token }); return write() },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, () => { timers.delete(id); return callback() }); return id },
    clearTimeout: id => timers.delete(id),
    BusinessVariable: { UPDATE_ADDRESS_LIST: 'updated' }, emitter: { emit: name => events.push(name) },
  })
  const page = new Page()
  page.user = { token: 'buyer-a' }
  page.safeToast = message => messages.push(message)
  page.getUIContext = () => ({ showAlertDialog: options => alerts.push(options) })
  const createDraft = () => { page.openCreate(); Object.assign(page.form, row(''), { receiver: '新收货人', isDefault: false }); page.form.address = '新地址' }
  return { page, reads, writes, messages, events, alerts, timers, createDraft,
    setList: fn => { list = fn }, setDetail: fn => { detail = fn }, setWrite: fn => { write = fn } }
}

test('换账号清除地址表单和弹层，迟到列表成功失败不能写回新会话', async () => {
  for (const fails of [false, true]) {
    const f = fixture()
    await f.page.loadAddresses()
    f.createDraft()
    const oldGate = deferred(), newGate = deferred()
    f.setList(() => oldGate.promise)
    const old = f.page.loadAddresses()
    f.page.user = { token: 'buyer-b' }
    f.setList(() => newGate.promise)
    const current = f.page.loadAddresses()
    assert.equal(f.page.addresses.length, 0)
    assert.equal(f.page.form.receiver, '')
    assert.equal(f.page.showEditor, false)
    if (fails) oldGate.reject(new Error('old failure'))
    else oldGate.resolve([row('private-a')])
    await old
    assert.equal(f.page.loading, true)
    assert.deepEqual(f.messages, [])
    newGate.resolve([row('address-b')])
    await current
    assert.equal(f.page.addresses[0].id, 'address-b')
    assert.equal(f.reads[0].token, 'buyer-a')
    assert.equal(f.reads.at(-1).token, 'buyer-b')
  }
})

test('自动保存定时器不借新账号写旧表单，退出清空并取消计时且不匿名查询', async () => {
  const f = fixture()
  await f.page.loadAddresses()
  f.createDraft()
  f.page.scheduleAddressSave()
  const callback = [...f.timers.values()][0]
  f.page.user = { token: 'buyer-b' }
  callback()
  await tick()
  assert.equal(f.writes.length, 0)
  f.page.reloadForCurrentAccount()
  await tick()
  f.createDraft()
  f.page.scheduleAddressSave()
  f.page.user = { token: '' }
  f.page.reloadForCurrentAccount()
  assert.equal(f.timers.size, 0)
  assert.equal(f.page.showEditor, false)
  assert.equal(f.page.addresses.length, 0)
  assert.equal(f.page.loading, false)
  assert.equal(f.reads.length, 2)
})

test('换账号或离页重进的旧新增修改结果不改新表单、不解除新保存锁、不清新任务或发更新通知', async () => {
  for (const transition of ['account', 'reenter']) for (const editing of [false, true]) for (const fails of [false, true]) {
    const f = fixture()
    await f.page.loadAddresses()
    if (editing) { await f.page.openEdit(row()); f.page.form.address = '原账号修改' }
    else f.createDraft()
    const oldGate = deferred(), newGate = deferred()
    f.setWrite(() => oldGate.promise)
    const old = f.page.saveAddress()
    assert.equal(f.writes[0].token, 'buyer-a')
    f.setList(async () => [row('address-b')])
    if (transition === 'account') {
      f.page.user = { token: 'buyer-b' }
      f.page.reloadForCurrentAccount()
    } else {
      f.page.aboutToDisappear()
      f.page.aboutToAppear()
    }
    await tick()
    f.createDraft()
    f.setWrite(() => newGate.promise)
    const current = f.page.saveAddress()
    const pending = f.page.pendingAddressSave
    assert.equal(f.writes.length, 2)
    if (fails) oldGate.reject(new Error('late failure'))
    else oldGate.resolve({ id: 'old-created' })
    await old
    assert.equal(f.page.form.id, '')
    assert.equal(f.page.submitting, true)
    assert.equal(f.page.pendingAddressSave, pending)
    assert.equal(f.page.saveError, '')
    assert.deepEqual(f.events, [])
    newGate.resolve({ id: 'new-created' })
    await current
    assert.equal(f.page.form.id, 'new-created')
    assert.equal(f.page.submitting, false)
    assert.equal(f.page.pendingAddressSave, undefined)
    assert.deepEqual(f.events, ['updated'])
  }
})

test('旧地址详情不能覆盖新编辑器或提前解除详情加载，账号资料更新不重读', async () => {
  const f = fixture()
  await f.page.loadAddresses()
  const oldGate = deferred(), newGate = deferred()
  f.setDetail(() => oldGate.promise)
  const old = f.page.openEdit(row())
  f.page.user = { token: 'buyer-b' }
  f.setList(async () => [row('address-b')])
  f.page.reloadForCurrentAccount()
  await tick()
  f.setDetail(() => newGate.promise)
  const current = f.page.openEdit(row('address-b'))
  oldGate.resolve(row('address-a'))
  await old
  assert.equal(f.page.form.id, 'address-b')
  assert.equal(f.page.editorLoading, true)
  newGate.resolve({ ...row('address-b'), address: '新详情' })
  await current
  assert.equal(f.page.form.address, '新详情')
  assert.equal(f.reads.at(-1).token, 'buyer-b')
  const count = f.reads.length
  f.page.user = { token: 'buyer-b', nickname: 'new' }
  f.page.reloadForCurrentAccount()
  assert.equal(f.reads.length, count)
})

test('默认地址和删除的迟到成功失败不提示、不通知、不解除新操作锁', async () => {
  for (const kind of ['default', 'delete']) for (const fails of [false, true]) {
    const f = fixture()
    await f.page.loadAddresses()
    const oldGate = deferred(), newGate = deferred()
    f.setWrite(() => oldGate.promise)
    const start = id => {
      if (kind === 'default') return f.page.setDefault(row(id))
      f.page.openDelete(row(id)); return f.page.confirmDelete()
    }
    const old = start('address-a')
    assert.equal(f.writes[0].token, 'buyer-a')
    f.page.aboutToDisappear()
    f.setList(async () => [row('address-b')])
    f.page.aboutToAppear()
    await tick()
    f.setWrite(() => newGate.promise)
    const current = start('address-b')
    assert.equal(f.writes.length, 2)
    if (fails) oldGate.reject(new Error('old error'))
    else oldGate.resolve({})
    await old
    assert.equal(kind === 'default' ? f.page.settingDefaultId : f.page.deleting, kind === 'default' ? 'address-b' : true)
    assert.deepEqual(f.messages, [])
    assert.deepEqual(f.events, [])
    newGate.resolve({})
    await current
    assert.equal(kind === 'default' ? f.page.settingDefaultId : f.page.deleting, kind === 'default' ? '' : false)
    assert.deepEqual(f.events, ['updated'])
  }
})

test('旧关闭流程和放弃确认不能关闭新编辑器，也不能继续保存新账号表单', async () => {
  const f = fixture()
  await f.page.loadAddresses()
  f.createDraft()
  f.page.form.contact = ''
  let dismissed = 0
  await f.page.closeAddressEditor({ dismiss: () => { dismissed++ } })
  const oldDiscard = f.alerts[0].secondaryButton.action
  f.page.user = { token: 'buyer-b' }
  f.page.reloadForCurrentAccount()
  await tick()
  f.createDraft()
  oldDiscard()
  assert.equal(dismissed, 0)
  const oldGate = deferred(), newGate = deferred()
  f.setWrite(() => oldGate.promise)
  const oldClose = f.page.closeAddressEditor({ dismiss: () => { dismissed++ } })
  f.page.user = { token: 'buyer-c' }
  f.page.reloadForCurrentAccount()
  await tick()
  f.createDraft()
  f.setWrite(() => newGate.promise)
  const currentClose = f.page.closeAddressEditor({ dismiss: () => { dismissed++ } })
  oldGate.resolve({ id: 'old-created' })
  await oldClose
  assert.equal(dismissed, 0)
  assert.equal(f.page.closingEditor, true)
  assert.equal(f.page.submitting, true)
  assert.equal(f.writes.length, 2)
  newGate.resolve({ id: 'new-created' })
  await currentClose
  assert.equal(dismissed, 1)
  assert.equal(f.page.closingEditor, false)
})

test('地址列表刷新未确认或失败时不能改默认删除或开新表单，离页后不再排队保存', async () => {
  const f = fixture()
  await f.page.loadAddresses()
  const gate = deferred()
  f.setList(() => gate.promise)
  const refreshing = f.page.loadAddresses()
  const updating = f.page.setDefault(row())
  assert.equal(f.writes.length, 0)
  await updating
  f.page.openDelete(row()); await f.page.confirmDelete(); f.page.openCreate()
  assert.equal(f.writes.length, 0)
  assert.equal(f.page.showEditor, false)
  gate.reject(new Error('offline'))
  await refreshing
  await f.page.openEdit(row())
  assert.equal(f.page.showEditor, false)
  f.setList(async () => [row()])
  await f.page.loadAddresses()
  f.createDraft()
  f.page.aboutToDisappear()
  f.page.scheduleAddressSave()
  await f.page.saveAddress()
  assert.equal(f.timers.size, 0)
  assert.equal(f.writes.length, 0)
})
