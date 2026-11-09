import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf } from './native-harness.mjs'

function keyFor(path, list, item, type) {
  const source = sourceOf(path).split(`ForEach(this.${list},`)[1]
  assert.ok(source, `Missing ${list} renderer`)
  const prefix = `}, (${item}: ${type}) => `
  const line = source.split(String.fromCharCode(10)).find(line => line.includes(prefix))
  assert.ok(line, `Missing ${list} key`)
  const expression = line.slice(line.indexOf(prefix) + prefix.length, -1)
  return execute(`export function key(${item}: ${type}) { return ${expression}; }`).key
}

test('订单状态、评价、倒计时基准及商品快照变化均使卡片缓存失效', () => {
  const key = keyFor('mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderView.ets', 'orders', 'order', 'OrderItem')
  const page = { countdownBaseAt: 1000 }
  const order = { id: 'order-1', orderState: 1, countdown: 60, evaluation: null, skus: [{ id: 'sku-1', name: '旧商品' }], payMoney: 10 }
  const initial = key.call(page, order)
  for (const patch of [{ orderState: 2 }, { orderState: 4 }, { evaluation: { content: '评价' } },
    { countdown: 20 }, { payMoney: 12 }, { skus: [{ id: 'sku-1', name: '新商品' }] }]) {
    assert.notEqual(key.call(page, { ...order, ...patch }), initial)
  }
  assert.notEqual(key.call({ countdownBaseAt: 2000 }, order), initial)
  assert.equal(key.call(page, { ...order }), initial)
})

test('地址默认标记和编辑内容变化使同编号卡片缓存失效', () => {
  const key = keyFor('mixed-development-h5/features/mine/src/main/ets/presentation/views/AddressView.ets', 'addresses', 'address', 'AddressItem')
  const address = { id: 'address-1', isDefault: 1, receiver: '旧姓名', contact: '13800000000', fullLocation: '旧地区', address: '旧地址' }
  const initial = key(address)
  for (const patch of [{ isDefault: 0 }, { receiver: '新姓名' }, { contact: '13900000000' }, { fullLocation: '新地区' }, { address: '新地址' }]) {
    assert.notEqual(key({ ...address, ...patch }), initial)
  }
})

test('购物袋重新加载相同 SKU 也重绑对象，本地勾选数量修改不重建', async () => {
  const path = 'mixed-development-h5/features/cart/src/main/ets/presentation/views/CartView.ets'
  const key = keyFor(path, 'cartList', 'cart', 'CartGoodsModel')
  const source = sourceOf(path)
  const start = source.indexOf('  private async loadCartList')
  const end = source.indexOf('  // 合计', start)
  const body = source.slice(start, end).replace('private async', 'async')
  const Page = execute(`export class Page { ${body} }`, {}, {
    getCartListAPI: async () => [{ skuId: 'sku-1', selected: false, count: 1 }],
    CartGoodsModel: class { constructor(data) { Object.assign(this, data) } }
  }).Page
  const page = new Page()
  Object.assign(page, { user: { token: 'same-token' }, cartToken: 'same-token', loadRequestId: 0, cartListRevision: 0,
    rowSaves: new Map(),
    isPageActive: true, isCurrentQuery: () => true, recalculateCartSummary: () => {} })
  await page.loadCartList()
  const previous = page.cartList[0], initial = key.call(page, previous)
  previous.selected = true
  previous.count = 2
  assert.equal(key.call(page, previous), initial)
  await page.loadCartList()
  assert.notEqual(page.cartList[0], previous)
  assert.notEqual(key.call(page, page.cartList[0]), initial)
})
