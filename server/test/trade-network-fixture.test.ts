import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildTradeNetworkFixture } from './helpers/trade-network-fixture.ts'

for (const decision of ['withdraw', 'approve', 'reject-and-ship']) {
  test('B-83 B-84 B-85 B-86 accepted-response barrier and exactly-once ' + decision, async () => {
    const fixture = await buildTradeNetworkFixture()
    try {
      const buyer = fixture.context.accounts.login('device_buyer', fixture.password)
      const merchant = fixture.context.accounts.login('device_merchant', fixture.password)
      const call = (method: string, url: string, payload?: object, token = buyer.token) => fixture.context.app.inject({
        method: method as never, url, payload, headers: { authorization: 'Bearer ' + token }
      })
      const created = await call('POST', '/member/order', { requestKey: randomUUID(), expectedAmountCents: 2371,
        addressId: fixture.addressId, goods: [{ skuId: fixture.skuId, count: 1 }] })
      assert.equal(created.statusCode, 200)
      const orderId = created.json().result.id
      assert.equal((await call('POST', '/member/order/' + orderId + '/mock-pay', { amountCents: 2371 })).statusCode, 200)
      const requestKey = randomUUID()
      assert.equal((await call('POST', '/device-fixture/response-barrier', { kind: 'cancel-request', hold: true })).statusCode, 200)
      const pendingRequest = call('POST', '/member/order/' + orderId + '/cancel-requests', { requestKey })
      const requestTask = pendingRequest.then(response => response)
      let barrier
      for (let index = 0; index < 100; index++) {
        barrier = (await call('GET', '/device-fixture/response-barrier')).json()
        if (barrier.received) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      assert.equal(barrier?.received, true)
      assert.equal(barrier.orderId, orderId)
      assert.equal(fixture.context.db.one<{ n: number }>('SELECT COUNT(*) n FROM order_cancel_requests')!.n, 1)
      await call('POST', '/device-fixture/response-barrier', { kind: 'cancel-request', hold: false })
      const request = (await requestTask).json().result
      const actionKey = randomUUID()
      const kind = decision === 'withdraw' ? 'cancel-withdraw' : 'cancel-resolve'
      const path = decision === 'withdraw' ? '/member/order/' + orderId + '/cancel-requests/' + request.cancelRequestId + '/withdraw'
        : '/merchant/orders/' + orderId + '/cancel-requests/' + request.cancelRequestId + '/resolve'
      const payload = decision === 'withdraw' ? { requestKey: actionKey } : { requestKey: actionKey, decision,
        ...(decision === 'reject-and-ship' ? { carrier:'顺丰',trackingNo:'SF12345678',reason: 'Already prepared for shipment' } : {}) }
      const token = decision === 'withdraw' ? buyer.token : merchant.token
      await call('POST', '/device-fixture/response-barrier', { kind, hold: true })
      const actionTask = call('POST', path, payload, token).then(response => response)
      for (let index = 0; index < 100; index++) {
        barrier = (await call('GET', '/device-fixture/response-barrier')).json()
        if (barrier.received) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      assert.equal(barrier.received, true)
      assert.equal(barrier.kind, kind)
      assert.equal((await call('GET', '/order-cancel-actions/by-request/' + actionKey, undefined, token)).statusCode, 200)
      const duplicates = await Promise.all([call('POST', path, payload, token), call('POST', path, payload, token)])
      assert.ok(duplicates.every(response => response.statusCode === 200))
      await call('POST', '/device-fixture/response-barrier', { kind, hold: false })
      assert.equal((await actionTask).statusCode, 200)
      const proof = (await call('GET', '/device-fixture/orders/' + orderId + '/payments')).json()
      assert.equal(proof.cancelRequests.length, 1)
      assert.equal(proof.cancelActions.length, 2)
      assert.equal(proof.payments.length, 1)
      assert.equal(proof.refunds.length, decision === 'approve' ? 1 : 0)
      assert.equal(proof.order.state, decision === 'approve' ? 6 : decision === 'withdraw' ? 2 : 3)
      const inventory = (await call('GET', '/merchant/inventory/' + fixture.skuId + '/movements', undefined, merchant.token)).json().result
      assert.equal(inventory.items.filter((entry: { orderId: string; kind: string }) => entry.orderId === orderId && entry.kind === 'reserve').length, 1)
      assert.equal(inventory.items.filter((entry: { orderId: string; kind: string }) => entry.orderId === orderId && entry.kind === 'cancel').length, decision === 'approve' ? 1 : 0)
      const audit = (await call('GET', '/merchant/audit-log?pageSize=100&orderId=' + orderId, undefined, merchant.token)).json().result
      const auditAction = decision === 'approve' ? 'cancel.approve' : 'order.reject_and_ship'
      assert.equal(audit.items.filter((entry: { action: string }) => entry.action === auditAction).length, decision === 'withdraw' ? 0 : 1)
      assert.equal(fixture.context.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', fixture.skuId)!.stock, decision === 'approve' ? 23 : 22)
      const requests = (await call('GET', '/device-fixture/trade-requests')).json()
      assert.equal(requests.filter((entry: { requestKey?: string }) => entry.requestKey === actionKey).length, 3)
    } finally { await fixture.close() }
  })
}

test('B-83 barrier rejects unsupported kinds and mismatched release', async () => {
  const fixture = await buildTradeNetworkFixture()
  try {
    const call = (payload: object) => fixture.context.app.inject({ method: 'POST', url: '/device-fixture/response-barrier', payload })
    assert.equal((await call({ kind: 'arbitrary', hold: true })).statusCode, 400)
    assert.equal((await call({ kind: 'cancel-request', hold: true })).statusCode, 200)
    assert.equal((await call({ kind: 'cancel-resolve', hold: false })).statusCode, 409)
    assert.equal((await call({ kind: 'cancel-request', hold: false })).statusCode, 200)
  } finally { await fixture.close() }
})
