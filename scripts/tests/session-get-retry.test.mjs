import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execute, sourceOf } from './native-harness.mjs'

const axios = createRequire(new URL('../../shoph5-vue3/package.json', import.meta.url))('axios')
const originalSession = { token: 'original', identity: 'buyer', identities: ['buyer', 'merchant'], identityRevision: 2 }
const originalHeaders = ['Bearer original', 'buyer', '2']

function fixture(statuses, fallbackStatus = 200, switchTo) {
  let current = originalSession
  const headers = [], waits = []
  const adapter = async config => {
    headers.push([config.headers.Authorization, config.headers['X-HDM-Identity'], config.headers['X-HDM-Identity-Revision']])
    if (switchTo) current = switchTo
    const status = statuses.shift() ?? fallbackStatus
    if (status !== 200) throw new axios.AxiosError('request failed', 'ERR_NETWORK', config, null,
      status === 0 ? undefined : { status, config })
    return { status, config, data: { code: '1', result: 'ok' }, headers: {} }
  }
  const { RequestAxios, executeGetWithRetry } = execute(sourceOf('mixed-development-h5/commons/network/src/main/ets/RequestAxios.ets'), {
    '@ohos/axios': { __esModule: true, default: { create: options => axios.create({ ...options, adapter }) } },
    constants: { GlobalVariable: { USER_INFO_KEY: 'user', SUCCESS_CODE: '1' } },
  }, { AppStorage: { get: key => key === 'user' ? current : undefined },
    setTimeout: (callback, delay) => { waits.push(delay); queueMicrotask(callback) } })
  return { RequestAxios, executeGetWithRetry, headers, waits }
}

test('会话 GET 对网络和可重试状态有限重试，每次保留原凭证和身份，对失效会话停止重试', async () => {
  for (const status of [0, 408, 429, 500, 503]) {
    const f = fixture([status, status, 200])
    assert.equal(await f.RequestAxios.getForSession('/member/order', 'original'), 'ok')
    assert.deepEqual(f.headers, Array(3).fill(originalHeaders))
    assert.deepEqual(f.waits, [350, 1000])
  }
  const f = fixture([503, 503, 503, 200])
  await assert.rejects(f.RequestAxios.getForSession('/member/order', 'original'))
  assert.equal(f.headers.length, 3)
  for (const newSession of [{ ...originalSession, token: 'new-account' }, { ...originalSession, identity: 'merchant', identityRevision: 3 }]) {
    const stale = fixture([503, 200], 200, newSession)
    await assert.rejects(stale.RequestAxios.getForSession('/member/order', 'original'), /身份已切换/)
    assert.deepEqual(stale.headers, [originalHeaders]); assert.deepEqual(stale.waits, [])
  }
})

test('会话 GET 的 401 和 404 不重试，写请求也不重试', async () => {
  for (const status of [401, 404]) {
    const f = fixture([status, 200])
    await assert.rejects(f.RequestAxios.getForSession('/member/order', 'original'))
    assert.deepEqual(f.headers, [originalHeaders]); assert.deepEqual(f.waits, [])
  }
  for (const method of ['postWithSession', 'putForSession', 'deleteForSession', 'postForSession']) {
    const f = fixture([503, 200])
    const args = ['postWithSession', 'putForSession'].includes(method) ? ['/write', {}, 'original'] : ['/write', 'original']
    await assert.rejects(f.RequestAxios[method](...args))
    assert.equal(f.headers.length, 1); assert.deepEqual(f.waits, [])
  }
})

test('AuthCart 复用会话 GET 的重试，断网总请求三次', async () => {
  const f = fixture([], 0)
  const { authCart } = execute(sourceOf('mixed-development-h5/commons/storage/src/main/ets/AuthCart.ets'), {
    constants: { BusinessVariable: { CART_COUNT: 'cartCount', UPDATE_CART_LIST: 'cartList' } },
    models: {},
    network: { RequestAxios: f.RequestAxios, executeGetWithRetry: f.executeGetWithRetry },
    './Auth': { auth: { getUserInfo: () => originalSession } },
    './StoreManager': { storeManager: { ctx: { eventHub: { emit: () => {} } }, getFormId: () => [] } },
    '@kit.FormKit': { formBindingData: { createFormBindingData: fields => fields }, formProvider: { updateForm: async () => {} } },
  }, { AppStorage: { setOrCreate: () => {} } })

  await authCart.updateCartCount()
  assert.equal(f.headers.length, 3)
  assert.deepEqual(f.waits, [350, 1000])
})
