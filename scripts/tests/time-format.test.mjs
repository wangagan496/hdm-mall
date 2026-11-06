import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf } from './native-harness.mjs'

const time = execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/TimeFormat.ets'))

test('订单时间按北京时间显示，不再显示 UTC 原始串', () => {
  // 服务端 createTime 是 ISO 字符串（UTC），北京时间要加 8 小时
  assert.equal(time.formatBeijingTime('2026-11-06T11:00:01.529Z'), '2026-11-06 19:00')
  assert.equal(time.formatBeijingTime('2026-11-06T11:00:01.529Z', true), '2026-11-06 19:00:01')
  // 毫秒时间戳与 ISO 字符串结果一致
  assert.equal(time.formatBeijingTime(Date.UTC(2026, 10, 6, 11, 0, 1)), '2026-11-06 19:00')
})

test('跨日、跨月、跨年按北京时间进位', () => {
  assert.equal(time.formatBeijingTime('2026-11-06T16:30:00.000Z'), '2026-11-07 00:30')
  assert.equal(time.formatBeijingTime('2026-11-30T20:05:00.000Z'), '2026-12-01 04:05')
  assert.equal(time.formatBeijingTime('2026-12-31T23:59:59.000Z', true), '2027-01-01 07:59:59')
})

test('空值或无法解析的时间返回空字符串，不显示 Invalid Date', () => {
  for (const value of [null, undefined, '', 'not-a-date', Number.NaN]) {
    assert.equal(time.formatBeijingTime(value), '')
  }
})

test('订单列表、详情、收银页、亲友中心不再直接显示 createTime 原始串或依赖设备时区', () => {
  const pages = [
    'mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderView.ets',
    'mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderDetailView.ets',
    'mixed-development-h5/features/cart/src/main/ets/presentation/views/PayView.ets',
    'mixed-development-h5/features/cart/src/main/ets/presentation/utils/OrderPresentation.ets',
    'mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets',
  ]
  for (const page of pages) {
    const source = sourceOf(page)
    assert.doesNotMatch(source, /Text\((this\.)?order\.createTime[ )]/, page + ' 仍直接显示 createTime')
    assert.doesNotMatch(source, /toLocaleString\(/, page + ' 仍用 toLocaleString 依赖设备时区')
  }
})
