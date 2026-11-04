import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { execute, sourceOf } from './native-harness.mjs'
import { buildApp } from '../../server/src/app.ts'

const axios = createRequire(new URL('../../shoph5-vue3/package.json', import.meta.url))('axios')

test('地址增查改删固定发起凭证，保留编号重试地区与默认标记，跨账号写隔离且失败不重发', async () => {
  const f = await buildApp({ databasePath: ':memory:', uploadsPath: './unused', publicUrl: 'http://fixture', mockPayments: true })
  try {
    for (const name of ['address_a', 'address_b']) f.accounts.register(name, 'address-password', 'buyer')
    const buyer = f.accounts.login('address_a', 'address-password'), other = f.accounts.login('address_b', 'address-password')
    let current = buyer
    const requests = []
    const adapter = async config => {
      const headers = config.headers.toJSON()
      requests.push({ method: config.method, url: config.url, headers, data: config.data })
      const response = await f.app.inject({ method: config.method.toUpperCase(), url: config.url, headers, payload: config.data })
      const result = { status: response.statusCode, statusText: '', data: response.body, headers: response.headers, config }
      if (response.statusCode >= 400) throw new axios.AxiosError('HTTP failure', 'ERR_BAD_RESPONSE', config, null, result)
      return result
    }
    const { RequestAxios } = execute(sourceOf('mixed-development-h5/commons/network/src/main/ets/RequestAxios.ets'), {
      '@ohos/axios': { __esModule: true, default: { create: options => axios.create({ ...options, adapter }) } },
      constants: { GlobalVariable: { BASE_URL: 'http://fixture', SUCCESS_CODE: '1', USER_INFO_KEY: 'user' } },
    }, { AppStorage: { get: key => key === 'user' ? current : undefined } })
    const api = execute(sourceOf('mixed-development-h5/features/mine/src/main/ets/data/api/address.ets'), { network: { RequestAxios } })
    const body = { receiver: '原账号地址', contact: '13800000000', address: '一号楼', fullLocation: '北京 北京 东城',
      provinceCode: '11', cityCode: '1101', countyCode: '110101', isDefault: 0 }
    const key = randomUUID()
    const creating = api.createAddressAPI(body, key, buyer.token, 1)
    current = other
    const created = await creating
    assert.ok(created.id)
    const repeated = await api.createAddressAPI(body, key, buyer.token, 1)
    assert.equal(repeated.id, created.id)
    const list = await api.getAddressListAPI(buyer.token)
    assert.equal(list.length, 1)
    assert.equal(list[0].id, created.id)
    assert.equal(list[0].provinceCode, 11)
    assert.equal(list[0].isDefault, 0)
    const updated = { ...body, address: '二号楼', requestKey: key, revision: 2 }
    await api.updateAddressAPI(created.id, updated, buyer.token)
    await api.updateAddressAPI(created.id, { isDefault: 0 }, buyer.token)
    assert.equal((await api.getAddressDetailAPI(created.id, buyer.token)).address, '二号楼')
    const attempts = requests.length
    await assert.rejects(api.updateAddressAPI(created.id, { isDefault: 1 }, other.token))
    assert.equal(requests.length, attempts + 1)
    // 删除不存在于本人名下的地址沿用幂等空操作，不删除别人的记录。
    await api.deleteAddressAPI(created.id, other.token)
    assert.equal((await api.getAddressListAPI(buyer.token)).length, 1)
    await api.deleteAddressAPI(created.id, buyer.token)
    assert.equal((await api.getAddressListAPI(buyer.token)).length, 0)
    assert.equal((await f.app.inject({ method: 'GET', url: '/member/address', headers: { authorization: `Bearer ${other.token}` } })).json().result.length, 0)
    requests.forEach((request, index) => {
      assert.equal(request.headers.Authorization, `Bearer ${index === attempts || index === attempts + 1 ? other.token : buyer.token}`)
      assert.equal(request.headers.xSilentError, '1')
      if (request.method === 'post') assert.deepEqual(JSON.parse(request.data), { ...body, requestKey: key, revision: 1 })
    })
  } finally { await f.app.close() }
})
