import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { execute, sourceOf } from './native-harness.mjs'
import { buildApp } from '../../server/src/app.ts'

const requireH5 = createRequire(new URL('../../shoph5-vue3/package.json', import.meta.url))
const axios = requireH5('axios')

test('收银台邀请切回本人和模拟付款固定凭证，真实路由保留金额权限及失败不重发', async () => {
  const f = await buildApp({ databasePath: ':memory:', uploadsPath: './unused', publicUrl: 'http://fixture', mockPayments: true })
  try {
    for (const account of ['cashier_buyer', 'cashier_friend', 'cashier_stranger']) f.accounts.register(account, 'cashier-password', 'buyer')
    const buyer = f.accounts.login('cashier_buyer', 'cashier-password')
    const friend = f.accounts.login('cashier_friend', 'cashier-password')
    const stranger = f.accounts.login('cashier_stranger', 'cashier-password')
    const address = f.accounts.saveAddress(f.accounts.authenticate(`Bearer ${buyer.token}`), {
      receiver: '收银台回归', contact: '13800138000', address: '仅测试', isDefault: 0,
    })
    const invite = await f.app.inject({ method: 'POST', url: '/member/relations',
      headers: { authorization: `Bearer ${buyer.token}` }, payload: { account: 'cashier_friend' } })
    assert.equal(invite.statusCode, 200)
    const accepted = await f.app.inject({ method: 'PUT', url: `/member/relations/${invite.json().result.id}`,
      headers: { authorization: `Bearer ${friend.token}` }, payload: { action: 'accept' } })
    assert.equal(accepted.statusCode, 200)
    const created = await f.app.inject({ method: 'POST', url: '/member/order', headers: { authorization: `Bearer ${buyer.token}` },
      payload: { requestKey: randomUUID(), addressId: address.id, goods: [{ skuId: 'hdm-1-a', count: 1 }] } })
    assert.equal(created.statusCode, 200)
    const id = created.json().result.id
    let current = buyer
    const requests = []
    const adapter = async config => {
      const headers = config.headers.toJSON()
      requests.push({ url: config.url, data: config.data, headers, timeout: config.timeout })
      const response = await f.app.inject({ method: config.method.toUpperCase(), url: config.url, headers, payload: config.data })
      const result = { status: response.statusCode, statusText: '', data: response.body, headers: response.headers, config }
      if (response.statusCode >= 400) throw new axios.AxiosError('HTTP failure', 'ERR_BAD_RESPONSE', config, null, result)
      return result
    }
    const { RequestAxios } = execute(sourceOf('mixed-development-h5/commons/network/src/main/ets/RequestAxios.ets'), {
      '@ohos/axios': { __esModule: true, default: { create: options => axios.create({ ...options, adapter }) } },
      constants: { GlobalVariable: { BASE_URL: 'http://fixture', SUCCESS_CODE: '1', USER_INFO_KEY: 'user' } },
    }, { AppStorage: { get: key => key === 'user' ? current : undefined } })
    const api = execute(sourceOf('mixed-development-h5/features/cart/src/main/ets/data/api/cart.ets'), { network: { RequestAxios } })
    const inviting = api.invitePayerAPI(id, friend.id, buyer.token); current = stranger
    await inviting
    const detail = async () => (await f.app.inject({ method: 'GET', url: `/member/order/${id}`,
      headers: { authorization: `Bearer ${buyer.token}` } })).json().result
    assert.equal((await detail()).invitedPayerAccount, 'cashier_friend')
    let count = requests.length
    await assert.rejects(api.invitePayerAPI(id, null, stranger.token)); assert.equal(requests.length, count + 1)
    assert.equal((await detail()).invitedPayerAccount, 'cashier_friend')
    current = buyer
    const self = api.invitePayerAPI(id, null, buyer.token); current = stranger; await self
    assert.equal((await detail()).canPay, true)
    count = requests.length
    await assert.rejects(api.mockPayAPI(id, 18, buyer.token)); assert.equal(requests.length, count + 1)
    count = requests.length
    await assert.rejects(api.mockPayAPI(id, 19, stranger.token)); assert.equal(requests.length, count + 1)
    assert.equal((await detail()).orderState, 1)
    current = buyer
    const paying = api.mockPayAPI(id, 19, buyer.token); current = stranger; await paying
    const paid = await detail()
    assert.equal(paid.orderState, 2); assert.equal(paid.payerAccount, 'cashier_buyer')
    for (const index of [0, 2, 3, 5]) assert.equal(requests[index].headers.Authorization, `Bearer ${buyer.token}`)
    for (const request of requests) {
      assert.equal(request.headers.xSilentError, '1'); assert.equal(request.timeout, 10000)
      assert.equal(request.headers['Content-Type'], 'application/json')
    }
    assert.deepEqual(JSON.parse(requests[0].data), { friendId: friend.id })
    assert.deepEqual(JSON.parse(requests[2].data), { friendId: null })
    assert.deepEqual(JSON.parse(requests[5].data), { amountCents: 1900 })
  } finally { await f.app.close() }
})

