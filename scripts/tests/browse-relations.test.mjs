import { emptyCancelActions, cancelActionFailure } from './cancel-boundaries.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, execute, pageMethods, sourceOf, tick } from './native-harness.mjs'

const base = 'mixed-development-h5/'
const pageResult = (page, items, pages = 3) => ({ page, items, pages, counts: pages * 10, pageSize: 10 })
class ListDataSource {
  items = []
  loadData(items) { this.items = items }
  addArr(items) { this.items.push(...items) }
  totalCount() { return this.items.length }
  getData(index) { return this.items[index] }
}
function homeFixture() {
  const api = { read: async p => pageResult(p, [{ id: `p${p}` }]), normalize: async items => items,
    core: async () => { throw new Error('offline') } }
  const calls = []
  const Home = pageMethods(base + 'features/home/src/main/ets/presentation/views/HomeView.ets', 'HomeView', {}, {
    ListDataSource, WaterFlowSections: class {}, Scroller: class {},
    getRecommendPageAPI: p => { calls.push(p); return api.read(p) },
    uniqueGoodsById: items => [...new Map(items.map(item => [item.id, item])).values()],
    getDistinctGoods: (items, displayed) => items.filter(item => !displayed.some(old => old.id === item.id)),
    normalizeGoodsSummaryPicturesAPI: items => api.normalize(items), preloadImages: () => {},
    BusinessVariable: {}, emitter: { off: () => {}, on: () => {} },
    getBannerAPI: () => api.core(), getCategoryAPI: () => api.core(), getHotResultAPI: () => api.core(),
    getInVogueAPI: () => api.core(), getOneStopAPI: () => api.core(), getHomeNewAPI: () => api.core(),
    HomeGoodsDeduplication: { processHomeGoods: (saleGoods, hotGoods, oneGoods, newGoods) => ({ saleGoods, hotGoods, oneGoods, newGoods }) },
    fillPromotionGoods: items => items,
  })
  const page = new Home()
  page.syncRecommendSection = () => {}
  return { page, api, calls }
}

test('首页下拉刷新全断网时保留首屏商品，不把已有内容清为空页', async () => {
  const { page } = homeFixture()
  page.newGoods = [{ id: 'saved-new' }]; page.saleGoods = [{ id: 'saved-promo' }]
  await page.getHomeData(true)
  assert.equal(page.newGoods[0]?.id, 'saved-new'); assert.equal(page.saleGoods[0]?.id, 'saved-promo')
  assert.equal(page.loading, false); assert.equal(page.homeLoadFailed, true)
})

test('首页按真实页码追加，整页重复时继续取下一页，末页停止且不扩大请求范围', async () => {
  const { page, api, calls } = homeFixture()
  page.newGoods = [{ id: 'header' }]
  api.read = async p => pageResult(p, p === 1 ? [{ id: 'header' }] : [{ id: 'new' }, { id: 'new' }], 2)
  await page.getRecommend()
  assert.deepEqual(calls, [1, 2])
  assert.deepEqual(Array.from(page.recommendDataSource.items, item => item.id), ['new'])
  assert.equal(page.isFinished, true)
  await page.getRecommend(); assert.equal(calls.length, 2)
})

test('首页断网保留已加载推荐及当前页，重试成功后追加且刷新失败不清空旧列表', async () => {
  const { page, api, calls } = homeFixture()
  await page.getRecommend()
  api.read = async () => { throw new Error('offline') }
  await page.getRecommend()
  assert.equal(page.page, 2); assert.equal(page.recommendRequesting, false)
  assert.equal(page.recommendDataSource.items[0].id, 'p1')
  api.read = async p => pageResult(p, [{ id: 'p2' }])
  await page.getRecommend(); assert.deepEqual(calls, [1, 2, 2])
  api.read = async () => { throw new Error('offline') }
  await page.refreshRecommendations()
  assert.equal(page.recommendDataSource.items.length, 2); assert.equal(page.page, 1)
  api.read = async p => pageResult(p, [{ id: 'fresh' }], 1)
  await page.getRecommend()
  assert.deepEqual(Array.from(page.recommendDataSource.items, item => item.id), ['fresh'])
})

test('首页刷新和离页使旧请求与迟到图片失效，不覆盖新结果或提前释放加载锁', async () => {
  for (const boundary of ['network', 'image']) {
    const { page, api } = homeFixture(), old = deferred(), current = deferred()
    if (boundary === 'network') api.read = () => old.promise
    else api.normalize = () => old.promise
    const loading = page.getRecommend(); await tick()
    api.read = () => current.promise; api.normalize = async items => items
    const refresh = page.refreshRecommendations()
    old.resolve(boundary === 'network' ? pageResult(1, [{ id: 'old' }]) : [{ id: 'old' }])
    await loading
    assert.equal(page.recommendRequesting, true)
    current.resolve(pageResult(1, [{ id: 'new' }], 1)); await refresh
    assert.equal(page.recommendDataSource.items[0].id, 'new')
  }
  const { page, api } = homeFixture(), gate = deferred()
  api.read = () => gate.promise
  const loading = page.getRecommend(); page.aboutToDisappear()
  gate.resolve(pageResult(1, [{ id: 'late' }])); await loading
  assert.equal(page.recommendDataSource.items.length, 0)
})

