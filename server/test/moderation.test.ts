import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serviceFixture } from './helpers/service-fixture.ts'

test('B2 评价与昵称发布前拦截明显违规词，不保存；正常差评不拦截', async () => {
  const f = await serviceFixture()
  try {
    const id = (await f.create()).body.result.id
    await f.complete(id)
    const rejected = await f.call('PUT', `/member/order/${id}/evaluation`, { score: 1, content: '代开发票办假证' })
    assert.equal(rejected.status, 400)
    assert.equal(rejected.body.msg, '内容包含不适合发布的词，请修改后再发布')
    assert.equal((await f.call('GET', `/member/order/${id}`)).body.result.evaluation, null)
    const profile = { nickname: '办假证', gender: '未知', birthday: '', profession: '', provinceCode: '', cityCode: '', countyCode: '' }
    assert.equal((await f.call('PUT', '/member/profile', profile)).status, 400)
    assert.equal((await f.call('PUT', `/member/order/${id}/evaluation`, { score: 1, content: '包装不好，客服太慢，不满意' })).status, 200)
    assert.equal((await f.call('GET', `/goods/${f.product.id}/evaluate/page`)).body.result.counts, 1)
  } finally { await f.close() }
})

test('B2 隐藏必须选原因，商品页排除而买家看得到原因，修改重发恢复且审计齐全', async () => {
  const f = await serviceFixture()
  try {
    const id = (await f.create()).body.result.id
    await f.complete(id)
    const url = `/member/order/${id}/evaluation`
    assert.equal((await f.call('PUT', url, { score: 2, content: '这件商品的包装不满意' })).status, 200)
    const hide = `/merchant/reviews/${id}/hide`
    assert.equal((await f.call('POST', hide, { reason: '广告' })).status, 403)
    assert.equal((await f.call('POST', hide, {}, f.merchant.token)).status, 400)
    assert.equal((await f.call('POST', hide, { reason: '不喜欢差评' }, f.merchant.token)).status, 400)
    assert.equal((await f.call('POST', hide, { reason: '无关内容' }, f.merchant.token)).status, 200)
    assert.equal((await f.call('POST', hide, { reason: '无关内容' }, f.merchant.token)).status, 200)
    assert.equal((await f.call('GET', `/goods/${f.product.id}/evaluate/page`)).body.result.counts, 0)
    const detail = (await f.call('GET', `/member/order/${id}`)).body.result
    assert.equal(detail.evaluation.hiddenReason, '无关内容')
    assert.equal(detail.canEvaluate, true)
    assert.equal((await f.call('PUT', url, { score: 2, content: '这件商品的包装不满意' })).status, 409)
    assert.equal((await f.call('PUT', url, { score: 2, content: '包装压坏了，希望改善包装' }, f.other.token)).status, 403)
    assert.equal((await f.call('PUT', url, { score: 2, content: '包装压坏了，希望改善包装' })).status, 200)
    const visible = (await f.call('GET', `/goods/${f.product.id}/evaluate/page`)).body.result
    assert.equal(visible.counts, 1)
    assert.equal(visible.items[0].content, '包装压坏了，希望改善包装')
    assert.equal((await f.call('GET', `/member/order/${id}`)).body.result.evaluation.hiddenReason, null)
    const merchant = await f.call('GET', `/merchant/goods/${f.product.id}/reviews`, undefined, f.merchant.token)
    assert.equal(merchant.status, 200)
    assert.equal(merchant.body.result.items[0].buyerId, f.buyer.id)
    for (const action of ['review.hide', 'review.republish']) {
      assert.equal((await f.call('GET', '/merchant/audit-log?action=' + action, undefined, f.merchant.token)).body.result.counts, 1)
    }
  } finally { await f.close() }
})

test('B2 商家重置违规头像必须选原因，买家可重传且写审计', async () => {
  const f = await serviceFixture()
  try {
    assert.equal((await f.upload('/member/profile/avatar')).status, 200)
    const url = `/merchant/members/${f.buyer.id}/avatar/reset`
    assert.equal((await f.call('POST', url, { reason: '广告' })).status, 403)
    assert.equal((await f.call('POST', url, {}, f.merchant.token)).status, 400)
    assert.equal((await f.call('POST', url, { reason: '广告' }, f.merchant.token)).status, 200)
    assert.equal((await f.call('GET', '/member/profile')).body.result.avatar, '')
    const notices = (await f.call('GET', '/member/account-notices')).body.result
    assert.ok(notices.some((notice: { message: string }) => notice.message.includes('头像已恢复默认') && notice.message.includes('广告') && notice.message.includes('重新上传')))
    assert.equal((await f.call('GET', '/member/account-notices', undefined, f.other.token)).body.result.length, 0)
    assert.equal((await f.call('GET', '/merchant/audit-log?action=avatar.reset', undefined, f.merchant.token)).body.result.counts, 1)
    assert.equal((await f.upload('/member/profile/avatar')).status, 200)
    assert.match((await f.call('GET', '/member/profile')).body.result.avatar, /\/uploads\//)
  } finally { await f.close() }
})