test('订单列表详情提醒和收货固定原会话，真实路由拒绝无权限读取及未发货收货且写请求不重发', async () => {
  const f = await buildApp({ databasePath: ':memory:', uploadsPath: './unused', publicUrl: 'http://fixture', mockPayments: true })
  try {
    f.accounts.register('detail_buyer', 'detail-password', 'buyer')
    f.accounts.register('detail_merchant', 'detail-password', 'merchant')
    const buyer = f.accounts.login('detail_buyer', 'detail-password')
    const merchant = f.accounts.login('detail_merchant', 'detail-password')
    const address = f.accounts.saveAddress(f.accounts.authenticate(`Bearer ${buyer.token}`), {
      receiver: '详情回归', contact: '13800138000', address: '测试地址', isDefault: 0,
    })
    const created = await f.app.inject({ method: 'POST', url: '/member/order', headers: { authorization: `Bearer ${buyer.token}` },
      payload: { requestKey: randomUUID(), addressId: address.id, goods: [{ skuId: 'hdm-1-a', count: 1 }] } })
    assert.equal(created.statusCode, 200)
    const id = created.json().result.id
    await f.app.inject({ method: 'POST', url: `/member/order/${id}/mock-pay`, headers: { authorization: `Bearer ${buyer.token}` }, payload: { amountCents: 1900 } })
    let current = merchant
    const requests = []
    const adapter = async config => {
      const headers = config.headers.toJSON()
      requests.push({ url: config.url, data: config.data, headers })
      const response = await f.app.inject({ method: config.method.toUpperCase(), url: config.url, headers, payload: config.data })
      const result = { status: response.statusCode, statusText: '', data: response.body, headers: response.headers, config }
      if (response.statusCode >= 400) throw new axios.AxiosError('HTTP failure', 'ERR_BAD_RESPONSE', config, null, result)
      return result
    }
    const { RequestAxios } = execute(sourceOf('mixed-development-h5/commons/network/src/main/ets/RequestAxios.ets'), {
      '@ohos/axios': { __esModule: true, default: { create: options => axios.create({ ...options, adapter }) } },
      constants: { GlobalVariable: { BASE_URL: 'http://fixture', SUCCESS_CODE: '1', USER_INFO_KEY: 'user' } },
    }, { AppStorage: { get: key => key === 'user' ? current : undefined } })
    const api = execute(sourceOf('mixed-development-h5/features/cart/src/main/ets/data/api/cart.ets'), { network: { RequestAxios } })
    current = buyer
    const listing = api.getOrderListAPI({ page: 1, pageSize: 10, orderState: 2 }, buyer.token)
    current = merchant
    const list = await listing
    assert.equal(list.items.length, 1)
    assert.equal(list.items[0].id, id)
    assert.equal(requests[0].url, '/member/order?page=1&pageSize=10&orderState=2')
    for (const method of ['getOrderDetailAPI', 'remindShipmentAPI']) {
      current = buyer
      const task = api[method](id, buyer.token)
      current = merchant
      const order = await task
      assert.equal(order.id, id)
      assert.equal(order.orderState, 2)
    }
    await assert.rejects(api.receiptOrderAPI(id, buyer.token))
    assert.equal(requests.length, 4)
    const shipped = await f.app.inject({ method: 'POST', url: `/merchant/orders/${id}/ship`, headers: { authorization: `Bearer ${merchant.token}` }, payload: {} })
    assert.equal(shipped.statusCode, 200)
    current = buyer
    const receiving = api.receiptOrderAPI(id, buyer.token)
    current = merchant
    assert.equal((await receiving).orderState, 4)
    for (const request of requests) {
      assert.equal(request.headers.Authorization, `Bearer ${buyer.token}`)
      assert.equal(request.headers.xSilentError, '1')
      if (request.data !== undefined) assert.deepEqual(JSON.parse(request.data), {})
    }
    // 商家不能通过买家详情接口获取本人支付订单的私人信息。
    await assert.rejects(api.getOrderDetailAPI(id, merchant.token))
  } finally { await f.app.close() }
})

