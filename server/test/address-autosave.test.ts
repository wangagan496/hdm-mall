import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/app.ts'

test('重复请求幂等：地址自动保存沿用同一地址，用户隔离且兼容原新增接口', async () => {
  const ctx = await buildApp({ databasePath: ':memory:', publicUrl: 'http://127.0.0.1:3000', mockPayments: true, uploadsPath: './data/test-uploads' })
  try {
    ctx.accounts.register('address_buyer', 'test-password-123')
    ctx.accounts.register('address_other', 'test-password-123')
    const buyer = ctx.accounts.login('address_buyer', 'test-password-123')
    const other = ctx.accounts.login('address_other', 'test-password-123')
    const requestKey = randomUUID()
    const payload = { receiver: '测试收货人', contact: '13800000000', address: '一号楼', isDefault: 0, requestKey, revision: 1 }
    const create = (token: string, data: object) => ctx.app.inject({ method: 'POST', url: '/member/address', headers: { authorization: `Bearer ${token}` }, payload: data })
    // 模拟第一次成功回应丢失，随后提交最新填写内容。
    const first = await create(buyer.token, payload)
    assert.equal(first.statusCode, 200)
    const id = first.json().result.id as string
    const retry = await create(buyer.token, { ...payload, address: '二号楼', revision: 2 })
    assert.equal(retry.statusCode, 200)
    assert.equal(retry.json().result.id, id)
    const buyerUser = ctx.accounts.authenticate(`Bearer ${buyer.token}`)
    assert.equal(ctx.accounts.addresses(buyerUser).length, 1)
    assert.equal(ctx.accounts.addresses(buyerUser)[0].address, '二号楼')
    assert.equal(ctx.accounts.addresses(buyerUser)[0].requestKey, undefined)
    assert.equal(ctx.accounts.addresses(buyerUser)[0].revision, undefined)
    // SQLite 同步执行；这里验证连续重复请求和迟到版本，不模拟数据库竞态。
    const repeated = await Promise.all([create(buyer.token, payload), create(buyer.token, payload)])
    assert.ok(repeated.every(r => r.statusCode === 200 && r.json().result.id === id))
    assert.equal(ctx.accounts.addresses(buyerUser).length, 1)
    assert.equal(ctx.accounts.addresses(buyerUser)[0].address, '二号楼')
    const equalRevision = await create(buyer.token, { ...payload, address: '不能覆盖同版本', revision: 2 })
    assert.equal(equalRevision.statusCode, 200)
    assert.equal(ctx.accounts.addresses(buyerUser)[0].address, '二号楼')
    const outOfOrder = await Promise.all([
      create(buyer.token, { ...payload, address: '第五版', revision: 5, isDefault: 1 }),
      create(buyer.token, { ...payload, address: '第四版', revision: 4 }),
      create(buyer.token, { ...payload, address: '第三版', revision: 3 })
    ])
    assert.ok(outOfOrder.every(r => r.statusCode === 200 && r.json().result.id === id))
    assert.equal(ctx.accounts.addresses(buyerUser)[0].address, '第五版')
    assert.equal(ctx.accounts.addresses(buyerUser)[0].isDefault, 1)
    const isolated = await create(other.token, payload)
    assert.equal(isolated.statusCode, 200)
    assert.notEqual(isolated.json().result.id, id)
    const forbidden = await ctx.app.inject({ method: 'PUT', url: `/member/address/${id}`, headers: { authorization: `Bearer ${other.token}` }, payload: { address: '不能覆盖别人地址' } })
    assert.equal(forbidden.statusCode, 404)
    const updated = await ctx.app.inject({ method: 'PUT', url: `/member/address/${id}`, headers: { authorization: `Bearer ${buyer.token}` }, payload: { address: '三号楼', requestKey, revision: 6 } })
    assert.equal(updated.statusCode, 200)
    assert.equal(ctx.accounts.addresses(buyerUser)[0].address, '三号楼')
    await create(buyer.token, { ...payload, revision: 5 })
    await ctx.app.inject({ method: 'PUT', url: `/member/address/${id}`, headers: { authorization: `Bearer ${buyer.token}` }, payload: { address: '迟到更新', requestKey, revision: 4 } })
    assert.equal(ctx.accounts.addresses(buyerUser)[0].address, '三号楼')
    const legacyPayload = { receiver: '兼容旧客户端', contact: '13800000000', address: '原新增方式', isDefault: 1 }
    const legacy1 = await create(buyer.token, legacyPayload)
    const legacy2 = await create(buyer.token, legacyPayload)
    assert.equal(legacy1.statusCode, 200)
    assert.equal(legacy2.statusCode, 200)
    assert.notEqual(legacy1.json().result.id, legacy2.json().result.id)
    assert.equal((await create(buyer.token, { ...payload, requestKey: 'invalid' })).statusCode, 400)
    for (const revision of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await create(buyer.token, { ...payload, revision })).statusCode, 400)
    }
  } finally {
    await ctx.app.close()
  }
})

test('删除后同一编辑会话的迟到新增和更新都不能复活地址', async () => {
  const ctx = await buildApp({ databasePath: ':memory:', publicUrl: 'http://127.0.0.1:3000', mockPayments: true, uploadsPath: './data/test-uploads' })
  try {
    ctx.accounts.register('deleted_address', 'test-password-123')
    const buyer = ctx.accounts.login('deleted_address', 'test-password-123')
    const user = ctx.accounts.authenticate(`Bearer ${buyer.token}`)
    const headers = { authorization: `Bearer ${buyer.token}` }
    const payload = { receiver: '测试收货人', contact: '13800000000', address: '已删除地址', isDefault: 0, requestKey: randomUUID(), revision: 1 }
    const created = await ctx.app.inject({ method: 'POST', url: '/member/address', headers, payload })
    assert.equal(created.statusCode, 200)
    const id = created.json().result.id as string
    const editingKey = randomUUID()
    const edited = await ctx.app.inject({ method: 'PUT', url: `/member/address/${id}`, headers, payload: { address: '编辑后删除', requestKey: editingKey, revision: 1 } })
    assert.equal(edited.statusCode, 200)
    const deleted = await ctx.app.inject({ method: 'DELETE', url: `/member/address/${id}`, headers })
    assert.equal(deleted.statusCode, 200)
    for (const requestKey of [payload.requestKey, editingKey]) {
      for (const revision of [1, 2]) {
        const retry = await ctx.app.inject({ method: 'POST', url: '/member/address', headers, payload: { ...payload, requestKey, revision } })
        assert.equal(retry.statusCode, 410)
        const update = await ctx.app.inject({ method: 'PUT', url: `/member/address/${id}`, headers, payload: { address: '迟到重试', requestKey, revision } })
        assert.equal(update.statusCode, 410)
        assert.equal(ctx.accounts.addresses(user).length, 0)
      }
    }
    const fresh = await ctx.app.inject({ method: 'POST', url: '/member/address', headers, payload: { ...payload, requestKey: randomUUID() } })
    assert.equal(fresh.statusCode, 200)
    assert.notEqual(fresh.json().result.id, id)
  } finally { await ctx.app.close() }
})
