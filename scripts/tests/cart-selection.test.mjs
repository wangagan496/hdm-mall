import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { deferred, execute, pageMethods, sourceOf } from './native-harness.mjs'
import { buildApp } from '../../server/src/app.ts'

function pageFixture(overrides = {}) {
  const { CartOperationHelper } = execute(sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/utils/CartOperations.ets'))
  const calls = [], toasts = [], paths = []
  const pending = deferred()
  const CartView = pageMethods('mixed-development-h5/features/cart/src/main/ets/presentation/views/CartView.ets', 'CartView', {}, {
    CartOperations: {
      checkIsAllSelected: CartOperationHelper.checkIsAllSelected,
      calculateTotalPrice: CartOperationHelper.calculateTotalPrice,
      getSelectedCarts: CartOperationHelper.getSelectedCarts,
      toggleSelectAll: selected => { calls.push(selected); return pending.promise },
      updateCartSelection: async () => { throw new Error('unexpected item selection') },
      updateCartCount: async () => { throw new Error('unexpected item count') },
      deleteCartItems: async () => { throw new Error('unexpected deletion') },
      ...overrides,
    },
    PAGE_PATH: { CHECK_ORDER_PAGE: 'checkout' },
    RequestAxios:{putForSession:(_url,body)=>body.count!==undefined?overrides.updateCartCount?.():overrides.updateCartSelection?.()},
    authCart:{updateCartCount:async()=>{}},
  })
  const page = new CartView()
  page.user = { token: 'buyer' }
  page.cartToken = 'buyer'
  page.cartList = [
    { skuId: 'a', selected: true, price: 10, count: 2 },
    { skuId: 'b', selected: false, price: 5, count: 1 },
  ]
  page.getUIContext = () => ({ getPromptAction: () => ({ showToast: value => toasts.push(value.message) }) })
  page.stackPath = { pushPath: value => paths.push(value.name) }
  page.recalculateCartSummary()
  return { page, pending, calls, toasts, paths }
}

test('全选保存期间保留合计，阻止重复提交、其他修改和提前结算，成功后更新', async () => {
  const f = pageFixture()
  const save = f.page.toggleAllGoodsSelection()
  try {
    assert.equal(f.page.isCheckAll, false)
    assert.equal(f.page.allPrice, 20)
    await f.page.toggleAllGoodsSelection()
    await f.page.changeGoodsSelection(f.page.cartList[0], false)
    await f.page.changeGoodsQuantity(f.page.cartList[0], 3)
    await f.page.deleteCartItems(['a'])
    f.page.openCheckoutPage()
    assert.deepEqual(f.calls, [true])
    assert.deepEqual(f.paths, [])
    assert.deepEqual(f.toasts, [])
  } finally { f.pending.resolve(); await save }
  assert.equal(f.page.isCheckAll, true)
  assert.equal(f.page.allPrice, 25)
  f.page.openCheckoutPage()
  assert.deepEqual(f.paths, ['checkout'])
})

test('全选失败保留原混合勾选和金额，提示后允许重试', async () => {
  let attempts = 0
  const f = pageFixture({ toggleSelectAll: async () => {
    if (++attempts === 1) throw new Error('offline')
  } })
  await f.page.toggleAllGoodsSelection()
  assert.equal(f.page.cartList[0].selected, true)
  assert.equal(f.page.cartList[1].selected, false)
  assert.equal(f.page.allPrice, 20)
  assert.equal(f.page.isCheckAll, false)
  assert.deepEqual(f.toasts, ['全选状态更新失败，请重试'])
  await f.page.toggleAllGoodsSelection()
  assert.equal(attempts, 2)
  assert.equal(f.page.allPrice, 25)
})

test('单件勾选或数量仍在保存时不并发全选，失败后释放操作限制', async () => {
  for (const method of ['changeGoodsSelection', 'changeGoodsQuantity']) {
    const pending = deferred()
    const f = pageFixture({ updateCartSelection: () => pending.promise, updateCartCount: () => pending.promise })
    const save = f.page[method](f.page.cartList[0], method === 'changeGoodsSelection' ? false : 3)
    await new Promise(resolve=>setTimeout(resolve,140))
    const toggle = f.page.toggleAllGoodsSelection()
    try {
      assert.deepEqual(f.calls, [])
    } finally {
      pending.reject(new Error('offline'))
      f.pending.resolve()
      await Promise.all([save, toggle])
    }
    await f.page.toggleAllGoodsSelection()
    assert.deepEqual(f.calls, [true])
  }
})

test('全选晚到结果不覆盖刷新后的列表或切换后的账号', async () => {
  for (const changed of ['list', 'account']) {
    const f = pageFixture()
    const save = f.page.toggleAllGoodsSelection()
    if (changed === 'list') {
      f.page.cartList = [{ skuId: 'new', selected: false, count: 1, price: 50 }]
      f.page.recalculateCartSummary()
    } else {
      f.page.user = { token: 'another-buyer' }
    }
    f.pending.resolve()
    await save
    assert.equal(f.page.cartList.at(-1).selected, false)
    assert.equal(f.page.isCheckAll, false)
    assert.equal(f.page.allPrice, changed === 'list' ? 0 : 20)
    assert.deepEqual(f.toasts, [])
  }
})

async function fixture() {
  const f = await buildApp({ databasePath: ':memory:', uploadsPath: './unused', publicUrl: 'http://fixture', mockPayments: true })
  f.accounts.register('cart_native', 'test-password-123')
  const login = f.accounts.login('cart_native', 'test-password-123')
  const headers = { authorization: `Bearer ${login.token}` }
  const requests = []
  let badges = 0
  const api = execute(sourceOf('mixed-development-h5/features/cart/src/main/ets/data/api/cart.ets'), {
    network: { RequestAxios: { put: async (url, payload) => {
      requests.push({ url, payload: JSON.parse(JSON.stringify(payload)) })
      const response = await f.app.inject({ method: 'PUT', url, headers, payload: JSON.stringify(payload) })
      // inject 的字符串正文也走服务端 JSON 解析。
      if (response.statusCode >= 400) throw new Error(`HTTP ${response.statusCode}`)
      return response.json().result
    } } },
  })
  headers['content-type'] = 'application/json'
  const { CartOperationHelper } = execute(sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/utils/CartOperations.ets'), {
    '../../data/api': api,
    storage: { authCart: { updateCartCount: async () => { badges++ } } },
  })
  for (const skuId of ['hdm-1-a', 'hdm-2-a']) {
    const response = await f.app.inject({ method: 'POST', url: '/member/cart', headers, payload: { skuId, count: 2, requestKey: randomUUID() } })
    assert.equal(response.statusCode, 200)
  }
  const items = async () => (await f.app.inject({ method: 'GET', url: '/member/cart', headers })).json().result
  return { ...f, helper: CartOperationHelper, items, requests, badges: () => badges }
}

