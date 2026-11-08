import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, pageMethods, sourceOf } from './native-harness.mjs'

test('B-10/B-70 旧登录成功、错误密码及协议拦截迁移到真实登录方法', async () => {
  class HuaweiController {
    setAgreementStatus() { return this }
    setEnabled() { return this }
    onClickLoginWithHuaweiIDButton() { return this }
  }
  const saved = [], messages = [], paths = ['login']
  let current, requests = 0
  const Page = pageMethods('mixed-development-h5/features/mine/src/main/ets/presentation/views/LoginView.ets', 'LoginView', {}, {
    loginComponentManager: { LoginWithHuaweiIDButtonController: HuaweiController, AgreementStatus: {} },
    loginAPI: async form => { requests++; if (form.password === 'wrong_password') throw new Error('request'); return { id: 'buyer', account: form.account, token: 'token' } },
    storeManager: { saveUserInfo: async user => { saved.push(user); current = user }, getUserInfo: () => current, getPendingTrade: () => '' },
    auth: { updateCurrentUser: user => { current = user }, getUserInfo: () => current },
    localGoodsStore: { migrateLegacyData: async () => {} }, authCart: { updateCartCount: async () => {} },
    isAuthNetworkError: () => false, isAuthRequestError: () => true,
    GlobalVariable: { DEMO_ORDER_FLOW: false }, PAGE_PATH: { LOGIN_PAGE: 'login' }
  })
  const page = new Page()
  page.safeToast = message => messages.push(message)
  page.stackPath = { getAllPathName: () => paths, pop: () => paths.pop() }
  page.loginForm = { account: 'isolated_buyer', password: 'wrong_password' }
  await page.submitAccountLogin()
  assert.equal(requests, 0); assert.equal(messages.at(-1), '请先勾选协议')
  page.hasAcceptedTerms = true
  await page.submitAccountLogin()
  assert.equal(requests, 1); assert.equal(saved.length, 0); assert.equal(current, undefined)
  assert.deepEqual(paths, ['login']); assert.equal(page.submitting, false)
  page.loginForm.password = 'Device-trade-123'
  await page.submitAccountLogin()
  assert.equal(requests, 2); assert.equal(saved.length, 1); assert.equal(current.account, 'isolated_buyer'); assert.equal(messages.at(-1), '登录成功')
  assert.deepEqual(paths, [])
})

test('B-01 旧空搜索不导航，汉字与拼音按原词交给搜索结果页', () => {
  const source = sourceOf('mixed-development-h5/features/home/src/main/ets/presentation/views/SearchView.ets')
    .replace('struct SearchView', 'export struct SearchView')
  const body = source.slice(source.indexOf('export struct SearchView'), source.indexOf('  build()'))
    .replace('export struct', 'export class').replace(/@\w+(?:\([^)]*\))?\s*/g, '') + '\n}'
  const { SearchView } = execute(body, {}, { PAGE_PATH: { SEARCH_RESULT_PAGE: 'results' } })
  const page = new SearchView(), paths = []
  page.stackPath = { pushPathByName: (name, param) => paths.push({ name, ...param }) }
  page.searchGoods('   '); assert.equal(paths.length, 0)
  page.searchGoods('  设备独立测试商品 '); page.searchGoods('yagao')
  assert.deepEqual(paths, [{ name: 'results', keyword: '设备独立测试商品' }, { name: 'results', keyword: 'yagao' }])
})

test('B-70/B-71 旧收藏足迹隔离及重新登录保留迁移到真实持久存储', async () => {
  const values = new Map()
  let user = { account: 'isolated-a', token: 'token-a' }
  const auth = { getUserInfo: () => user }
  const scope = execute(sourceOf('mixed-development-h5/commons/storage/src/main/ets/AccountScope.ets'), { './Auth': { auth } })
  const { LocalGoodsStore } = execute(sourceOf('mixed-development-h5/commons/storage/src/main/ets/LocalGoodsStore.ets'), {
    './Auth': { auth }, './AccountScope': scope,
    './StoreManager': { storeManager: { getStore: () => ({ getSync: (key, fallback) => values.get(key) ?? fallback,
      putSync: (key, value) => values.set(key, value), flush: async () => {} }) } }
  })
  const local = new LocalGoodsStore()
  const item = { id: 'isolated-goods', name: '商品', price: '1', picture: '', desc: '', orderNum: 0 }
  await local.toggleFavorite(item); await local.recordHistory(item)
  user = { account: 'isolated-b', token: 'token-b' }
  assert.equal(local.getFavorites().length, 0); assert.equal(local.getHistory().length, 0)
  user = { account: 'isolated-a', token: 'renewed' }
  assert.equal(local.getFavorites()[0].id, item.id); assert.equal(local.getHistory()[0].id, item.id)
})

test('B-20 旧未勾选商品不能进入结算迁移到真实购物车方法', () => {
  const { CartOperationHelper } = execute(sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/utils/CartOperations.ets'))
  const Page = pageMethods('mixed-development-h5/features/cart/src/main/ets/presentation/views/CartView.ets', 'CartView', {}, { CartOperations: CartOperationHelper })
  const page = new Page(), messages = [], paths = []
  page.cartList = [{ skuId: 'isolated', count: 1, selected: false }]
  page.getUIContext = () => ({ getPromptAction: () => ({ showToast: value => messages.push(value.message) }) })
  page.stackPath = { pushPath: value => paths.push(value) }
  page.openCheckoutPage()
  assert.deepEqual(paths, []); assert.deepEqual(messages, ['请选择要结算的商品'])
})

test('B-04/B-05 旧未选完整规格连续加购均拦截且无写入', async () => {
  let source = sourceOf('mixed-development-h5/features/home/src/main/ets/presentation/views/GoodsView.ets')
  source = source.slice(source.indexOf('export struct GoodsView'), source.indexOf('  @Builder\n  AddCartBuilder'))
    .replace(/  @Builder\n  \w+\(\) \{[\s\S]*?\n  \}\n/g, '')
    .replace('export struct', 'export class').replace(/@\w+\s*(?:\([^)]*\))?\s*/g, '') + '\n}'
  const messages = [], writes = []
  const user = { account: 'isolated', token: 'token' }
  const { GoodsView } = execute(source, {}, {
    normalizeSkuSelection: () => ({ id: '', specs: [] }), Scroller: class {}, isFallbackSkuId: id => id.startsWith('fallback'),
    auth: { getUserInfo: () => user }, authCart: { addCart: value => writes.push(value) },
    PAGE_PATH: { GOODS_PAGE: 'goods' }
  })
  const page = new GoodsView()
  page.user = user; page.sessionToken = user.token; page.sessionAccount = user.account
  page.isPageActive = true; page.detailReady = true
  page.goods = { id: 'isolated-goods', skus: [{ id: 'isolated-sku', inventory: 3 }] }
  page.stackPath = { getParamByName: () => [page.goods] }
  page.safeToast = message => messages.push(message)
  assert.equal(await page.addToCart(), false)
  assert.equal(await page.addToCart(), false)
  assert.deepEqual(messages, ['请选择对应的产品规格', '请选择对应的产品规格'])
  assert.deepEqual(writes, [])
})
