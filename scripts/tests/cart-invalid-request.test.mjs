import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execute, sourceOf } from './native-harness.mjs'
import { buildApp } from '../../server/src/app.ts'

const axios = createRequire(new URL('../../shoph5-vue3/package.json', import.meta.url))('axios')
test('清除失效商品发送有效 JSON 正文并且只删除当前账号失效行', async () => {
  const f = await buildApp({ databasePath: ':memory:', uploadsPath: './unused', publicUrl: 'http://fixture', mockPayments: true })
  try {
    f.accounts.register('invalid_buyer', 'invalid-password', 'buyer')
    const buyer = f.accounts.login('invalid_buyer', 'invalid-password')
    f.db.run('INSERT INTO carts VALUES(?,?,?,1)', buyer.id, 'hdm-1-a', 1)
    f.db.run('INSERT INTO carts VALUES(?,?,?,1)', buyer.id, 'hdm-2-a', 1)
    f.db.run("UPDATE products SET status='off' WHERE id=(SELECT product_id FROM skus WHERE id='hdm-1-a')")
    const requests = []
    const adapter = async config => {
      requests.push(config)
      // 原生设备 DELETE 保留 application/json，请求正文缺失会被 Fastify 拒绝。
      const response = await f.app.inject({ method: 'DELETE', url: config.url, headers: { ...config.headers.toJSON(), 'content-type': 'application/json' }, payload: config.data })
      const result = { status: response.statusCode, statusText: '', data: response.body, headers: response.headers, config }
      if (response.statusCode >= 400) throw new axios.AxiosError('HTTP failure', 'ERR_BAD_RESPONSE', config, null, result)
      return result
    }
    const { RequestAxios } = execute(sourceOf('mixed-development-h5/commons/network/src/main/ets/RequestAxios.ets'), {
      '@ohos/axios': { __esModule: true, default: { create: options => axios.create({ ...options, adapter }) } },
      constants: { GlobalVariable: { BASE_URL: 'http://fixture', SUCCESS_CODE: '1', USER_INFO_KEY: 'user' } }
    }, { AppStorage: { get: () => buyer } })
    const result = await RequestAxios.deleteForSession('/member/cart/invalid', buyer.token)
    assert.equal(result.count, 1)
    assert.equal(requests.length, 1)
    assert.deepEqual(JSON.parse(requests[0].data), {})
    assert.deepEqual(f.db.all('SELECT sku_id FROM carts WHERE user_id=?', buyer.id).map(row => row.sku_id), ['hdm-2-a'])
  } finally { await f.app.close() }
})