test('结算预览和下单固定发起账号，切换登录态后仍保留原请求正文和超时且失败不重发', async () => {
  const f = await buildApp({ databasePath: ':memory:', uploadsPath: './unused', publicUrl: 'http://fixture', mockPayments: true })
  try {
    for (const account of ['checkout_a', 'checkout_b']) f.accounts.register(account, 'checkout-password', 'buyer')
    const buyer = f.accounts.login('checkout_a', 'checkout-password')
    const other = f.accounts.login('checkout_b', 'checkout-password')
    const owner = f.accounts.authenticate(`Bearer ${buyer.token}`)
    const address = f.accounts.saveAddress(owner, { receiver: '结算回归', contact: '13800138000', address: '测试', isDefault: 0 })
    await f.app.inject({ method: 'POST', url: '/member/cart', headers: { authorization: `Bearer ${buyer.token}` },
      payload: { skuId: 'hdm-1-a', count: 1 } })
    let current = buyer
    const requests = []
    const adapter = async config => {
      const headers = config.headers.toJSON()
      requests.push({ url: config.url, data: config.data, headers, timeout: config.timeout })
      const response = await f.app.inject({ method: config.method.toUpperCase(), url: config.url, headers, payload: config.data })
      const result = { status: response.statusCode, statusText: '', data: response.body, headers: response.headers, config }
      if (response.statusCode >= 400) throw new axios.AxiosError('HTTP failure', 'ERR_BAD_RESPONSE', config, null, result)
      return result
    }
    const { RequestAxios } = execute(sourceOf('mixed-development-h5/commons/network/src/main/ets/RequestAxios.ets'), {
      '@ohos/axios': { __esModule: true, default: { create: options => axios.create({ ...options, adapter }) } },
      constants: { GlobalVariable: { BASE_URL: 'http://fixture', SUCCESS_CODE: '1', USER_INFO_KEY: 'user' } },
    }, { AppStorage: { get: key => key === 'user' ? current : undefined } })
    const api = execute(sourceOf('mixed-development-h5/features/cart/src/main/ets/data/api/cart.ets'), { network: { RequestAxios } })
    const loading = api.getPreOrderAPI(buyer.token)
    current = other
    const preview = await loading
    assert.equal(preview.goods[0].skuId, 'hdm-1-a')
    assert.equal(preview.userAddresses[0].id, address.id)
    const body = { requestKey: randomUUID(), addressId: address.id, goods: [{ skuId: 'hdm-1-a', count: 1 }] }
    current = buyer
    const saving = api.createOrderAPI(body, buyer.token)
    current = other
    const order = await saving
    assert.ok(order.id)
    const own = await f.app.inject({ method: 'GET', url: `/member/order/${order.id}`, headers: { authorization: `Bearer ${buyer.token}` } })
    const foreign = await f.app.inject({ method: 'GET', url: `/member/order/${order.id}`, headers: { authorization: `Bearer ${other.token}` } })
    assert.equal(own.statusCode, 200)
    assert.equal(foreign.statusCode, 403)
    const attempts = requests.length
    await assert.rejects(api.createOrderAPI(body, other.token))
    assert.equal(requests.length, attempts + 1)
    for (const request of requests.slice(0, 2)) {
      assert.equal(request.headers.Authorization, `Bearer ${buyer.token}`)
      assert.equal(request.headers.xSilentError, '1')
      assert.equal(request.timeout, 10000)
    }
    assert.equal(requests[1].headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(requests[1].data), body)
  } finally { await f.app.close() }
})

