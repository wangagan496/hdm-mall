import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf, deferred, tick, pageMethods } from './native-harness.mjs'
import { addressPage } from './address-harness.mjs'
const base = 'mixed-development-h5/'

test('退出清零后迟到购物车请求不回写，换账号也丢弃旧数量', async () => {
  let user = { token: 'a' }, count = -1
  const pending = [], cards = []
  const { AuthCart } = execute(sourceOf(base + 'commons/storage/src/main/ets/AuthCart.ets'), {
    constants: { BusinessVariable: { CART_COUNT: 'count', UPDATE_CART_LIST: 'update' } },
    network: { executeGetWithRetry: action => action(), RequestAxios: {
      getForSession: () => { const gate = deferred(); pending.push(gate); return gate.promise } } },
    './Auth': { auth: { getUserInfo: () => user } },
    './StoreManager': { storeManager: { getFormId: () => ['card'] } },
    '@kit.FormKit': { formBindingData: { createFormBindingData: data => data }, formProvider: { updateForm: async (_id, data) => cards.push(data.count) } },
  }, { AppStorage: { setOrCreate: (_key, value) => { count = value } } })
  const cart = new AuthCart(), first = cart.updateCartCount()
  user = { token: '' }; cart.clearCartCount(); pending[0].resolve({ count: 7 }); await first; await tick()
  assert.equal(count, 0); assert.deepEqual(cards, [0])
  user = { token: 'a' }; const old = cart.updateCartCount()
  user = { token: 'b' }; const current = cart.updateCartCount()
  pending[2].resolve({ count: 3 }); await current; pending[1].resolve({ count: 9 }); await old; await tick()
  assert.equal(count, 3); assert.deepEqual(cards, [0, 3])
})
test('并发401只清一次，旧token不能清新账号，离线注销仍本地退出', async () => {
  let user = { token: 'a' }, clears = 0, saves = 0, serverToken, pendingStoredUser
  const deps = {
    './Auth': { auth: { getUserInfo: () => user, clearUserInfo: () => { user = { token: '' }; clears++ }, createEmptyUser: () => ({ token: '' }) } },
    './AuthCart': { authCart: { clearCartCount: () => {} } },
    './StoreManager': { storeManager: { getUserInfo: () => pendingStoredUser ?? user, saveUserInfo: async () => { saves++ } } },
    network: { RequestAxios: { setSessionExpiredHandler: () => {}, postForSession: async (_url, token) => { serverToken = token; throw new Error('offline') } } },
  }
  const { UserSession } = execute(sourceOf(base + 'commons/storage/src/main/ets/UserSession.ets'), deps)
  const session = new UserSession()
  pendingStoredUser = { token: 'new-login-waiting-for-flush' }
  assert.equal(await session.expireSession('a'), false)
  assert.equal(clears, 0)
  pendingStoredUser = undefined
  const results = await Promise.all([session.expireSession('a'), session.expireSession('a')])
  assert.deepEqual(results, [true, false]); assert.equal(clears, 1); assert.equal(saves, 1)
  user = { token: 'b' }; assert.equal(await session.expireSession('a'), false); assert.equal(user.token, 'b')
  await session.logout(); assert.equal(user.token, ''); assert.equal(serverToken, 'b'); assert.equal(session.serverLogoutConfirmed, false)
})