test('原生全选和取消全选通过真实路由，正文仅提交勾选状态', async () => {
  const f = await fixture()
  try {
    for (const selected of [false, true]) {
      await f.helper.toggleSelectAll(selected)
      assert.ok((await f.items()).every(item => item.selected === selected && item.count === 2))
      assert.deepEqual(f.requests.at(-1), { url: '/member/cart/selected', payload: { selected } })
    }
    assert.equal(f.badges(), 2)
  } finally { await f.app.close() }
})

test('原生取消售罄商品勾选不校验旧数量，也不覆盖服务端最新数量', async () => {
  const f = await fixture()
  try {
    const cart = (await f.items())[0]
    f.db.run('UPDATE carts SET count=3 WHERE sku_id=?', cart.skuId)
    f.db.run('UPDATE skus SET stock=0 WHERE id=?', cart.skuId)
    await f.helper.updateCartSelection(cart, false)
    assert.equal(cart.selected, false)
    const saved = (await f.items()).find(item => item.skuId === cart.skuId)
    assert.equal(saved.count, 3)
    assert.equal(saved.selected, false)
    assert.deepEqual(f.requests.at(-1).payload, { selected: false })
  } finally { await f.app.close() }
})

test('原生修改数量不覆盖最新勾选，保存失败不提前修改本地数量', async () => {
  const f = await fixture()
  try {
    const cart = (await f.items())[0]
    f.db.run('UPDATE carts SET selected=0 WHERE sku_id=?', cart.skuId)
    await f.helper.updateCartCount(cart, 3)
    assert.equal(cart.count, 3)
    const saved = (await f.items()).find(item => item.skuId === cart.skuId)
    assert.equal(saved.selected, false)
    assert.equal(saved.count, 3)
    assert.deepEqual(f.requests.at(-1).payload, { count: 3 })
    await assert.rejects(f.helper.updateCartCount(cart, 999), /HTTP 409/)
    assert.equal(cart.count, 3)
    assert.equal(f.badges(), 1)
  } finally { await f.app.close() }
})
