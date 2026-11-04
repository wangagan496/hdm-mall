import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, execute, sourceOf, tick } from './native-harness.mjs'

const test = (name, run) => nodeTest(name, { timeout: 3000 }, run)
const goods = (id = 'goods-a') => ({ id, name: id, price: '19', mainPictures: [], specs: [],
  skus: [{ id: id + '-sku', inventory: 5, price: '19', specs: [] }] })
const normalize = sku => ({ id: '', inventory: 0, specs: [], ...sku })
const presentation = execute(sourceOf('mixed-development-h5/features/home/src/main/ets/data/api/goodsPresentation.ets'))
const loginSelection = execute(sourceOf('mixed-development-h5/features/home/src/main/ets/data/api/loginSkuSelection.ets'), {
  './goodsPresentation': presentation, './mockData': { isFallbackSkuId: id => id.startsWith('fallback') },
})
function fixture() {
  let user = { token: 'token-a', account: 'account-a' }, entry = goods()
  const queries = [], writes = [], messages = [], navigations = [], favorites = [], histories = []
  const api = { detail: async value => goods(value.id), evaluations: async () => ({ items: [], counts: 0 }),
    add: async () => {}, favorite: async () => true }
  let source = sourceOf('mixed-development-h5/features/home/src/main/ets/presentation/views/GoodsView.ets')
  source = source.slice(source.indexOf('export struct GoodsView'), source.indexOf('  @Builder\n  AddCartBuilder'))
  source = source.replace(/  @Builder\n  \w+\(\) \{[\s\S]*?\n  \}\n/g, '')
    .replace('export struct', 'export class').replace(/@\w+\s*(?:\([^)]*\))?\s*/g, '') + '\n}'
  const { GoodsView } = execute(source, {}, {
    ...loginSelection,
    normalizeSkuSelection: normalize, isFallbackSkuId: id => id.startsWith('fallback'),
    generateFallbackGoods: value => ({ ...value, skus: [] }), Scroller: class {}, Logger: { info() {} },
    PAGE_PATH: { GOODS_PAGE: 'goods', LOGIN_PAGE: 'login', CHECK_ORDER_PAGE: 'check' },
    auth: { getUserInfo: () => user },
    getDetailAPI: value => { queries.push(['detail', value.id]); return api.detail(value) },
    getGoodsEvaluationsAPI: id => { queries.push(['evaluation', id]); return api.evaluations(id) },
    authCart: { addCart: (...args) => { writes.push(args); return api.add(...args) } },
    localGoodsStore: { isFavorite: () => false,
      recordHistory: async value => histories.push([value.id, user.token]),
      toggleFavorite: value => { favorites.push([value.id, user.token]); return api.favorite(value) } },
  })
  const page = new GoodsView(); page.user = user; page.isPageActive = true
  page.stackPath = { getParamByName: () => entry ? [entry] : [], pushPath: value => navigations.push(value.name) }
  page.getUIContext = () => ({ getPromptAction: () => ({ showToast: value => messages.push(value.message) }) })
  const select = () => { page.sku = normalize(page.goods.skus[0]); page.count = 2 }
  const setUser = (value, notify = true) => { user = value; if (notify) { page.user = value; page.reloadForCurrentAccount?.() } }
  return { page, api, queries, writes, messages, navigations, favorites, histories, select, setUser,
    setEntry: value => { entry = value } }
}

test('详情未就绪、旧规格、售罄及非法数量不能加购，真实规格确认后才提交', async () => {
  const f = fixture(); assert.equal(await f.page.addToCart(), false)
  await f.page.getDetailData(); f.select()
  for (const value of [0, -1, 1.5, 6, 1000, NaN]) {
    f.page.count = value; assert.equal(await f.page.addToCart(), false, String(value))
  }
  f.page.count = 1; f.page.sku = { id: 'other-sku', inventory: 10 }
  assert.equal(await f.page.addToCart(), false)
  f.select(); f.page.goods.skus[0].inventory = 0
  assert.equal(await f.page.addToCart(), false); assert.equal(f.writes.length, 0)
  f.page.goods.skus[0].inventory = 5; assert.equal(await f.page.addToCart(), true)
  assert.deepEqual(JSON.parse(JSON.stringify(f.writes[0])), [{ skuId: 'goods-a-sku', count: 2 }, 'token-a'])
})