test('原生无业务参数的发货收货与注销发送有效 JSON，保留正文及指定会话且不重发失败操作', async () => {
  const f = await buildApp({ databasePath: ':memory:', uploadsPath: './unused', publicUrl: 'http://fixture', mockPayments: true })
  try {
    for (const account of ['native_buyer', 'native_merchant']) f.accounts.register(account, 'native-test-password', account.endsWith('merchant') ? 'merchant' : 'buyer')
    const buyer = f.accounts.login('native_buyer', 'native-test-password'), merchant = f.accounts.login('native_merchant', 'native-test-password')
    const owner = f.accounts.authenticate(`Bearer ${buyer.token}`)
    const address = f.accounts.saveAddress(owner, { receiver: '回归', contact: '13800138000', address: '仅测试', isDefault: 0 })
    let current = buyer
    const requests = []
    // 执行实际 Axios 正文序列化和拦截器，再送入真实 Fastify 路由；设备复跑另验鸿蒙适配层。
    const adapter = async config => {
      const headers = config.headers.toJSON()
      requests.push({ method: config.method, url: config.url, data: config.data, headers })
      const response = await f.app.inject({ method: config.method.toUpperCase(), url: config.url, headers, payload: config.data })
      const result = { status: response.statusCode, statusText: '', data: response.body, headers: response.headers, config }
      if (response.statusCode >= 400) throw new axios.AxiosError('HTTP failure', 'ERR_BAD_RESPONSE', config, null, result)
      return result
    }
    const { RequestAxios } = execute(sourceOf('mixed-development-h5/commons/network/src/main/ets/RequestAxios.ets'), {
      '@ohos/axios': { __esModule: true, default: { create: options => axios.create({ ...options, adapter }) } },
      constants: { GlobalVariable: { BASE_URL: 'http://fixture', SUCCESS_CODE: '1', USER_INFO_KEY: 'user' } },
    }, { AppStorage: { get: key => key === 'user' ? current : undefined } })
    for (const [post, put] of [['post', 'put'], ['postSilent', 'putSilent']]) {
      const created = await f.app.inject({ method: 'POST', url: '/member/order', headers: { authorization: `Bearer ${buyer.token}` },
        payload: { requestKey: randomUUID(), addressId: address.id, goods: [{ skuId: 'hdm-1-a', count: 1 }] } })
      assert.equal(created.statusCode, 200)
      const order = created.json().result
      current = buyer
      await RequestAxios.post(`/member/order/${order.id}/mock-pay`, { amountCents: 1900 })
      current = merchant
      await RequestAxios[post](`/merchant/orders/${order.id}/ship`)
      const attempts = requests.length
      await assert.rejects(RequestAxios[post](`/merchant/orders/${order.id}/ship`))
      assert.equal(requests.length, attempts + 1)
      current = buyer
      const received = await RequestAxios[put](`/member/order/${order.id}/receipt`)
      assert.equal(received.orderState, 4)
    }
    await RequestAxios.postForSession('/logout', merchant.token)
    assert.throws(() => f.accounts.authenticate(`Bearer ${merchant.token}`))
    assert.equal(f.accounts.authenticate(`Bearer ${buyer.token}`).id, buyer.id)
    assert.equal(requests.at(-1).headers.Authorization, `Bearer ${merchant.token}`)
    for (const request of requests) {
      assert.equal(request.headers['Content-Type'], 'application/json')
      assert.deepEqual(JSON.parse(request.data), request.url.endsWith('/mock-pay') ? { amountCents: 1900 } : {})
    }
  } finally { await f.app.close() }
})
