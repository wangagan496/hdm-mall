import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { serviceFixture } from './helpers/service-fixture.ts'

test('D18 支付与原路退款展示各自渠道编号，重复读取保持稳定', async () => {
  const f = await serviceFixture()
  try {
    const orderId = (await f.create()).body.result.id
    assert.equal((await f.call('POST', `/member/order/${orderId}/payments`, { amountCents: 1000 })).status, 200)
    const paid = (await f.call('GET', `/member/order/${orderId}`)).body.result
    assert.match(paid.channelTransactionId ?? '', /^mock-pay-/)
    const request = (await f.call('POST', `/member/order/${orderId}/cancel-requests`, { requestKey: randomUUID() })).body.result
    assert.equal((await f.call('POST', `/merchant/orders/${orderId}/cancel-requests/${request.cancelRequestId}/resolve`,
      { decision: 'approve', requestKey: randomUUID() }, f.merchant.token)).status, 200)
    const refunded = (await f.call('GET', `/member/order/${orderId}`)).body.result
    assert.match(refunded.refunds[0].channelRefundId ?? '', /^mock-refund-/)
    assert.equal((await f.call('GET', `/member/order/${orderId}`)).body.result.refunds[0].channelRefundId, refunded.refunds[0].channelRefundId)
  } finally { await f.close() }
})