function addressFixture() {
  let list = async () => [], update = async () => {}, areaRead = () => '[]'
  const messages = [], writes = []
  const Address = addressPage({
    getAddressListAPI: () => list(), updateAddressAPI: async (...args) => { writes.push(args); return update(...args) },
    locationPlugin: { getAreaColumns: () => areaRead() },
  })
  const page = new Address()
  Object.assign(page, { user: { token: 'buyer-a' },
    safeToast: message => messages.push(message), notifyAddressUpdated: () => {}, getUIContext: () => ({ getHostContext: () => ({}) }) })
  return { page, messages, writes, setList: fn => { list = fn }, setUpdate: fn => { update = fn }, setArea: fn => { areaRead = fn } }
}
test('地址已保存但刷新失败单独提示；默认地址重复点击只发一次', async () => {
  const f = addressFixture(), gate = deferred()
  f.setList(async () => [{ id: 'a', isDefault: 1 }, { id: 'b', isDefault: 1 }])
  await f.page.loadAddresses()
  f.setUpdate(() => gate.promise); f.setList(async () => { throw new Error('offline') })
  const one = f.page.setDefault({ id: 'a', isDefault: 1 })
  await f.page.setDefault({ id: 'b', isDefault: 1 }); assert.equal(f.writes.length, 1)
  gate.resolve(); await one
  assert.equal(f.page.settingDefaultId, '')
  assert.match(f.messages[0], /地址已保存，列表刷新失败/)
  f.setList(async () => [{ id: 'a', isDefault: 0 }]); assert.equal(await f.page.loadAddresses(), true)
  assert.equal(f.writes.length, 1); assert.equal(f.page.refreshError, '')
})
test('地址乱序查询只采用最新结果，省市区失败或空列表允许重读', async () => {
  const f = addressFixture(), first = deferred(), second = deferred(); let calls = 0
  f.setList(() => (++calls === 1 ? first.promise : second.promise))
  const old = f.page.loadAddresses(), current = f.page.loadAddresses()
  second.resolve([{ id: 'new' }]); await current; first.reject(new Error('old')); await old
  assert.equal(f.page.addresses[0].id, 'new'); assert.equal(f.page.loadFailed, false); assert.equal(f.messages.length, 0)
  let reads = 0
  f.setArea(() => { reads++; if (reads === 1) throw new Error('read'); return reads === 2 ? '[]' : '[{"code":"11"}]' })
  assert.equal(f.page.loadAreaData(), false); assert.equal(f.page.loadAreaData(), false)
  assert.equal(f.page.loadAreaData(), true); assert.equal(f.page.loadAreaData(), true); assert.equal(reads, 3)
})
test('结算乱序成功、失败及空车都不覆盖新结果，并保留等待中选择', async () => {
  for (const older of ['success', 'error', 'empty']) {
    const oldGate = deferred(), newGate = deferred(); let reads = 0, pops = 0
    const messages = []
    const Page = pageMethods(base + 'features/cart/src/main/ets/presentation/views/CheckView.ets', 'CheckView', {}, {
      CheckoutSheet: { None: 0 }, util: { generateRandomUUID: () => 'key' }, normalizeCheckoutAddress: value => value,
      GlobalVariable: { DEMO_ORDER_FLOW: false }, storeManager: { getPendingOrder: () => null },
      getPreOrderAPI: () => (++reads === 1 ? oldGate.promise : newGate.promise),
    })
    const page = new Page(); page.safeToast = text => messages.push(text); page.stackPath = { pop: () => pops++ }
    page.user = { token: 'buyer-a' }
    const old = page.loadCheckoutPreview(), current = page.loadCheckoutPreview()
    page.addressManuallySelected = true; page.addressId = 'chosen'
    newGate.resolve({ goods: [{ id: 'new' }], summary: { totalPayPrice: 20 }, userAddresses: [{ id: 'default', isDefault: 0 }, { id: 'chosen', isDefault: 1 }] }); await current
    if (older === 'error') oldGate.reject(new Error('old'))
    else oldGate.resolve({ goods: older === 'empty' ? [] : [{ id: 'old' }], userAddresses: [], summary: { totalPayPrice: 1 } })
    await old
    assert.equal(page.goodsList[0].id, 'new'); assert.equal(page.addressId, 'chosen'); assert.equal(pops, 0); assert.equal(messages.length, 0)
  }
})

