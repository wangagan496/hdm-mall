// 执行真实页面方法，替换平台 UI、计时器和网络；不代替设备交互验收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceOf } from './native-harness.mjs'
import { addressPage } from './address-harness.mjs'

const source = sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/views/AddressView.ets')

function fixture() {
  let timerId = 0
  const timers = new Map()
  const requests = []
  const alerts = []
  let create = async () => ({ id: 'A100' })
  let update = async () => ({ id: 'A100' })
  const Page = addressPage({
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId },
    clearTimeout: (id) => timers.delete(id),
    createAddressAPI: async (data, key, token, revision) => { requests.push({ type: 'create', data, key, revision }); return create(data, key) },
    updateAddressAPI: async (id, data) => { requests.push({ type: 'update', id, data }); return update(id, data) }
  })
  const page = new Page()
  Object.assign(page, {
    user: { token: 'buyer-a' }, sessionToken: 'buyer-a', loadedToken: 'buyer-a',
    form: { id: '', receiver: '小明', contact: '13800000000', provinceCode: 11, cityCode: 1101, countyCode: 110101, fullLocation: '北京市 北京市 东城区', address: '一号楼', isDefault: true },
    addressSaveTimer: -1, savedAddressData: '', addressRequestKey: 'fixed-draft-key', editorRequestSequence: 1,
    submitting: false, closingEditor: false, showEditor: true, editorLoading: false, selectingArea: false, saveError: '',
    pendingAddressSave: undefined, loadAddresses: async () => {}, notifyAddressUpdated: () => {},
    safeToast: () => {}, getUIContext: () => ({ showAlertDialog: (options) => alerts.push(options) })
  })
  return { page, timers, requests, alerts, setCreate: (fn) => { create = fn }, setUpdate: (fn) => { update = fn } }
}

test('完整输入才排队保存，连续输入合并，无变化不提交', async () => {
  const f = fixture()
  f.page.form.contact = '123'
  f.page.scheduleAddressSave()
  assert.equal(f.timers.size, 0)
  f.page.form.contact = '13800000000'
  f.page.scheduleAddressSave()
  f.page.form.address = '最终地址'
  f.page.scheduleAddressSave()
  assert.equal(f.timers.size, 1)
  await f.page.saveAddress()
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].data.address, '最终地址')
  assert.equal(f.page.form.id, 'A100')
  assert.equal(f.page.showEditor, true)
  await f.page.saveAddress()
  assert.equal(f.requests.length, 1)
})

test('新增期间继续输入，完成后用同一编号更新且请求不重叠', async () => {
  const f = fixture()
  let finish
  f.setCreate(() => new Promise(resolve => { finish = resolve }))
  const saving = f.page.saveAddress()
  f.page.form.address = '新增过程中修改'
  const waiting = f.page.saveAddress()
  assert.equal(f.requests.length, 1)
  finish({ id: 'A100' })
  await Promise.all([saving, waiting])
  await f.page.saveAddress()
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1].type, 'update')
  assert.equal(f.requests[1].id, 'A100')
  assert.equal(f.requests[1].data.address, '新增过程中修改')
  assert.equal(f.requests[0].revision, 1)
  assert.equal(f.requests[1].data.revision, 2)
  assert.equal(f.requests[1].data.requestKey, f.requests[0].key)
})

test('保存失败保留内容且无无限重试，手动重试沿用新增标识', async () => {
  const f = fixture()
  f.setCreate(async () => { throw new Error('response lost') })
  await f.page.saveAddress()
  assert.ok(f.page.saveError)
  assert.equal(f.page.form.address, '一号楼')
  assert.equal(f.page.showEditor, true)
  assert.equal(f.timers.size, 0)
  f.setCreate(async () => ({ id: 'A100' }))
  await f.page.saveAddress()
  assert.equal(f.requests[0].key, f.requests[1].key)
  assert.equal(f.requests[0].revision, 1)
  assert.equal(f.requests[1].revision, 2)
  assert.equal(f.page.saveError, '')
  assert.equal(f.page.form.id, 'A100')
})

