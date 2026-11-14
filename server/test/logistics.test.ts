import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serviceFixture } from './helpers/service-fixture.ts'

test('D18 发货必填承运商和有效运单，发货、签收、确认收货分别记时', async () => {
  const f = await serviceFixture()
  try {
    const id = (await f.create()).body.result.id
    await f.call('POST', `/member/order/${id}/payments`, { amountCents:1000 })
    assert.equal((await f.call('POST',`/merchant/orders/${id}/ship`,{},f.merchant.token)).status,400)
    assert.equal((await f.call('POST',`/merchant/orders/${id}/ship`,{carrier:'顺丰',trackingNo:'!'},f.merchant.token)).status,400)
    assert.equal((await f.call('POST',`/merchant/orders/${id}/ship`,{carrier:'顺丰',trackingNo:'SF12345678'},f.merchant.token)).status,200)
    const shipped = (await f.call('GET',`/member/order/${id}`)).body.result
    assert.equal(shipped.shippedAt,f.ctx.clock.now())
    assert.equal(shipped.signedAt,null)
    assert.equal(shipped.receivedAt,null)
    const start=f.ctx.clock.now(); f.advance(4000)
    await f.ctx.logistics.pushMock(id,[
      {id:'signed',state:'signed',occurredAt:start+3000,description:'快件已签收'},
      {id:'collected',state:'collected',occurredAt:start+1000,description:'快递已揽收'},
      {id:'transit',state:'transit',occurredAt:start+2000,description:'运输途中'},
      {id:'signed',state:'signed',occurredAt:start+3000,description:'快件已签收'}
    ])
    const path=`/member/order/${id}/logistics`
    const logistics=(await f.call('GET',path)).body.result
    assert.equal(logistics.state,'signed')
    assert.deepEqual(logistics.events.map((event:{id:string})=>event.id),['collected','transit','signed'])
    assert.equal((await f.call('GET',path,undefined,f.other.token)).status,403)
    await f.ctx.logistics.pushMock(id,[{id:'late-transit',state:'transit',occurredAt:start+2500,description:'延迟上报的运输节点'}])
    assert.equal((await f.call('GET',path)).body.result.state,'signed')
    const before=(await f.call('GET',`/member/order/${id}`)).body.result
    assert.equal(before.orderState,3)
    assert.equal(before.signedAt,start+3000)
    assert.equal(before.receivedAt,null)
    f.advance(1000)
    assert.equal((await f.call('PUT',`/member/order/${id}/receipt`,{})).status,200)
    const received=(await f.call('GET',`/member/order/${id}`)).body.result
    assert.equal(received.shippedAt,start)
    assert.equal(received.signedAt,start+3000)
    assert.equal(received.receivedAt,start+5000)
  } finally { await f.close() }
})

test('D18 物流同号冲突整批回滚，语义重复不重复，非法时间被拒绝',async()=>{
 const f=await serviceFixture()
 try{
  const id=(await f.create()).body.result.id
  await f.call('POST',`/member/order/${id}/payments`,{amountCents:1000})
  await f.call('POST',`/merchant/orders/${id}/ship`,{carrier:'其他快递',trackingNo:'OTHER-123456'},f.merchant.token)
  const at=f.ctx.clock.now();f.advance(3000)
  const first={id:'first',state:'collected',occurredAt:at+1000,description:'已揽收'}
  await f.ctx.logistics.pushMock(id,[first])
  await f.ctx.logistics.pushMock(id,[{...first,id:'alias'}])
  assert.equal(f.ctx.db.one<{n:number}>('SELECT COUNT(*) n FROM logistics_events WHERE order_id=?',id)!.n,1)
  await assert.rejects(f.ctx.logistics.pushMock(id,[{id:'new',state:'transit',occurredAt:at+500,description:'运输中'},{...first,description:'冲突内容'}]),/同一物流事件编号/)
  assert.equal(f.ctx.db.one<{n:number}>('SELECT COUNT(*) n FROM logistics_events WHERE order_id=?',id)!.n,1)
  assert.equal(f.ctx.db.one<{state:string}>('SELECT state FROM shipments WHERE order_id=?',id)!.state,'collected')
  for(const time of [at-1,at+4000])await assert.rejects(f.ctx.logistics.pushMock(id,[{...first,id:'bad',occurredAt:time}]),/有效范围/)
 }finally{await f.close()}
})

test('D18 发货状态与运单使用同一个时间快照，即使时钟逐次前进',async()=>{
 const f=await serviceFixture()
 try{
  const id=(await f.create()).body.result.id
  await f.call('POST',`/member/order/${id}/payments`,{amountCents:1000})
  const original=f.ctx.clock.now.bind(f.ctx.clock);let sequence=0
  f.ctx.clock.now=()=>original()+sequence++
  assert.equal((await f.call('POST',`/merchant/orders/${id}/ship`,{carrier:'顺丰',trackingNo:'SF12345678'},f.merchant.token)).status,200)
  const order=(await f.call('GET',`/member/order/${id}`)).body.result
  assert.equal(order.shippedAt,order.logistics.created)
 }finally{await f.close()}
})
