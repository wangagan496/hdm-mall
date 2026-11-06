import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { execute, sourceOf } from './native-harness.mjs'
import { buildApp } from '../../server/src/app.ts'

const requireH5 = createRequire(new URL('../../shoph5-vue3/package.json', import.meta.url))
const axios = requireH5('axios')

test('亲友邀请确认解除、代付代收及商家发货固定凭证，真实权限与正文保持且失败不重发', async () => {
  const f = await buildApp({ databasePath: ':memory:', uploadsPath: './unused', publicUrl: 'http://fixture', mockPayments: true })
  try {
    for (const account of ['family_owner', 'family_friend', 'family_merchant', 'family_stranger']) {
      f.accounts.register(account, 'family-password', account === 'family_merchant' ? 'merchant' : 'buyer')
    }
    const owner = f.accounts.login('family_owner', 'family-password')
    const friend = f.accounts.login('family_friend', 'family-password')
    const merchant = f.accounts.login('family_merchant', 'family-password')
    const stranger = f.accounts.login('family_stranger', 'family-password')
    let current = owner
    const requests = []
    const adapter = async config => {
      const headers = config.headers.toJSON()
      requests.push({ method: config.method, url: config.url, data: config.data, headers, timeout: config.timeout })
      const response = await f.app.inject({ method: config.method.toUpperCase(), url: config.url, headers, payload: config.data })
      const result = { status: response.statusCode, statusText: '', data: response.body, headers: response.headers, config }
      if (response.statusCode >= 400) throw new axios.AxiosError('HTTP failure', 'ERR_BAD_RESPONSE', config, null, result)
      return result
    }
    const { RequestAxios } = execute(sourceOf('mixed-development-h5/commons/network/src/main/ets/RequestAxios.ets'), {
      '@ohos/axios': { __esModule: true, default: { create: options => axios.create({ ...options, adapter }) } },
      constants: { GlobalVariable: { BASE_URL: 'http://fixture', SUCCESS_CODE: '1', USER_INFO_KEY: 'user' } },
    }, { AppStorage: { get: key => key === 'user' ? current : undefined } })
    const api = execute(sourceOf('mixed-development-h5/features/mine/src/main/ets/data/api/family.ets'), { network: { RequestAxios } })
    const asUser = async (user, action, data) => {
      const count = requests.length
      current = user
      const pending = action(user.token)
      current = stranger
      const result = await pending
      assert.equal(requests.length, count + 1)
      assert.equal(requests.at(-1).headers.Authorization, `Bearer ${user.token}`)
      assert.deepEqual(JSON.parse(requests.at(-1).data), data)
      return result
    }
    const rejected = async action => {
      const count = requests.length
      await assert.rejects(action)
      assert.equal(requests.length, count + 1)
    }
    const relation = await asUser(owner, token => api.inviteRelationAPI('family_friend', token), { account: 'family_friend' })
    await rejected(() => api.updateRelationAPI(relation.id, 'accept', owner.token))
    assert.equal(f.accounts.bound(owner.id, friend.id), false)
    await asUser(friend, token => api.updateRelationAPI(relation.id, 'accept', token), { action: 'accept' })
    assert.equal(f.accounts.bound(owner.id, friend.id), true)
    const address = f.accounts.saveAddress(f.accounts.authenticate(`Bearer ${owner.token}`), {
      receiver: '亲友回归', contact: '13800138000', address: '仅测试', isDefault: 0,
    })
    const created = await f.app.inject({ method: 'POST', url: '/member/order', headers: { authorization: `Bearer ${owner.token}` },
      payload: { requestKey: randomUUID(), addressId: address.id, goods: [{ skuId: 'hdm-1-a', count: 1 }] } })
    assert.equal(created.statusCode, 200)
    const id = created.json().result.id
    const invited = await f.app.inject({ method: 'PUT', url: `/member/order/${id}/payer`,
      headers: { authorization: `Bearer ${owner.token}` }, payload: { friendId: friend.id } })
    assert.equal(invited.statusCode, 200)
    const detail = async () => (await f.app.inject({ method: 'GET', url: `/member/order/${id}`,
      headers: { authorization: `Bearer ${owner.token}` } })).json().result
    await rejected(() => api.startFamilyPaymentAPI(id, 19, stranger.token))
    await rejected(() => api.startFamilyPaymentAPI(id, 18, friend.token))
    assert.equal((await detail()).orderState, 1)
    await asUser(friend, token => api.startFamilyPaymentAPI(id, 19, token), { amountCents: 1900 })
    assert.equal((await detail()).payerAccount, 'family_friend')
    await rejected(() => api.shipOrderAPI(id, owner.token))
    assert.equal((await detail()).orderState, 2)
    await asUser(merchant, token => api.shipOrderAPI(id, token), {})
    assert.equal((await detail()).orderState, 3)
    await rejected(() => api.receiveOrderAPI(id, stranger.token))
    assert.equal((await detail()).orderState, 3)
    await asUser(friend, token => api.receiveOrderAPI(id, token), {})
    const received = await detail()
    assert.equal(received.orderState, 4); assert.equal(received.receivedByAccount, 'family_friend')
    await rejected(() => api.updateRelationAPI(relation.id, 'revoke', stranger.token))
    assert.equal(f.accounts.bound(owner.id, friend.id), true)
    await asUser(owner, token => api.updateRelationAPI(relation.id, 'revoke', token), { action: 'revoke' })
    assert.equal(f.accounts.bound(owner.id, friend.id), false)
    for (const request of requests) {
      assert.equal(request.headers.xSilentError, '1'); assert.equal(request.timeout, 10000)
      assert.equal(request.headers['Content-Type'], 'application/json')
    }
  } finally { await f.app.close() }
})
