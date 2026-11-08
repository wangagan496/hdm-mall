import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf } from './native-harness.mjs'
const { CartOperationHelper: carts } = execute(sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/utils/CartOperations.ets'), {
  storage: { authCart: {} }, utils: { Logger: {} }, '../../data/api': {}
})
test('混合购物车的全选、金额、数量和结算列表一致排除失效行', () => {
  const rows = [{ skuId: 'ok', available: true, selected: true, price: 10, count: 2 }, { skuId: 'off', available: false, selected: true, price: 99, count: 3 }]
  assert.equal(carts.calculateTotalPrice(rows), 20)
  assert.equal(carts.calculateSelectedCount(rows), 2)
  assert.deepEqual(carts.getSelectedCarts(rows).map(row => row.skuId), ['ok'])
  assert.equal(carts.isAllSelected(rows), true)
  assert.equal(carts.isAllSelected([rows[1]]), false)
  carts.batchUpdateSelected(rows, true)
  assert.equal(rows[1].selected, false)
})
