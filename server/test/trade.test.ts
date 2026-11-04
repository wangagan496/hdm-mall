import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HTTPMethods } from 'fastify'
import { buildApp } from '../src/app.ts'

async function fixture(databasePath = ':memory:') {
  const ctx = await buildApp({ databasePath, publicUrl: 'http://127.0.0.1:3000', mockPayments: true, uploadsPath: './data/test-uploads' })
  const call = async (method: HTTPMethods, url: string, token = '', payload?: object) => {
    const res = await ctx.app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload })
    return { status: res.statusCode, body: res.json() }
  }
  const login = async (name: string) => {
    const r = await call('POST', '/login', '', { account: name, password: 'test-password-123' })
    assert.equal(r.status, 200)
    return r.body.result as { id: string; token: string }
  }
  const users: Record<string, { id: string; token: string }> = {}
  for (const name of ['buyer','payer','receiver','another','stranger','merchant']) {
    ctx.accounts.register(name, 'test-password-123', name === 'merchant' ? 'merchant' : 'buyer')
    users[name] = await login(name)
  }
  const address = await call('POST', '/member/address', users.buyer!.token, { receiver: '购买人', contact: '13800000000', address: '测试地址', isDefault: 0 })
  assert.equal(address.status, 200)
  const bind = async (name: string) => {
    const invitation = await call('POST', '/member/relations', users.buyer!.token, { account: name })
    assert.equal(invitation.status, 200)
    const id = invitation.body.result.id as string
    const accepted = await call('PUT', `/member/relations/${id}`, users[name]!.token, { action: 'accept' })
    assert.equal(accepted.status, 200)
    return id
  }
  const create = async (requestKey = randomUUID(), count = 1) => {
    const response = await call('POST', '/member/order', users.buyer!.token, { addressId: address.body.result.id, requestKey, goods: [{ skuId: 'hdm-1-a', count }] })
    return response
  }
  const paidOrder = async (family: boolean) => {
    const created = await create(); assert.equal(created.status, 200)
    const id = created.body.result.id as string
    if (family) {
      await bind('payer')
      assert.equal((await call('PUT', `/member/order/${id}/payer`, users.buyer!.token, { friendId: users.payer!.id })).status, 200)
    }
    assert.equal((await call('POST', `/member/order/${id}/mock-pay`, users[family ? 'payer' : 'buyer']!.token, { amountCents: 1900 })).status, 200)
    assert.equal((await call('POST', `/merchant/orders/${id}/ship`, users.merchant!.token)).status, 200)
    return id
  }
  return { ...ctx, call, users, bind, create, paidOrder, login, addressId: address.body.result.id as string }
}

test('重复请求幂等：重复注册同一账号恰好一次成功，唯一约束冲突返回 409', async () => {
  const f = await buildApp({ databasePath: ':memory:', publicUrl: 'http://127.0.0.1:3000', mockPayments: true, uploadsPath: './data/test-uploads' })
  try {
    const register = () => f.app.inject({ method: 'POST', url: '/register', payload: { account: 'concurrent_user', password: 'test-password-123' } })
    const results = await Promise.all([register(), register()])
    assert.deepEqual(results.map(r => r.statusCode).sort(), [200,409])
    assert.equal(f.db.all('SELECT id FROM users WHERE account=?', 'concurrent_user').length, 1)
  } finally { await f.app.close() }
})

test('本人下单、支付、商家发货、本人收货和评价，评价可查询', async () => {
  const f = await fixture()
  try {
    const id = await f.paidOrder(false), token = f.users.buyer!.token
    assert.equal((await f.call('PUT', `/member/order/${id}/receipt`, token)).status, 200)
    assert.equal((await f.call('PUT', `/member/order/${id}/evaluation`, token, { score: 5, content: '质量很好下次再来' })).status, 200)
    const order = (await f.call('GET', `/member/order/${id}`, token)).body.result
    assert.equal(order.orderState, 5); assert.equal(order.evaluation.content, '质量很好下次再来'); assert.equal(order.receivedByAccount, 'buyer')
    const evaluations = await f.call('GET', '/goods/hdm-1/evaluate/page')
    assert.equal(evaluations.status, 200)
    assert.equal(evaluations.body.result.items.length, 1)
    assert.equal(evaluations.body.result.items[0].member.nickname, 'b***r')
    assert.equal(JSON.stringify(evaluations.body).includes('buyer'), false)
    for (const nickname of ['张', '张三', '张三丰', '😀小明😀']) {
      f.db.run('UPDATE users SET nickname=? WHERE id=?', nickname, f.users.buyer!.id)
      const masked = (await f.call('GET', '/goods/hdm-1/evaluate/page')).body.result.items[0].member.nickname
      assert.equal(masked, nickname === '张' || nickname === '张三' ? '张***' : nickname === '张三丰' ? '张***丰' : '😀***😀')
    }
  } finally { await f.app.close() }
})