class ListDataSource {
  items = []
  loadData(items) { this.items = items }
  addArr(items) { this.items.push(...items) }
  totalCount() { return this.items.length }
  getData(index) { return this.items[index] }
  replaceArr(start, items) { this.items.splice(start, items.length, ...items) }
}
const searchPresentation = execute(sourceOf(base + 'features/home/src/main/ets/data/api/searchPresentation.ets'))
function searchFixture() {
  let search = async () => ({ pageData: { items: [], pages: 1 } }), normalize = async items => items
  const requests = []
  const Page = pageMethods(base + 'features/home/src/main/ets/presentation/views/SearchResultView.ets', 'SearchResultView', {}, {
    ListDataSource, Scroller: class {}, searchFailureMessage: searchPresentation.searchFailureMessage, compareGoodsIds: searchPresentation.compareGoodsIds,
    searchGoodsAPI: query => { requests.push({ ...query }); return search(query) },
    normalizeSearchGoodsPicturesAPI: items => normalize(items),
  })
  return { page: new Page(), requests, setSearch: fn => { search = fn }, setNormalize: fn => { normalize = fn } }
}
test('搜索使用固定快照，旧响应和迟到图片都不能覆盖新查询', async () => {
  const f = searchFixture(), oldGate = deferred(), newGate = deferred(), imageGate = deferred()
  let calls = 0; f.setSearch(() => (++calls === 1 ? oldGate.promise : newGate.promise))
  f.page.params.keyword = 'old'; const old = f.page.loadNextSearchPage()
  f.page.searchInput = '尚未提交'; assert.equal(f.requests[0].keyword, 'old')
  f.page.params.keyword = 'new'; f.page.restartSearch()
  newGate.resolve({ pageData: { items: [{ id: 'new', name: 'new' }], pages: 1 } }); await tick()
  oldGate.resolve({ pageData: { items: [{ id: 'old', name: 'old' }], pages: 1 } }); await old
  assert.equal(f.page.lazyDataSource.items[0].id, 'new'); assert.equal(f.page.loading, false)
  f.setNormalize(() => imageGate.promise)
  const image = f.page.normalizeSearchPictures([{ id: 'new' }], 0, f.page.queryGeneration)
  f.page.queryGeneration++; f.page.lazyDataSource.loadData([{ id: 'next' }]); imageGate.resolve([{ id: 'stale-image' }]); await image
  assert.equal(f.page.lazyDataSource.items[0].id, 'next')
})
test('搜索跨页去重，重复整页继续翻页，同名不同编号保留', async () => {
  const f = searchFixture()
  f.setSearch(async query => ({ pageData: { pages: 3, items: query.page < 3 ? [{ id: 'a', name: '同名' }] : [{ id: 'b', name: '同名' }] } }))
  await f.page.loadNextSearchPage(); await f.page.loadNextSearchPage()
  assert.deepEqual(f.page.lazyDataSource.items.map(item => item.id), ['a', 'b'])
  assert.deepEqual(f.requests.map(item => item.page), [1, 2, 3]); assert.equal(f.page.isFinished, true)
})
test('本地排序立即反馈，后台失败保留临时结果，重试成功才替换', async () => {
  const f = searchFixture()
  f.page.lazyDataSource.loadData([{ id: 'a', price: 30 }, { id: 'b', price: 10 }]); f.page.resultCount = 2
  f.setSearch(async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
  f.page.changeSort('price', 'asc'); await tick()
  assert.deepEqual(Array.from(f.page.lazyDataSource.items, item => item.id), ['b', 'a'])
  assert.equal(f.page.temporarySort, true); assert.match(f.page.failureMessage, /超时/)
  f.setSearch(async () => ({ pageData: { items: [{ id: 'server', price: 1 }], pages: 1 } }))
  await f.page.loadNextSearchPage(); assert.equal(f.page.temporarySort, false); assert.equal(f.page.lazyDataSource.items[0].id, 'server')
})
test('开机时长倒计时不受日期修改影响，并接受前台新的服务端基准', () => {
  let uptime = 100000
  const { secondsLeftToPay, readPhoneClockMillis } = execute(sourceOf(base + 'features/cart/src/main/ets/presentation/utils/OrderPresentation.ets'), {
    '@kit.BasicServicesKit': { systemDateTime: { getUptime: (_type, nanos) => { assert.equal(nanos, false); return uptime }, TimeType: { STARTUP: 0 } } },
  }, { Date: { now: () => { throw new Error('must not read wall clock') } } })
  const baseline = readPhoneClockMillis(); uptime += 12000
  assert.equal(secondsLeftToPay(90, baseline), 78)
  const refreshed = readPhoneClockMillis(); uptime += 1000
  assert.equal(secondsLeftToPay(70, refreshed), 69)
})
