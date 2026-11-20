import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serviceFixture } from './helpers/service-fixture.ts'

test('商家评价列表全响应排除收件电话、账号、邮箱及完整姓名，评价编号不能读取订单', async () => {
  const f = await serviceFixture()
  try {
    const fullName = '林秋澄'
    const email = 'invoice-private@example.test'
    f.ctx.db.run('UPDATE users SET nickname=? WHERE id=?', fullName, f.buyer.id)
    const id = (await f.create({ titleType:'individual', title:fullName, email })).body.result.id
    await f.complete(id)
    const path = '/member/order/' + id
    assert.equal((await f.call('PUT',path+'/evaluation',{ score:4, content:'商品手感和描述一致' })).status,200)
    const order = (await f.call('GET',path)).body.result
    assert.equal(order.invoice.email,email)
    assert.equal(order.address.contact,'13800000000')
    const response = await f.call('GET','/merchant/goods/'+f.product.id+'/reviews',undefined,f.merchant.token)
    assert.equal(response.status,200)
    const list = response.body.result
    assert.equal(list.items.length,1)
    for(const secret of [order.address.contact, order.address.receiver, f.buyer.account, email, fullName, f.buyer.id, id]) {
      assert.ok(!JSON.stringify(response.body).includes(secret))
    }
    assert.equal(list.items[0].member.nickname,'林***澄')
    assert.equal((await f.call('GET','/merchant/orders/'+list.items[0].id,undefined,f.merchant.token)).status,404)
  } finally { await f.close() }
})

test('评价只公开独立编号，商家只能公开回复，3分计作中评', async () => {
  const f = await serviceFixture()
  try {
    const email='reviewer@example.test'
    const id = (await f.create({titleType:'individual',title:'个人',email})).body.result.id
    await f.complete(id)
    await f.call('PUT','/member/order/'+id+'/evaluation',{score:3,content:'颜色和图片有点区别'})
    const page = '/goods/'+f.product.id+'/evaluate/page?skuId='+f.product.skus[0]!.id
    const result = (await f.call('GET',page)).body.result
    const item = result.items[0]
    assert.notEqual(item.id,id)
    assert.deepEqual(item.badges,['已真实收货'])
    assert.equal(result.summary.neutral,1)
    assert.equal(result.summary.negative,0)
    const merchant = (await f.call('GET','/merchant/goods/'+f.product.id+'/reviews',undefined,f.merchant.token)).body.result.items[0]
    assert.equal(merchant.id,item.id)
    for (const view of [merchant,item]) for(const sensitive of [id,f.buyer.id,f.buyer.account,'13800000000']) {
      assert.ok(!JSON.stringify(view).includes(sensitive))
    }
    assert.equal((await f.call('GET','/merchant/orders/'+item.id,undefined,f.merchant.token)).status,404)
    const detail = (await f.call('GET','/merchant/orders/'+id,undefined,f.merchant.token)).body.result
    assert.ok(!JSON.stringify(detail).includes('13800000000'))
    const issued=await f.call('POST','/merchant/orders/'+id+'/invoice/issued',{requestKey:randomUUID()},f.merchant.token)
    assert.equal(issued.status,200)
    assert.ok(!JSON.stringify(issued.body).includes(email))
    f.ctx.db.run('UPDATE evaluations SET content=? WHERE order_id=?','联系 13800000000 或 '+email,id)
    for(const record of [(await f.call('GET',page)).body.result,
      (await f.call('GET','/merchant/goods/'+f.product.id+'/reviews',undefined,f.merchant.token)).body.result]){
      assert.ok(!JSON.stringify(record).includes('13800000000'))
      assert.ok(!JSON.stringify(record).includes(email))
    }
    const path='/merchant/reviews/'+item.id
    assert.equal((await f.call('POST',path+'/hide',{reason:'广告'},f.merchant.token)).status,403)
    const reply = (content:string)=>f.call('POST',path+'/reply',{content},f.merchant.token)
    assert.equal((await reply('删除评价给您退款')).status,400)
    assert.equal((await reply('代开发票办假证')).status,400)
    assert.equal((await reply('感谢反馈，我们会核对批次')).status,200)
    assert.equal((await f.call('GET',page)).body.result.items[0].reply,'感谢反馈，我们会核对批次')
    for(const url of [page.replace(f.product.skus[0]!.id,'other'), page+'&templateVersion=other']) {
      assert.equal((await f.call('GET',url)).body.result.counts,0)
    }
    f.ctx.db.run('UPDATE products SET status=? WHERE id=?','off',f.product.id)
    f.ctx.db.run('UPDATE products SET status=? WHERE id=?','on',f.product.id)
    assert.equal((await f.call('GET',page)).body.result.counts,0)
  } finally { await f.close() }
})