test('匿名加购去登录，返回后读取最新详情恢复规格数量并打开弹层，不自动提交', async () => {
  const f = fixture(); f.setUser({ token: '', account: '' }, false); f.page.user = { token: '', account: '' }
  await f.page.getDetailData(); f.select(); f.page.showSheet = true
  await f.page.buyQuickly(); f.page.hideGoods()
  f.setUser({ token: 'logged-in', account: 'buyer' })
  const gate = deferred(); f.api.detail = () => gate.promise; f.page.showGoods()
  assert.equal(f.page.showSheet, false); assert.equal(f.page.detailReady, false)
  const latest = goods(); latest.skus[0].price = '29'; latest.skus[0].inventory = 3
  gate.resolve(latest); await tick()
  assert.equal(f.page.sku.id, 'goods-a-sku'); assert.equal(f.page.count, 2)
  assert.equal(f.page.sku.price, '29'); assert.equal(f.page.sku.inventory, 3)
  assert.equal(f.page.showSheet, true); assert.equal(f.writes.length, 0)
})

test('登录后原规格移除或库存不足会清空并提示，取消登录或切换账号不恢复', async () => {
  for (const change of ['removed', 'stock', 'cancel', 'account', 'destroy']) {
    const f = fixture(); f.setUser({ token: '', account: '' }, false); f.page.user = { token: '', account: '' }
    await f.page.getDetailData(); f.select(); await f.page.addToCart(); f.page.hideGoods()
    if (change !== 'cancel') f.setUser({ token: 'login-a', account: 'buyer-a' })
    if (change === 'account') f.setUser({ token: 'login-b', account: 'buyer-b' })
    if (change === 'destroy') f.page.aboutToDisappear()
    f.api.detail = async () => {
      const latest = goods()
      if (change === 'removed') latest.skus[0].id = 'replacement'
      if (change === 'stock') latest.skus[0].inventory = 1
      return latest
    }
    f.page.showGoods(); await tick()
    assert.equal(f.page.sku.id, '', change); assert.equal(f.page.count, 1, change)
    assert.equal(f.page.showSheet, ['removed', 'stock'].includes(change), change)
    assert.equal(f.messages.includes('原选规格或数量已失效，请重新选择'), ['removed', 'stock'].includes(change))
    assert.equal(f.writes.length, 0)
  }
})

test('当前立即购买等待加购成功且重复点击只提交一次，失败不跳结算', async () => {
  const f = fixture(), gate = deferred(); await f.page.getDetailData(); f.select()
  f.api.add = () => gate.promise; const buying = f.page.buyQuickly()
  await f.page.buyQuickly(); assert.equal(f.writes.length, 1); assert.equal(f.navigations.length, 0)
  f.page.count = 4; gate.resolve(); await buying
  assert.deepEqual(f.navigations, ['check']); assert.equal(f.writes[0][0].count, 2)
  f.api.add = async () => { throw new Error('offline') }; await f.page.buyQuickly()
  assert.deepEqual(f.navigations, ['check']); assert.equal(f.page.loading, false)
})

test('离页重进、换账号或换商品后旧加购成功失败不跳转提示或释放新锁', async () => {
  for (const change of ['reenter', 'account', 'goods']) for (const failed of [false, true]) {
    const f = fixture(), old = deferred(), current = deferred(); await f.page.getDetailData(); f.select()
    f.api.add = () => old.promise; const previous = f.page.buyQuickly()
    if (change === 'reenter') { f.page.aboutToDisappear(); f.page.aboutToAppear() }
    if (change === 'account') f.setUser({ token: 'token-b', account: 'account-b' })
    if (change === 'goods') { f.page.aboutToDisappear(); f.setEntry(goods('goods-b')); f.page.aboutToAppear() }
    await tick(); f.select(); f.api.add = () => current.promise; const next = f.page.buyQuickly()
    assert.equal(f.writes.length, 2, change)
    f.messages.length = 0
    if (failed) old.reject(new Error('old')); else old.resolve()
    await previous
    assert.equal(f.page.loading, true, change); assert.equal(f.page.showLoadingDialog, true, change)
    assert.equal(f.navigations.length, 0); assert.equal(f.messages.length, 0)
    current.resolve(); await next; assert.deepEqual(f.navigations, ['check'])
  }
})

