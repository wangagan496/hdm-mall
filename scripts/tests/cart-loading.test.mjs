import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, execute, pageMethods, sourceOf, tick } from './native-harness.mjs'

const item = (skuId, price = 10) => ({ skuId, selected: true, count: 2, price })
function fixture(operations = {}) {
  const requests = [], paths = [], toasts = []
  const request = (url, token) => {
    const gate = deferred()
    requests.push({ url, token, ...gate })
    return gate.promise
  }
  const api = execute(sourceOf('mixed-development-h5/features/cart/src/main/ets/data/api/cart.ets'), {
    network: { RequestAxios: { get: request, getWithoutToast: request, getForSession: request } },
  })
  const { CartOperationHelper } = execute(sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/utils/CartOperations.ets'))
  const CartView = pageMethods('mixed-development-h5/features/cart/src/main/ets/presentation/views/CartView.ets', 'CartView', {}, {
    ...api, CartOperations: Object.assign(class extends CartOperationHelper {}, operations),
    ...execute(sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/utils/CartPresentation.ets')),
    CartGoodsModel: class { constructor(value) { Object.assign(this, value) } },
    BusinessVariable: { UPDATE_CART_LIST: 'cart' },
    PAGE_PATH: { CART_PAGE: 'cart', CHECK_ORDER_PAGE: 'checkout' },
  })
  const page = new CartView()
  page.user = { token: 'buyer-a' }
  page.stackPath = { getParamByName: () => [], pushPath: value => paths.push(value.name) }
  page.getUIContext = () => ({
    getHostContext: () => ({ eventHub: { on() {}, off() {} } }),
    getPromptAction: () => ({ showToast: value => toasts.push(value.message) }),
  })
  return { page, requests, paths, toasts }
}

test('B-16/B-71: 标签和独立购物车各自监听与清理，换账号迟到结果不串页', async () => {
  const tab = fixture(), standalone = fixture(), listeners = new Set()
  const eventHub = { on: (_event, listener) => listeners.add(listener), off: (_event, listener) => listeners.delete(listener) }
  for (const current of [tab, standalone]) current.page.getUIContext = () => ({ getHostContext: () => ({ eventHub }) })
  standalone.page.standalone = true
  tab.page.aboutToAppear(); standalone.page.aboutToAppear()
  assert.equal(tab.page.showBackIcon, false)
  assert.equal(standalone.page.showBackIcon, true)
  assert.equal(listeners.size, 2)
  tab.requests[0].resolve([item('previous')]); standalone.requests[0].resolve([item('previous')]); await tick()
  for (const listener of listeners) listener()
  standalone.page.aboutToDisappear()
  assert.equal(listeners.size, 1)
  tab.page.user = { token: 'buyer-b' }; tab.page.reloadForCurrentAccount()
  tab.requests[2].resolve([item('current')]); await tick()
  tab.requests[1].resolve([item('old')]); standalone.requests[1].resolve([item('old')]); await tick()
  assert.equal(tab.page.cartList[0].skuId, 'current')
  assert.equal(standalone.page.cartList[0].skuId, 'previous')
  tab.page.aboutToDisappear(); assert.equal(listeners.size, 0)
})

test('购物车乱序成功和失败不覆盖最新列表或提前结束最新查询', async () => {
  for (const oldFails of [false, true]) {
    const f = fixture()
    const old = f.page.loadCartList()
    const latest = f.page.loadCartList()
    if (oldFails) f.requests[0].reject(new Error('old failure'))
    else f.requests[0].resolve([item('old')])
    await old
    assert.equal(f.page.loading, true)
    assert.equal(f.page.cartList.length, 0)
    assert.equal(f.page.loadFailed, false)
    f.requests[1].resolve([item('latest', 30)])
    await latest
    assert.equal(f.page.cartList[0].skuId, 'latest')
    assert.equal(f.page.allPrice, 60)
    assert.equal(f.page.loading, false)

    const slow = f.page.loadCartList()
    const fast = f.page.loadCartList()
    f.requests[3].resolve([item('newest', 40)])
    await fast
    if (oldFails) f.requests[2].reject(new Error('late failure'))
    else f.requests[2].resolve([item('stale')])
    await slow
    assert.equal(f.page.cartList[0].skuId, 'newest')
    assert.equal(f.page.allPrice, 80)
    assert.equal(f.page.loadFailed, false)
  }
})

test('购物车刷新失败保留商品勾选和金额，恢复查询后才能结算', async () => {
  const f = fixture()
  let loading = f.page.loadCartList()
  f.requests[0].resolve([item('saved', 15)])
  await loading
  loading = f.page.loadCartList()
  assert.equal(f.page.cartList[0].skuId, 'saved')
  f.requests[1].reject(new Error('offline'))
  await loading
  assert.equal(f.page.cartList[0].skuId, 'saved')
  assert.equal(f.page.isCheckAll, true)
  assert.equal(f.page.allPrice, 30)
  assert.equal(f.page.loadFailed, true)
  f.page.openCheckoutPage()
  assert.deepEqual(f.paths, [])
  loading = f.page.loadCartList()
  f.requests[2].resolve([item('saved', 20)])
  await loading
  assert.equal(f.page.loadFailed, false)
  assert.equal(f.page.allPrice, 40)
  f.page.openCheckoutPage()
  assert.deepEqual(f.paths, ['checkout'])
})

test('换账号立即移除旧购物车，新账号失败不展示旧数据且旧回应无效', async () => {
  const f = fixture()
  const initial = f.page.loadCartList()
  f.requests[0].resolve([item('a')])
  await initial
  const old = f.page.loadCartList()
  f.page.user = { token: 'buyer-b' }
  const current = f.page.loadCartList()
  assert.equal(f.page.cartList.length, 0)
  assert.equal(f.page.allPrice, 0)
  f.requests[2].reject(new Error('b offline'))
  await current
  f.requests[1].resolve([item('late-a')])
  await old
  assert.equal(f.page.cartList.length, 0)
  assert.equal(f.page.loadFailed, true)
  assert.equal(f.page.loading, false)
})

test('购物车查询绑定发起时凭证，退出不发匿名请求也不接收旧回应', async () => {
  const f = fixture()
  const old = f.page.loadCartList()
  assert.deepEqual(f.requests.map(({ url, token }) => ({ url, token })), [{ url: '/member/cart', token: 'buyer-a' }])
  f.page.user = { token: '' }
  await f.page.loadCartList()
  assert.equal(f.requests.length, 1)
  assert.equal(f.page.loading, false)
  f.requests[0].resolve([item('late')])
  await old
  assert.equal(f.page.cartList.length, 0)
  assert.equal(f.page.loadFailed, false)
})

test('离开购物车使查询失效，重进后旧请求不能结束新加载或写回商品', async () => {
  const f = fixture()
  const old = f.page.loadCartList()
  f.page.aboutToDisappear()
  f.page.aboutToAppear()
  f.requests[0].resolve([item('old')])
  await old
  assert.equal(f.page.loading, true)
  assert.equal(f.page.cartList.length, 0)
  f.requests[1].resolve([item('current')])
  await tick()
  assert.equal(f.page.cartList[0].skuId, 'current')
  assert.equal(f.page.loading, false)
})

test('账号变化监听自动重载，资料更新不重复查询，首次失败可以重试为空车', async () => {
  const f = fixture()
  const initial = f.page.loadCartList()
  f.requests[0].reject(new Error('offline'))
  await initial
  assert.equal(f.page.loadFailed, true)
  assert.equal(f.page.cartList.length, 0)
  f.page.user = { token: 'buyer-b' }
  f.page.reloadForCurrentAccount()
  assert.equal(f.requests[1].token, 'buyer-b')
  f.requests[1].resolve([])
  await tick()
  assert.equal(f.page.loadFailed, false)
  assert.equal(f.page.loading, false)
  assert.equal(f.page.isCheckAll, false)
  f.page.user = { token: 'buyer-b', nickname: 'new nickname' }
  f.page.reloadForCurrentAccount()
  assert.equal(f.requests.length, 2)
})

test('换账号或离页重进后，旧修改和删除回应不影响新列表、提示或新操作等待', async () => {
  for (const transition of ['account', 'leave']) {
    for (const fails of [false, true]) {
      for (const method of ['changeGoodsSelection', 'changeGoodsQuantity', 'toggleAllGoodsSelection', 'deleteCartItems']) {
        const oldGate = deferred(), newGate = deferred()
        let calls = 0
        const operation = () => ++calls === 1 ? oldGate.promise : newGate.promise
        const f = fixture({ updateCartSelection: operation, updateCartCount: operation,
          toggleSelectAll: operation, deleteCartItems: operation })
        const initial = f.page.loadCartList()
        f.requests[0].resolve([item('same-sku')])
        await initial
        const invoke = () => method === 'deleteCartItems' ? f.page[method](['same-sku'])
          : method === 'toggleAllGoodsSelection' ? f.page[method]()
          : f.page[method](f.page.cartList[0], method === 'changeGoodsQuantity' ? 3 : false)
        const oldSave = invoke()
        if (transition === 'account') {
          f.page.user = { token: 'buyer-b' }
          f.page.reloadForCurrentAccount()
        } else {
          f.page.aboutToDisappear()
          f.page.aboutToAppear()
        }
        f.requests[1].resolve([item('same-sku', 40)])
        await tick()
        const newSave = invoke()
        assert.equal(calls, 2)
        if (fails) oldGate.reject(new Error('late failure'))
        else oldGate.resolve()
        await oldSave
        assert.equal(f.page.cartList[0].skuId, 'same-sku')
        assert.equal(f.page.allPrice, 80)
        assert.deepEqual(f.toasts, [])
        const flag = method === 'deleteCartItems' ? 'deleting' : 'updating'
        assert.equal(f.page[flag], true)
        newGate.resolve()
        await newSave
        assert.equal(f.page[flag], false)
      }
    }
  }
})

test('刷新失败保留的旧商品不可继续修改或删除，重试成功后恢复操作', async () => {
  let writes = 0
  const write = async () => { writes++ }
  const f = fixture({ updateCartSelection: write, updateCartCount: write, toggleSelectAll: write, deleteCartItems: write })
  const initial = f.page.loadCartList()
  f.requests[0].resolve([item('saved')])
  await initial
  const failed = f.page.loadCartList()
  f.requests[1].reject(new Error('offline'))
  await failed
  await f.page.changeGoodsSelection(f.page.cartList[0], false)
  await f.page.changeGoodsQuantity(f.page.cartList[0], 3)
  await f.page.toggleAllGoodsSelection()
  await f.page.deleteCartItems(['saved'])
  assert.equal(writes, 0)
  const retry = f.page.loadCartList()
  f.requests[2].resolve([item('saved')])
  await retry
  await f.page.toggleAllGoodsSelection()
  assert.equal(writes, 1)
})