test('关闭时补存最新输入，正在保存时等待后再关闭', async () => {
  const f = fixture()
  let finish
  let dismissed = false
  f.setCreate(() => new Promise(resolve => { finish = resolve }))
  const saving = f.page.saveAddress()
  f.page.form.address = '关闭前的最后输入'
  const closing = f.page.closeAddressEditor({ dismiss: () => { dismissed = true } })
  assert.equal(dismissed, false)
  finish({ id: 'A100' })
  await Promise.all([saving, closing])
  assert.equal(dismissed, true)
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1].data.address, '关闭前的最后输入')
  assert.equal(f.page.closingEditor, false)
})

test('不完整或失败时不静默丢弃，用户可明确放弃未保存修改', async () => {
  const f = fixture()
  let dismissed = false
  f.page.form.contact = ''
  await f.page.closeAddressEditor({ dismiss: () => { dismissed = true } })
  assert.equal(dismissed, false)
  assert.equal(f.requests.length, 0)
  assert.equal(f.alerts.length, 1)
  f.alerts[0].secondaryButton.action()
  assert.equal(dismissed, true)
})

test('关闭时网络失败仍留在编辑框，重试成功后才能正常关闭', async () => {
  const f = fixture()
  let dismissed = false
  f.setCreate(async () => { throw new Error('offline') })
  await f.page.closeAddressEditor({ dismiss: () => { dismissed = true } })
  assert.equal(dismissed, false)
  assert.equal(f.alerts.length, 1)
  assert.equal(f.page.closingEditor, false)
  f.setCreate(async () => ({ id: 'A100' }))
  await f.page.closeAddressEditor({ dismiss: () => { dismissed = true } })
  assert.equal(dismissed, true)
})

test('缺失新增编号不冒充成功，未改动或加载详情期间不发请求', async () => {
  const f = fixture()
  f.page.editorLoading = true
  await f.page.saveAddress()
  assert.equal(f.requests.length, 0)
  f.page.editorLoading = false
  f.page.savedAddressData = JSON.stringify(f.page.buildAddressData())
  await f.page.saveAddress()
  assert.equal(f.requests.length, 0)
  f.page.form.address = '新内容'
  f.setCreate(async () => ({}))
  await f.page.saveAddress()
  assert.ok(f.page.saveError)
  assert.equal(f.page.form.id, '')
  assert.notEqual(f.page.savedAddressData, JSON.stringify(f.page.buildAddressData()))
})

test('选区县自动填回地区并排队保存，换省不立即保存未选完地区', () => {
  const f = fixture()
  const county = { code: '220101', name: '新区' }
  const city = { code: '2201', name: '新市', areaList: [county] }
  const province = { code: '22', name: '新省', areaList: [city] }
  Object.assign(f.page, { provinces: [province], cities: [], counties: [], selectingArea: true })
  f.page.chooseProvince(province)
  assert.equal(f.page.selectedCityCode, '')
  assert.equal(f.timers.size, 0)
  f.page.chooseCity(city)
  f.page.chooseCounty(county)
  assert.equal(f.page.form.fullLocation, '新省 新市 新区')
  assert.equal(f.page.form.countyCode, 220101)
  assert.equal(f.page.selectingArea, false)
  assert.equal(f.timers.size, 1)
})

test('地址管理保留自动保存，结算编辑器提供保存并使用入口', () => {
  assert.equal(source.includes("Text('完成')"), false)
  assert.equal(source.includes("'保存地址'"), false)
  assert.equal(source.slice(source.indexOf("title: '收货地址管理'")).includes('保存中'), false)
  assert.match(source, /if \(this\.checkoutEditor\)\s*\{[\s\S]*保存并使用此地址/)
})