test('亲友代付后所有已绑定代收人都有资格，无需每单指定；仅一次确认成功', async () => {
  const f = await fixture()
  try {
    await f.bind('receiver'); await f.bind('another')
    const id = await f.paidOrder(true)
    for (const name of ['buyer','payer','receiver','another']) {
      const result = await f.call('GET', `/member/order/${id}`, f.users[name]!.token)
      assert.equal(result.body.result.canReceive, true)
      if (name !== 'buyer') assert.equal(result.body.result.address, undefined)
    }
    const results = await Promise.all(['receiver','another'].map(name => f.call('PUT', `/member/order/${id}/receipt`, f.users[name]!.token)))
    assert.deepEqual(results.map(r => r.status).sort(), [200,409])
    const order = (await f.call('GET', `/member/order/${id}`, f.users.buyer!.token)).body.result
    assert.ok(['receiver','another'].includes(order.receivedByAccount))
    assert.equal(order.payerAccount, 'payer'); assert.equal(order.orderState, 4)
    assert.equal((await f.call('PUT', `/member/order/${id}/evaluation`, f.users.payer!.token, { score: 5, content: '亲友不能代替评价' })).status, 403)
  } finally { await f.app.close() }
})

test('本人付款订单不授予亲友收货权，陌生人与未确认绑定均被拒绝', async () => {
  const f = await fixture()
  try {
    await f.bind('receiver')
    const self = await f.paidOrder(false)
    assert.equal((await f.call('PUT', `/member/order/${self}/receipt`, f.users.receiver!.token)).status, 403)
    const family = await f.paidOrder(true)
    const invitation = await f.call('POST', '/member/relations', f.users.buyer!.token, { account: 'another' })
    assert.equal((await f.call('PUT', `/member/relations/${invitation.body.result.id}`, f.users.buyer!.token, { action: 'accept' })).status, 403)
    for (const name of ['stranger','another']) {
      assert.equal((await f.call('PUT', `/member/order/${family}/receipt`, f.users[name]!.token)).status, 403)
      assert.equal((await f.call('GET', `/member/order/${family}`, f.users[name]!.token)).status, 403)
    }
  } finally { await f.app.close() }
})

test('解除绑定立即失去代收资格，解绑不改变付款历史', async () => {
  const f = await fixture()
  try {
    const relation = await f.bind('receiver'), id = await f.paidOrder(true)
    assert.equal((await f.call('PUT', `/member/relations/${relation}`, f.users.buyer!.token, { action: 'revoke' })).status, 200)
    assert.equal((await f.call('PUT', `/member/order/${id}/receipt`, f.users.receiver!.token)).status, 403)
    assert.equal((await f.call('GET', '/member/family-orders', f.users.receiver!.token)).body.result.length, 0)
    const buyer = (await f.call('GET', `/member/order/${id}`, f.users.buyer!.token)).body.result
    assert.equal(buyer.payerAccount, 'payer'); assert.equal(buyer.canReceive, true)
  } finally { await f.app.close() }
})

