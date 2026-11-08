import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceOf } from './native-harness.mjs'

test('待收货详情明确告知暂无物流，列表入口明确为查看订单', () => {
  const detail = sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderDetailView.ets')
  const list = sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderView.ets')
  assert.ok(detail.includes("Text('暂未提供物流信息')"))
  assert.ok(!detail.includes("Button('查看物流')"))
  assert.ok(list.includes("Button('查看订单')"))
  assert.ok(!list.includes("Button('查看物流')"))
  assert.match(list, /onClick\(\(\) => this\.openOrderDetail\(order\.id\)\)/)
})
