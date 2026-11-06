import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execute, sourceOf, deferred } from './native-harness.mjs'
import { buildApp } from '../../server/src/app.ts'

const axios = createRequire(new URL('../../shoph5-vue3/package.json', import.meta.url))('axios')

test('实际加购与角标请求固定原账号，保留正文和读取重试，写失败不重发且评价静默读取', async () => {
  const f = await buildApp({ databasePath: ':memory:', uploadsPath: './unused', publicUrl: 'http://fixture', mockPayments: true })
  try {
    for (const account of ['goods_buyer', 'goods_other']) f.accounts.register(account, 'goods-password', 'buyer')
    const buyer = f.accounts.login('goods_buyer', 'goods-password'), other = f.accounts.login('goods_other', 'goods-password')
    let current = buyer, countFailures = 0, badge = -1
    const requests = [], countUpdated = deferred()
    const adapter = async config => {
      const headers = config.headers.toJSON(), uri = new URL(axios.getUri(config))
      requests.push({ method: config.method, url: config.url, data: config.data, headers, timeout: config.timeout })
      if (config.url === '/member/cart/count' && countFailures > 0) {
        countFailures--; current = other
        throw new axios.AxiosError('lost count response', 'ERR_NETWORK', config)
      }
      const response = await f.app.inject({ method: config.method.toUpperCase(), url: uri.pathname + uri.search,
        headers, payload: config.data })
      const result = { status: response.statusCode, statusText: '', data: response.body, headers: response.headers, config }
      if (response.statusCode >= 400) throw new axios.AxiosError('HTTP failure', 'ERR_BAD_RESPONSE', config, null, result)
      return result
    }
    const network = execute(sourceOf('mixed-development-h5/commons/network/src/main/ets/RequestAxios.ets'), {
      '@ohos/axios': { __esModule: true, default: { create: options => axios.create({ ...options, adapter }) } },
      constants: { GlobalVariable: { BASE_URL: 'http://fixture', SUCCESS_CODE: '1', USER_INFO_KEY: 'user' } },
    }, { AppStorage: { get: key => key === 'user' ? current : undefined }, setTimeout: callback => { queueMicrotask(callback); return 0 } })
    const { AuthCart } = execute(sourceOf('mixed-development-h5/commons/storage/src/main/ets/AuthCart.ets'), {
      network, constants: { BusinessVariable: { CART_COUNT: 'count', UPDATE_CART_LIST: 'update' } },
      './Auth': { auth: { getUserInfo: () => current } },
      './StoreManager': { storeManager: { getFormId: () => [] } },
      '@kit.FormKit': { formBindingData: { createFormBindingData: value => value } },
    }, { AppStorage: { setOrCreate: (_key, value) => { badge = value; countUpdated.resolve() } } })
    const cart = new AuthCart()
    const requestKey = randomUUID()
    const adding = cart.addCart({ skuId: 'hdm-1-a', count: 2, requestKey }, buyer.token)
    current = other; await adding
    assert.equal(requests.length, 1); assert.equal(badge, -1)
    assert.equal(requests[0].headers.Authorization, `Bearer ${buyer.token}`)
    assert.deepEqual(JSON.parse(requests[0].data), { skuId: 'hdm-1-a', count: 2, requestKey })
    const countOf = async user => (await f.app.inject({ method: 'GET', url: '/member/cart/count',
      headers: { authorization: `Bearer ${user.token}` } })).json().result.count
    assert.equal(await countOf(buyer), 2); assert.equal(await countOf(other), 0)
    await assert.rejects(cart.addCart({ skuId: 'hdm-1-a', count: 1, requestKey: randomUUID() }, buyer.token), /登录状态/)
    assert.equal(requests.length, 1)
    current = buyer; await cart.addCart({ skuId: 'hdm-1-a', count: 1, requestKey: randomUUID() }, buyer.token); await countUpdated.promise
    assert.equal(badge, 3); assert.equal(requests.at(-1).url, '/member/cart/count')
    let count = requests.length
    await assert.rejects(cart.addCart({ skuId: 'missing', count: 1, requestKey: randomUUID() }, buyer.token))
    assert.equal(requests.length, count + 1); assert.equal(await countOf(buyer), 3)
    count = requests.length; countFailures = 2; badge = 99; await cart.updateCartCount()
    assert.equal(requests.length, count + 3); assert.equal(badge, 99)
    assert.ok(requests.slice(count).every(request => request.headers.Authorization === `Bearer ${buyer.token}`))
    const home = execute(sourceOf('mixed-development-h5/features/home/src/main/ets/data/api/home.ets'), { network })
    const evaluations = await home.getGoodsEvaluationsAPI('hdm-1')
    assert.equal(evaluations.counts, 0); assert.deepEqual(evaluations.items, [])
    for (const request of requests) {
      assert.equal(request.headers.xSilentError, '1'); assert.equal(request.timeout, 10000)
      if (request.method === 'post') assert.equal(request.headers['Content-Type'], 'application/json')
    }
  } finally { await f.app.close() }
})
