import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serviceFixture } from './helpers/service-fixture.ts'

test('商品物流分别保存，未发生售后不可打分，主动改评保留原文并拒绝过期版本', async () => {
  const f = await serviceFixture()
  try {
    const id = (await f.create()).body.result.id
    await f.complete(id)
    const path = '/member/order/' + id
    const save = (input: object) => f.call('PUT', path + '/evaluation', input)
    const input = { productScore: 3, logisticsScore: 4, content: '实物颜色很一般', items: [] }
    assert.equal((await save({ ...input, serviceScore: 5 })).status, 400)
    assert.equal((await save({ ...input, sizeFit:'smaller' })).status,400)
    assert.equal((await save({ ...input, sizeShift:'half' })).status,400)
    assert.equal((await save({ ...input, templateVersion: 'invented' })).status, 400)
    assert.equal((await save({ ...input, items: [{ skuId: f.product.skus[0]!.id, fieldId: 'invented', result: 'matches' }] })).status, 400)
    assert.equal((await save(input)).status, 200)
    assert.equal((await save(input)).status, 409)
    assert.equal((await save({ ...input, revision: 1, content: '使用几天后觉得很好', productScore: 4 })).status, 200)
    const review = (await f.call('GET', path)).body.result.evaluation
    assert.equal(review.score, 4)
    assert.equal(review.revision, 2)
    assert.equal(review.logisticsScore, 4)
    assert.equal(review.serviceScore, null)
    assert.equal(review.history[0].content, input.content)
    assert.equal(review.history[0].productScore, 3)
    assert.equal((await save({ ...input, revision: 1 })).status, 409)
  } finally { await f.close() }
})

test('服饰无已知尺码承诺时不接受尺码反馈',async()=>{
  const f=await serviceFixture()
  try {
    f.ctx.db.run("UPDATE products SET category='服饰' WHERE id=?",f.product.id)
    const id=(await f.create()).body.result.id
    await f.complete(id)
    const path='/member/order/'+id
    assert.equal((await f.call('GET',path)).body.result.skus[0].sizeReviewRequired,false)
    const data={score:4,content:'普通穿着体验良好'}
    assert.equal((await f.call('PUT',path+'/evaluation',{...data,sizeFit:'true'})).status,400)
    assert.equal((await f.call('PUT',path+'/evaluation',data)).status,200)
  } finally {await f.close()}
})