test('首页和分类使用轻量入口，推荐和代付选择发送固定页大小与固定会话', async () => {
  const calls = []
  const network = { RequestAxios: {
    get: async (...args) => { calls.push(args); return args[0].includes('/category/') ? [{ id: 'parent', children: [{ id: 'child' }] }] : pageResult(1, [{ id: 'goods' }]) },
    getForSession: async (...args) => { calls.push(args); return pageResult(1, []) },
  } }
  const home = execute(sourceOf(base + 'features/home/src/main/ets/data/api/home.ets'), { network })
  const category = execute(sourceOf(base + 'features/category/src/main/ets/data/api/index.ets'), { network })
  const cart = execute(sourceOf(base + 'features/cart/src/main/ets/data/api/cart.ets'), { network })
  await home.getCategoryAPI(); await category.getCategoryTopAPI()
  assert.equal((await home.getHomeNewAPI())[0].id, 'goods')
  await home.getRecommendPageAPI(3); await cart.getPayerRelationsPageAPI(2, 'fixed-token')
  assert.deepEqual(calls, [['/category/summary'], ['/category/summary'], ['/home/new/page?page=1&pageSize=8'],
    ['/home/recommend/page?page=3&pageSize=8'], ['/member/relations/page?scope=payer&page=2&pageSize=10', 'fixed-token']])
})

test('亲友关系与订单页码独立，解除末页关系后回退，失败保留原页和数据', async () => {
  const calls = [], api = { relations: async p => pageResult(p, [{ id: `r${p}` }]) }
  const Family = pageMethods(base + 'features/mine/src/main/ets/presentation/views/FamilyView.ets', 'FamilyView', {}, {
    cancelActions: emptyCancelActions, cancelActionFailure,
    getFamilyRelationsPageAPI: async (p, token) => { calls.push([p, token]); return api.relations(p) },
    getFamilyOrdersPageAPI: async p => pageResult(p, []), getMerchantOrdersPageAPI: async p => pageResult(p, []),
  })
  const page = new Family(); page.user = { role: 'merchant', token: 'fixed' }
  await page.loadFamilyCenter()
  calls.length = 0
  await page.loadFamilyCenter(2, 3, 3)
  assert.equal(page.relationPage, 3); assert.equal(page.familyPage, 2); assert.equal(page.merchantPage, 3)
  api.relations = async p => pageResult(p, p === 3 ? [] : [{ id: 'last' }], 2)
  await page.loadFamilyCenter()
  assert.equal(page.relationPage, 2); assert.equal(page.familyRelations[0].id, 'last')
  assert.deepEqual(calls, [[3, 'fixed'], [3, 'fixed'], [2, 'fixed']])
  api.relations = async () => { throw new Error('offline') }
  await page.loadFamilyCenter(2, 3, 1)
  assert.equal(page.relationPage, 2); assert.equal(page.familyRelations[0].id, 'last'); assert.match(page.errorText, /加载失败/)
})

function payFixture() {
  const source = sourceOf(base + 'features/cart/src/main/ets/presentation/views/PayView.ets')
  const body = source.slice(source.indexOf('struct PayView {'), source.indexOf('  build()'))
    .replace('struct PayView', 'export class PayView').replace(/@\w+(?:\([^)]*\))?\s*/g, '') + '\n}'
  const api = { user: { token: 'token' }, read: async p => pageResult(p, [{ id: `r${p}`, friendId: `f${p}` }]) }, calls = []
  const { PayView } = execute(body, {}, {
    ...execute(sourceOf('mixed-development-h5/commons/storage/src/main/ets/RecoveryQuery.ets'), {}, {
      setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer },
    }),
    auth: { getUserInfo: () => api.user }, readPhoneClockMillis: () => 1,
    getOrderDetailAPI: async (_id, token) => { calls.push(['order', token]); return { id: 'order', orderState: 1, canInvitePayer: true } },
    getPayerRelationsPageAPI: async (p, token) => { calls.push(['relations', p, token]); return api.read(p) },
  })
  const page = new PayView(); page.orderId = 'order'; page.mergedState = () => 1
  return { page, api, calls }
}

test('代付亲友分页只切换已确认结果，失败明确展示并保留原页，末页解绑自动回退', async () => {
  const { page, api, calls } = payFixture()
  await page.load()
  await page.load(2); assert.equal(page.relativePage, 2); assert.equal(page.relatives[0].id, 'r2')
  api.read = async () => { throw new Error('offline') }
  await page.load(3)
  assert.equal(page.relativePage, 2); assert.equal(page.relatives[0].id, 'r2')
  assert.equal(page.relativesLoadFailed, true); assert.equal(page.loading, false)
  api.read = async p => pageResult(p, p === 3 ? [] : [{ id: 'last' }], 2)
  await page.load(3)
  assert.equal(page.relativePage, 2); assert.equal(page.relatives[0].id, 'last'); assert.equal(page.relativesLoadFailed, false)
  assert.ok(calls.every(call => call.at(-1) === 'token'))
})

test('代付列表迟到请求不覆盖新页，离页或换账号后不回写旧亲友', async () => {
  const { page, api } = payFixture(), gate = deferred()
  api.read = () => gate.promise
  const old = page.load(2); await tick()
  api.read = async p => pageResult(p, [{ id: 'latest' }])
  await page.load(3)
  gate.resolve(pageResult(2, [{ id: 'old' }])); await old
  assert.equal(page.relativePage, 3); assert.equal(page.relatives[0].id, 'latest')
  for (const action of ['leave', 'logout']) {
    const f = payFixture(), pending = deferred(); f.api.read = () => pending.promise
    const loading = f.page.load(); await tick()
    if (action === 'leave') f.page.aboutToDisappear()
    else { f.api.user = { token: '' }; f.page.user = { token: '' }; f.page.reloadForCurrentAccount() }
    pending.resolve(pageResult(1, [{ id: 'private' }])); await loading
    assert.equal(f.page.relatives.length, 0)
  }
})