test('仅指定且仍绑定的亲友能代付，购买人可以切回本人付款', async () => {
  const f = await fixture()
  try {
    const relation = await f.bind('payer'), created = await f.create(), id = created.body.result.id
    assert.equal((await f.call('PUT', `/member/order/${id}/payer`, f.users.buyer!.token, { friendId: f.users.payer!.id })).status, 200)
    assert.equal((await f.call('POST', `/member/order/${id}/mock-pay`, f.users.buyer!.token, { amountCents: 1900 })).status, 403)
    assert.equal((await f.call('POST', `/member/order/${id}/mock-pay`, f.users.stranger!.token, { amountCents: 1900 })).status, 403)
    await f.call('PUT', `/member/relations/${relation}`, f.users.payer!.token, { action: 'revoke' })
    assert.equal((await f.call('POST', `/member/order/${id}/mock-pay`, f.users.payer!.token, { amountCents: 1900 })).status, 403)
    await f.call('PUT', `/member/order/${id}/payer`, f.users.buyer!.token, { friendId: null })
    assert.equal((await f.call('POST', `/member/order/${id}/mock-pay`, f.users.buyer!.token, { amountCents: 1 })).status, 409)
    assert.equal((await f.call('POST', `/member/order/${id}/mock-pay`, f.users.buyer!.token, { amountCents: 1900 })).status, 200)
  } finally { await f.app.close() }
})