test('账号监听前阻止旧操作，账号切换关闭旧选择和收藏，资料更新不重复读', async () => {
  const f = fixture(); await f.page.getDetailData(); f.select(); f.page.showSheet = true; f.page.isFavorite = true
  const other = { token: 'token-b', account: 'account-b' }; f.setUser(other, false)
  assert.equal(await f.page.addToCart(), false); await f.page.toggleFavorite()
  assert.equal(f.writes.length, 0); assert.equal(f.favorites.length, 0)
  const gate = deferred(); f.api.detail = () => gate.promise; f.setUser(other)
  assert.equal(f.page.showSheet, false); assert.equal(f.page.isFavorite, false); assert.equal(f.page.sku.id, '')
  gate.resolve(goods()); await tick(); const count = f.queries.length
  f.setUser({ ...other, nickname: 'new' }); await tick(); assert.equal(f.queries.length, count)
})

test('旧详情成功失败不写新账号足迹、不覆盖新详情或关闭新加载', async () => {
  for (const failed of [false, true]) {
    const f = fixture(), old = deferred(), current = deferred(); f.api.detail = () => old.promise
    const previous = f.page.getDetailData(); f.api.detail = () => current.promise
    f.setUser({ token: 'token-b', account: 'account-b' })
    if (failed) old.reject(new Error('old')); else old.resolve(goods())
    await previous
    assert.equal(f.page.showLoadingDialog, true); assert.equal(f.histories.length, 0); assert.equal(f.messages.length, 0)
    current.resolve(goods()); await tick(); assert.deepEqual(f.histories, [['goods-a', 'token-b']])
    assert.equal(f.page.detailReady, true)
  }
})

test('隐藏详情不读写，返回重读，旧评价不影响新商品及新加载', async () => {
  const f = fixture(), old = deferred(), current = deferred(); f.api.evaluations = () => old.promise
  await f.page.getDetailData(); f.select(); f.page.aboutToDisappear()
  const count = f.queries.length; await f.page.getDetailData(); await f.page.toggleFavorite(); await f.page.addToCart()
  f.page.refreshAfterForeground?.(); assert.equal(f.queries.length, count); assert.equal(f.favorites.length, 0); assert.equal(f.writes.length, 0)
  f.setEntry(goods('goods-b')); f.api.evaluations = () => current.promise; f.page.aboutToAppear(); await tick()
  old.resolve({ items: [{ id: 'old' }], counts: 1 }); await tick()
  assert.equal(f.page.evaluations.length, 0); assert.equal(f.page.evaluationLoading, true)
  current.resolve({ items: [{ id: 'new' }], counts: 1 }); await tick()
  assert.equal(f.page.evaluations[0].id, 'new')
  const visibleCount = f.queries.length; f.page.refreshAfterForeground(); await tick()
  assert.equal(f.queries.length, visibleCount + 2)
  f.api.evaluations = async () => { throw new Error('offline') }; await f.page.loadEvaluations('goods-b')
  assert.deepEqual(f.messages, ['商品评价加载失败，请稍后重试'])
})

test('收藏连续点击只修改一次，旧收藏成功失败不覆盖重进后的状态', async () => {
  for (const failed of [false, true]) {
    const f = fixture(), old = deferred(), current = deferred(); await f.page.getDetailData()
    f.api.favorite = () => old.promise; const first = f.page.toggleFavorite(); const duplicate = f.page.toggleFavorite()
    assert.equal(f.favorites.length, 1)
    f.page.aboutToDisappear(); f.page.aboutToAppear(); await tick()
    f.api.favorite = () => current.promise; const second = f.page.toggleFavorite()
    assert.equal(f.favorites.length, 2)
    if (failed) old.reject(new Error('old')); else old.resolve(true)
    await first; await duplicate
    assert.equal(f.page.isFavorite, false); assert.equal(f.messages.length, 0); assert.equal(f.page.favoriteSaving, true)
    current.resolve(true); await second
    assert.equal(f.page.isFavorite, true); assert.equal(f.page.favoriteSaving, false); assert.deepEqual(f.messages, ['收藏成功'])
  }
})

