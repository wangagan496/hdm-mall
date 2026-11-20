import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { serviceFixture } from './helpers/service-fixture.ts'

test('未发货时仅退款关闭，提交评价返回单独的中文规则', async()=>{
  const f=await serviceFixture()
  try{
    const id=(await f.create()).body.result.id
    const path='/member/order/'+id
    assert.equal((await f.call('POST',path+'/mock-pay',{amountCents:1000})).status,200)
    const request=(await f.call('POST',path+'/cancel-requests',{requestKey:randomUUID()})).body.result
    assert.equal((await f.call('POST','/merchant/orders/'+id+'/cancel-requests/'+request.cancelRequestId+'/resolve',
      {requestKey:randomUUID(),decision:'approve'},f.merchant.token)).status,200)
    const result=await f.call('PUT',path+'/evaluation',{score:3,content:'取消后仅退款了'})
    assert.equal(result.status,409)
    assert.match(result.body.msg,/未收货仅退款/)
    assert.equal((await f.call('GET',path)).body.result.evaluation,null)
  }finally{await f.close()}
})

test('评价资格以真实收货时间为准，关单后保留资格，15天届满拒绝改评', async () => {
  const f = await serviceFixture()
  try {
    const id = (await f.create()).body.result.id
    const path = '/member/order/' + id + '/evaluation'
    const input = { score: 3, content: '商品使用起来一般' }
    assert.match((await f.call('PUT', path, input)).body.msg, /确认收货/)
    await f.complete(id)
    f.ctx.db.run('UPDATE orders SET state=6 WHERE id=?', id)
    assert.equal((await f.call('PUT', path, input, f.other.token)).status, 403)
    assert.equal((await f.call('GET', '/member/order/' + id)).body.result.canEvaluate, true)
    assert.equal((await f.call('PUT', path, input)).status, 200)
    assert.equal((await f.call('GET', '/member/order/' + id)).body.result.orderState, 6)
    assert.equal((await f.call('PUT', path, input)).status, 409)
    f.advance(15 * 86400000)
    f.loginBuyer()
    assert.match((await f.call('PUT', path, { ...input, revision: 1 })).body.msg, /15天/)
  } finally { await f.close() }
})