test('重复请求幂等：连续购买最后一件只有一次成功，全部售罄下架，取消仅释放一次', async () => {
  const f = await fixture()
  try {
    f.db.run('UPDATE skus SET stock=0 WHERE product_id=?', 'hdm-1')
    f.db.run('UPDATE skus SET stock=1 WHERE id=?', 'hdm-1-a')
    const results = await Promise.all([f.create(), f.create()])
    assert.deepEqual(results.map(r => r.status).sort(), [200,409])
    const id = results.find(r => r.status === 200)!.body.result.id
    assert.equal((await f.call('GET', '/home/new')).body.result.some((p: { id: string }) => p.id === 'hdm-1'), false)
    assert.equal((await f.call('GET', '/goods?id=hdm-1')).body.inventory, 0)
    for (let i = 0; i < 2; i++) assert.equal((await f.call('PUT', `/member/order/${id}/cancel`, f.users.buyer!.token)).status, 200)
    assert.equal(f.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', 'hdm-1-a')!.stock, 1)
  } finally { await f.app.close() }
})

test('下单幂等、库存事务回滚、账号隔离与超时释放', async () => {
  const f = await fixture()
  try {
    const key = randomUUID(), first = await f.create(key), retry = await f.create(key)
    assert.equal(first.body.result.id, retry.body.result.id)
    assert.equal((await f.create(key, 2)).status, 409)
    assert.equal(f.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', 'hdm-1-a')!.stock, 19)
    const fail = await f.call('POST', '/member/order', f.users.buyer!.token, { requestKey: randomUUID(), addressId: f.addressId, goods: [{ skuId: 'hdm-1-a', count: 1 }, { skuId: 'hdm-2-a', count: 999 }] })
    assert.equal(fail.status, 409)
    assert.equal(f.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', 'hdm-1-a')!.stock, 19)
    assert.equal((await f.call('POST', '/member/order', f.users.stranger!.token, { requestKey: randomUUID(), addressId: f.addressId, goods: [{ skuId: 'hdm-1-a', count: 1 }] })).status, 400)
    const id = first.body.result.id
    f.db.run('UPDATE orders SET expires=0 WHERE id=?', id)
    assert.equal((await f.call('GET', `/member/order/${id}`, f.users.buyer!.token)).body.result.orderState, 6)
    assert.equal(f.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', 'hdm-1-a')!.stock, 20)
    assert.equal((await f.call('POST', `/member/order/${id}/mock-pay`, f.users.buyer!.token, { amountCents: 1900 })).status, 409)
  } finally { await f.app.close() }
})

test('购买人无发货权限，提醒不改变状态，注销撤销会话', async () => {
  const f = await fixture()
  try {
    const id = (await f.create()).body.result.id, token = f.users.buyer!.token
    await f.call('POST', `/member/order/${id}/mock-pay`, token, { amountCents: 1900 })
    assert.equal((await f.call('POST', `/merchant/orders/${id}/ship`, token)).status, 403)
    assert.equal((await f.call('POST', `/member/order/${id}/reminder`, token)).status, 200)
    assert.equal((await f.call('GET', `/member/order/${id}`, token)).body.result.orderState, 2)
    assert.equal((await f.call('PUT', `/member/order/${id}/receipt`, token)).status, 409)
    await f.call('POST', '/logout', token)
    assert.equal((await f.call('GET', '/member/order', token)).status, 401)
  } finally { await f.app.close() }
})

test('数据重启后可恢复；真实 HTTP 监听与查询通过', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hdm-trade-')), path = join(dir, 'test.sqlite')
  const f = await fixture(path)
  const id = await f.paidOrder(true), token = f.users.buyer!.token
  await f.app.close()
  const next = await buildApp({ databasePath: path, publicUrl: 'http://127.0.0.1:3000', mockPayments: true, uploadsPath: join(dir, 'uploads') })
  try {
    const url = await next.app.listen({ port: 0, host: '127.0.0.1' })
    assert.equal((await fetch(url + '/health')).status, 200)
    const response = await fetch(`${url}/member/order/${id}`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(response.status, 200)
    const order = (await response.json()).result
    assert.equal(order.orderState, 3); assert.equal(order.payerAccount, 'payer')
  } finally { await next.app.close(); await rm(dir, { recursive: true, force: true }) }
})

test('正式环境拒绝模拟支付配置', async () => {
  await assert.rejects(() => buildApp({ databasePath: ':memory:', publicUrl: 'https://example.invalid', mockPayments: true, production: true, uploadsPath: './unused' }), /正式环境/)
})

test('Origin null 在生产环境也完全按显式白名单配置放行', async () => {
  const development = await buildApp({ databasePath: ':memory:', publicUrl: 'http://127.0.0.1:3000', mockPayments: false, corsOrigins: ['null'], uploadsPath: './unused' })
  const productionBlocked = await buildApp({ databasePath: ':memory:', publicUrl: 'https://example.invalid', mockPayments: false, production: true, corsOrigins: ['https://example.invalid'], uploadsPath: './unused' })
  const production = await buildApp({ databasePath: ':memory:', publicUrl: 'https://example.invalid', mockPayments: false, production: true, corsOrigins: ['null'], uploadsPath: './unused' })
  try {
    assert.equal((await development.app.inject({ method: 'GET', url: '/health', headers: { origin: 'null' } })).statusCode, 200)
    assert.equal((await productionBlocked.app.inject({ method: 'GET', url: '/health', headers: { origin: 'null' } })).statusCode, 403)
    const allowed = await production.app.inject({ method: 'GET', url: '/health', headers: { origin: 'null' } })
    assert.equal(allowed.statusCode, 200)
    assert.equal(allowed.headers['access-control-allow-origin'], 'null')
    const preflight = await production.app.inject({ method: 'OPTIONS', url: '/member/profile', headers: { origin: 'null', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } })
    assert.equal(preflight.statusCode, 204)
    assert.equal(preflight.headers['access-control-allow-origin'], 'null')
    assert.equal(preflight.headers['access-control-allow-headers'], 'Authorization,Content-Type')
    assert.equal((await production.app.inject({ method: 'GET', url: '/member/profile', headers: { origin: 'null' } })).statusCode, 401)
  } finally {
    await development.app.close()
    await productionBlocked.app.close()
    await production.app.close()
  }
})

test('默认地址局部更新和空更新保留默认标记，显式传入仍可修改', async () => {
  const f = await fixture()
  try {
    const token = f.users.buyer!.token, url = `/member/address/${f.addressId}`
    const extra = await f.call('POST', '/member/address', token, { receiver: '备用', contact: '13800000001', address: '备用地址' })
    assert.equal(extra.status, 200)
    assert.equal((await f.call('GET', `/member/address/${extra.body.result.id}`, token)).body.result.isDefault, 1)
    assert.equal((await f.call('GET', url, token)).body.result.isDefault, 0)
    const updated = await f.call('PUT', url, token, { receiver: '新收货人' })
    assert.equal(updated.status, 200)
    const saved = (await f.call('GET', url, token)).body.result
    assert.equal(saved.receiver, '新收货人')
    assert.equal(saved.isDefault, 0)
    assert.equal((await f.call('GET', `/member/address/${extra.body.result.id}`, token)).body.result.isDefault, 1)
    const unchanged = await f.call('PUT', url, token, {})
    assert.equal(unchanged.status, 200)
    const stored = (await f.call('GET', url, token)).body.result
    assert.equal(stored.isDefault, 0)
    assert.equal(stored.contact, '13800000000')
    assert.equal(stored.address, '测试地址')
    assert.equal((await f.call('PUT', url, token, { isDefault: 1 })).status, 200)
    assert.equal((await f.call('GET', url, token)).body.result.isDefault, 1)
  } finally { await f.app.close() }
})
