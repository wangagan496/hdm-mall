import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { serviceFixture } from './helpers/service-fixture.ts'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

test('B3 一买家一会话、关联自己的订单、商家待回复筛选、回复红点和读到位置', async () => {
  const f = await serviceFixture()
  try {
    const orderId = (await f.create()).body.result.id
    const message = { requestKey: randomUUID(), content: '请问什么时候发货？', orderId, images: [] }
    const sent = await f.call('POST', '/member/service/messages', message)
    assert.equal(sent.status, 200)
    assert.equal(sent.body.result.orderId, orderId)
    assert.equal(sent.body.result.orderName, '服务测试商品')
    assert.equal(typeof sent.body.result.orderCreatedAt, 'number')
    assert.deepEqual((await f.call('POST', '/member/service/messages', message)).body, sent.body)
    assert.equal((await f.call('POST', '/member/service/messages', { ...message, content: '改内容' })).status, 409)
    assert.equal((await f.call('POST', '/member/service/messages', { ...message, requestKey: randomUUID() }, f.other.token)).status, 403)
    assert.equal((await f.call('GET', '/merchant/service?state=pending', undefined, f.merchant.token)).body.result.counts, 1)
    const replyUrl = `/merchant/service/${f.buyer.id}/messages`
    assert.equal((await f.call('POST', replyUrl, { requestKey: randomUUID(), content: '今天发货' })).status, 403)
    const first = await f.call('POST', replyUrl, { requestKey: randomUUID(), content: '今天发货', orderId }, f.merchant.token)
    assert.equal(first.status, 200)
    assert.equal((await f.call('GET', '/merchant/service?state=pending', undefined, f.merchant.token)).body.result.counts, 0)
    assert.equal((await f.call('GET', '/merchant/service?state=all', undefined, f.merchant.token)).body.result.counts, 1)
    assert.equal((await f.call('GET', '/member/service/unread')).body.result.count, 1)
    const history = await f.call('GET', '/member/service/messages')
    assert.equal(history.body.result.items.length, 2)
    assert.equal((await f.call('GET', '/member/service/unread')).body.result.count, 1)
    assert.equal((await f.call('POST', replyUrl, { requestKey: randomUUID(), content: '有问题可以继续留言' }, f.merchant.token)).status, 200)
    assert.equal((await f.call('POST', '/member/service/read', { throughId: first.body.result.id })).status, 200)
    assert.equal((await f.call('GET', '/member/service/unread')).body.result.count, 1)
    const last = (await f.call('GET', '/member/service/messages')).body.result.items.at(-1)
    await f.call('POST', '/member/service/read', { throughId: last.id })
    assert.equal((await f.call('GET', '/member/service/unread')).body.result.count, 0)
    assert.equal((await f.call('POST', '/member/service/read', { throughId: last.id }, f.other.token)).status, 403)
    for (const content of ['', ' '.repeat(5), '字'.repeat(501)]) {
      assert.equal((await f.call('POST', '/member/service/messages', { requestKey: randomUUID(), content })).status, 400)
    }
    assert.equal((await f.call('POST', '/member/service/messages', { requestKey: randomUUID(), content: '字'.repeat(500) })).status, 200)
    assert.equal((await f.call('GET', '/member/service/messages', undefined, f.other.token)).body.result.items.length, 0)
  } finally { await f.close() }
})

test('B3 注销时未发送的留言照片不作为会话永久残留', async () => {
  const f = await serviceFixture()
  try {
    const image = (await f.upload('/member/service/images', { requestKey: randomUUID() })).body.result.path as string
    assert.equal((await f.requestDeletion()).status, 200)
    f.advance(16 * 86400_000)
    await f.ctx.lifecycle.scan()
    await assert.rejects(access(join(f.root, image.slice(1))))
    assert.equal(f.ctx.db.one<{ n: number }>('SELECT COUNT(*) n FROM service_images WHERE buyer_id=?', f.buyer.id)!.n, 0)
  } finally { await f.close() }
})

