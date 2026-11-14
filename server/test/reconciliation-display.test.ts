import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { serviceFixture } from './helpers/service-fixture.ts'

test('E19 支付与退款差异展示订单买家、下单时间及商品快照，只有商家能读取和打开订单', async () => {
  const f = await serviceFixture()
  try {
    const order = (await f.create()).body.result.id
    await f.call('POST', `/member/order/${order}/payments`, { amountCents: 1000 })
    const cancellation = (await f.call('POST', `/member/order/${order}/cancel-requests`, { requestKey: randomUUID() })).body.result
    await f.call('POST', `/merchant/orders/${order}/cancel-requests/${cancellation.cancelRequestId}/resolve`, { decision: 'approve', requestKey: randomUUID() }, f.merchant.token)
    const channel = f.ctx.payments.channel!, rows = await channel.exportBill!('2026-11-11')
    assert.deepEqual(rows.map(row => row.kind).sort(), ['payment', 'refund'])
    channel.exportBill = () => rows.map(row => ({ ...row, amountCents: 900 }))
    const response = await f.call('POST', '/merchant/reconciliation/run', { date: '2026-11-11' }, f.merchant.token)
    assert.equal(response.status, 200)
    assert.equal(response.body.result.differences.length, 2)
    for (const diff of response.body.result.differences) {
      assert.equal(diff.orderId, order)
      assert.equal(diff.buyerAccount, 'service_buyer')
      assert.equal(diff.orderCreatedAt, Date.UTC(2026, 10, 11))
      assert.deepEqual(diff.orderItems, [{ name: '服务测试商品', count: 1 }])
      const detail = await f.call('GET', `/merchant/orders/${diff.orderId}`, undefined, f.merchant.token)
      assert.equal(detail.status, 200); assert.equal(detail.body.result.id, order)
    }
    const get = '/merchant/reconciliation?date=2026-11-11'
    assert.deepEqual((await f.call('GET', get, undefined, f.merchant.token)).body.result.differences, response.body.result.differences)
    for (const user of [f.buyer, f.other]) {
      assert.equal((await f.call('GET', get, undefined, user.token)).status, 403)
      assert.equal((await f.call('POST', '/merchant/reconciliation/run', { date: '2026-11-11' }, user.token)).status, 403)
      assert.equal((await f.call('GET', `/merchant/orders/${order}`, undefined, user.token)).status, 403)
    }
  } finally { await f.close() }
})

test('E19 渠道独有差异不伪造对应订单，本地缺账单仍可找到买家订单', async () => {
  const f = await serviceFixture()
  try {
    const order = (await f.create()).body.result.id
    await f.call('POST', `/member/order/${order}/payments`, { amountCents: 1000 })
    const channel = f.ctx.payments.channel!, rows = await channel.exportBill!('2026-11-11')
    channel.exportBill = () => [{ ...rows[0]!, businessId: 'external-only', channelId: 'external-channel-only' }]
    const report = (await f.call('POST', '/merchant/reconciliation/run', { date: '2026-11-11' }, f.merchant.token)).body.result
    const external = report.differences.find((row: {category: string}) => row.category === 'channel-only')
    assert.equal(external.orderId, null)
    assert.equal(external.buyerAccount, null)
    assert.equal(external.orderCreatedAt, null)
    assert.deepEqual(external.orderItems, [])
    const local = report.differences.find((row: {category: string}) => row.category === 'local-only')
    assert.equal(local.orderId, order)
    assert.equal(local.buyerAccount, 'service_buyer')
  } finally { await f.close() }
})