test('匿名仍可浏览收藏和记录足迹，加购只进入登录且缺失路由清除旧商品', async () => {
  const f = fixture(); f.setUser({ token: '', account: '' }, false); f.page.user = { token: '', account: '' }
  await f.page.getDetailData(); f.select(); await f.page.toggleFavorite()
  assert.equal(f.page.isFavorite, true); assert.deepEqual(f.histories, [['goods-a', '']])
  assert.equal(await f.page.addToCart(), false); assert.deepEqual(f.navigations, ['login']); assert.equal(f.writes.length, 0)
  f.setEntry(undefined); await f.page.getDetailData()
  assert.equal(f.page.goods.id, undefined); assert.equal(f.page.detailFailed, true); assert.equal(f.page.isFavorite, false)
})

test('刷新清除旧评价与规格，错误商品详情不冒充成功，加购期间不自动刷新', async () => {
  const f = fixture(); await f.page.getDetailData(); f.select()
  f.page.evaluations = [{ id: 'old' }]; f.page.evaluationCount = 1
  f.api.detail = async () => goods('wrong'); await f.page.getDetailData()
  assert.equal(f.page.detailReady, false); assert.equal(f.page.detailFailed, true)
  assert.equal(f.page.evaluations.length, 0); assert.equal(f.page.sku.id, '')
  f.api.detail = async value => goods(value.id); await f.page.getDetailData(); f.select()
  const gate = deferred(); f.api.add = () => gate.promise; const adding = f.page.addToCart()
  const count = f.queries.length; f.page.refreshAfterForeground?.(); await f.page.getDetailData()
  assert.equal(f.queries.length, count); gate.resolve(); assert.equal(await adding, true)
})

function cartFixture() {
  let user = { token: 'token-a' }
  const writes = [], reads = []
  const api = { post: async () => {}, get: async () => ({ count: 1 }) }
  const { AuthCart } = execute(sourceOf('mixed-development-h5/commons/storage/src/main/ets/AuthCart.ets'), {
    constants: { BusinessVariable: { CART_COUNT: 'count', UPDATE_CART_LIST: 'update' } },
    network: { executeGetWithRetry: action => action(), RequestAxios: {
      post: (...args) => { writes.push(['dynamic', ...args]); return api.post(...args) },
      postWithSession: (...args) => { writes.push(['fixed', ...args]); return api.post(...args) },
      get: (...args) => { reads.push(['dynamic', ...args]); return api.get(...args) },
      getForSession: (...args) => { reads.push(['fixed', ...args]); return api.get(...args) },
    } }, './Auth': { auth: { getUserInfo: () => user } },
    './StoreManager': { storeManager: { getFormId: () => [] } },
    '@kit.FormKit': { formBindingData: { createFormBindingData: value => value } },
  }, { AppStorage: { setOrCreate() {} } })
  return { cart: new AuthCart(), api, writes, reads, setUser: value => { user = value } }
}

test('加购拒绝过期调用凭证，固定发起凭证，旧加购完成不刷新新账号角标', async () => {
  const f = cartFixture(); f.setUser({ token: 'token-b' })
  await assert.rejects(f.cart.addCart({ skuId: 'sku', count: 1 }, 'token-a'), /登录状态/)
  assert.equal(f.writes.length, 0)
  f.setUser({ token: 'token-a' }); const gate = deferred(); f.api.post = () => gate.promise
  const adding = f.cart.addCart({ skuId: 'sku', count: 2 }, 'token-a')
  f.setUser({ token: 'token-b' }); gate.resolve(); await adding; await tick()
  assert.equal(f.reads.length, 0)
  assert.deepEqual(f.writes, [['fixed', '/member/cart', { skuId: 'sku', count: 2 }, 'token-a']])
})

test('当前加购成功后查询原账号角标，写失败不重发也不读取角标', async () => {
  const f = cartFixture(); await f.cart.addCart({ skuId: 'sku', count: 2 }, 'token-a'); await tick()
  assert.deepEqual(f.reads, [['fixed', '/member/cart/count', 'token-a']])
  f.api.post = async () => { throw new Error('offline') }
  await assert.rejects(f.cart.addCart({ skuId: 'sku', count: 2 }, 'token-a'), /offline/)
  assert.equal(f.writes.length, 2); assert.equal(f.reads.length, 1)
})