test('B3 留言照片仅本人商家可读，0至3张JPEG、上传和发送幂等、拒绝盗用', async () => {
  const f = await serviceFixture()
  try {
    const requestKey = randomUUID()
    const image = await f.upload('/member/service/images', { requestKey })
    assert.equal(image.status, 200)
    const uri = image.body.result.path
    assert.deepEqual((await f.upload('/member/service/images', { requestKey })).body, image.body)
    assert.equal((await f.ctx.app.inject({ method: 'GET', url: uri })).statusCode, 401)
    for (const [token, status] of [[f.buyer.token, 200], [f.merchant.token, 200], [f.other.token, 403]] as const) {
      assert.equal((await f.ctx.app.inject({ method: 'GET', url: uri, headers: { authorization: 'Bearer ' + token } })).statusCode, status)
    }
    assert.equal((await f.upload('/member/service/images', { requestKey: randomUUID() }, f.buyer.token, Buffer.from('not-jpeg'))).status, 400)
    assert.equal((await f.upload('/member/service/images', { requestKey: randomUUID() }, f.buyer.token, Buffer.from([255,216,255]), 'image/png')).status, 400)
    assert.equal((await f.upload('/member/service/images', { requestKey: randomUUID() }, f.buyer.token, Buffer.alloc(512 * 1024 + 1))).status, 413)
    const foreign = await f.upload('/member/service/images', { requestKey: randomUUID() }, f.other.token)
    const body = { requestKey: randomUUID(), content: '请看看商品照片', images: [uri] }
    assert.equal((await f.call('POST', '/member/service/messages', { ...body, images: [foreign.body.result.path] })).status, 403)
    assert.equal((await f.call('POST', '/member/service/messages', { ...body, images: [uri, uri] })).status, 400)
    const second = (await f.upload('/member/service/images', { requestKey: randomUUID() })).body.result.path
    const third = (await f.upload('/member/service/images', { requestKey: randomUUID() })).body.result.path
    const fourth = (await f.upload('/member/service/images', { requestKey: randomUUID() })).body.result.path
    assert.equal((await f.call('POST', '/member/service/messages', { ...body, images: [uri, second, third, fourth] })).status, 400)
    const sent = await f.call('POST', '/member/service/messages', { ...body, images: [uri, second, third] })
    assert.equal(sent.status, 200)
    assert.equal(sent.body.result.images.length, 3)
    assert.deepEqual((await f.call('POST', '/member/service/messages', { ...body, images: [uri, second, third] })).body, sent.body)
    assert.equal((await f.call('POST', '/member/service/messages', { ...body, requestKey: randomUUID() })).status, 409)
  } finally { await f.close() }
})

test('B3 注销中可留言传照片和已读，注销后留言与照片保留三年并显示已注销用户', async () => {
  const f = await serviceFixture()
  try {
    const orderId = (await f.create()).body.result.id
    await f.complete(orderId)
    assert.equal((await f.requestDeletion()).status, 200)
    f.loginBuyer()
    const image = await f.upload('/member/service/images', { requestKey: randomUUID() })
    assert.equal(image.status, 200)
    const sent = await f.call('POST', '/member/service/messages', { requestKey: randomUUID(), content: '注销期间请继续处理售后', orderId, images: [image.body.result.path] })
    assert.equal(sent.status, 200)
    assert.equal((await f.call('POST', '/member/service/read', { throughId: sent.body.result.id })).status, 200)
    f.advance(16 * 86400000)
    await f.ctx.lifecycle.scan()
    f.loginMerchant()
    const history = await f.call('GET', `/merchant/service/${f.buyer.id}/messages`, undefined, f.merchant.token)
    assert.equal(history.status, 200)
    assert.equal(history.body.result.buyerName, '已注销用户')
    assert.equal(history.body.result.items[0].content, '注销期间请继续处理售后')
    assert.equal(history.body.result.items[0].orderId, orderId)
    assert.equal((await f.ctx.app.inject({ method: 'GET', url: image.body.result.path, headers: { authorization: 'Bearer ' + f.merchant.token } })).statusCode, 200)
    f.advance(3 * 366 * 86400000)
    await f.ctx.lifecycle.scan()
    f.loginMerchant()
    assert.equal((await f.call('GET', `/merchant/service/${f.buyer.id}/messages`, undefined, f.merchant.token)).body.result.items.length, 0)
    assert.equal((await f.ctx.app.inject({ method: 'GET', url: image.body.result.path, headers: { authorization: 'Bearer ' + f.merchant.token } })).statusCode, 404)
  } finally { await f.close() }
})
