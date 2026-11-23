import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { HTTPMethods } from 'fastify'
import type { Identity } from '../src/identity-context/generated.ts'
import { buildTestApp } from './helpers/fixtures.ts'
import { identityHeaders } from './helpers/identity-headers.ts'

function headers(token: string, identity: Identity, revision = 0) {
  return { authorization: `Bearer ${token}`, 'x-hdm-identity': identity, 'x-hdm-identity-revision': String(revision) }
}

async function fixture() {
  const f = await buildTestApp({ databasePath: ':memory:', uploadsPath: './unused', publicUrl: 'http://localhost', mockPayments: true })
  const password = 'stage-1b-fixture-password'
  const owner = f.testData.account({ account: 'identity_merchant', password, role: 'merchant' })
  const buyer = f.testData.account({ account: 'identity_buyer', password })
  const other = f.testData.account({ account: 'identity_other', password })
  const { skus: [sku] } = f.testData.product({ name: '身份测试商品', skus: [{ spec: '默认规格', priceCents: 2371, stock: 12 }] })
  const goods = [{ skuId: sku!.id, count: 1 }]
  const call = (token: string, method: HTTPMethods, url: string, payload?: object, supplied = identityHeaders(f.accounts, token)) =>
    f.app.inject({ method, url, payload, headers: supplied })
  const change = (token: string, identity: Identity, supplied?: ReturnType<typeof headers>) =>
    call(token, 'POST', '/member/identity/switch', { identity }, supplied)
  const createOrder = async (token: string, id: string, payment = true) => {
    const address = f.testData.address({ userId: id, receiver: '买家', contact: '13800000000', address: '测试地址' })
    const created = await call(token, 'POST', '/member/order', { source: 'buy-now', goods, addressId: address.id,
      expectedAmountCents: 2371, requestKey: randomUUID() })
    assert.equal(created.statusCode, 200)
    const orderId = created.json().result.id as string
    if (payment) assert.equal((await call(token, 'POST', `/member/order/${orderId}/mock-pay`, { amountCents: 2371 })).statusCode, 200)
    return orderId
  }
  return { ...f, owner, buyer, other, call, change, goods, createOrder, password }
}

test('多身份切换保留令牌、只授予已有身份、旧请求无写入且审计保留当时身份', async () => {
  const f = await fixture()
  try {
    assert.deepEqual(f.owner.identities, ['merchant', 'buyer'])
    assert.equal(f.owner.identity, 'merchant')
    assert.deepEqual(f.buyer.identities, ['buyer'])
    const ungranted = await f.change(f.buyer.token, 'merchant')
    assert.equal(ungranted.statusCode, 403)
    assert.equal(ungranted.json().reason, 'IDENTITY_NOT_GRANTED')
    const merchant = headers(f.owner.token, 'merchant')
    const merchantCannotBuy = await f.call(f.owner.token, 'GET', '/member/order/pre')
    assert.equal(merchantCannotBuy.statusCode, 403)
    assert.equal(merchantCannotBuy.json().reason, 'BUYER_REQUIRED')
    const switched = await f.change(f.owner.token, 'buyer', merchant)
    assert.equal(switched.statusCode, 200)
    const buyerContext = { identity: 'buyer', identities: ['merchant', 'buyer'], identityRevision: 1 }
    assert.deepEqual(switched.json().result, buyerContext)
    const noHeaders = await f.app.inject({ url: '/member/profile', headers: { authorization: `Bearer ${f.owner.token}` } })
    assert.equal(noHeaders.statusCode, 409)
    assert.equal(noHeaders.json().reason, 'IDENTITY_CHANGED')
    assert.deepEqual(noHeaders.json().result, buyerContext)
    const profile = await f.call(f.owner.token, 'GET', '/member/profile')
    assert.equal(profile.json().result.token, f.owner.token)
    assert.equal(Object.hasOwn(profile.json().result, 'role'), false)
    const auditCount = () => f.db.one<{ count: number }>('SELECT count(*) count FROM audit_log')!.count
    const before = auditCount()
    const staleMerchant = await f.call(f.owner.token, 'POST', '/merchant/products', {}, merchant)
    assert.equal(staleMerchant.statusCode, 409)
    assert.equal(staleMerchant.json().reason, 'IDENTITY_CHANGED')
    const invalidBody = await f.app.inject({ method: 'POST', url: '/merchant/products', payload: '{',
      headers: { ...merchant, 'content-type': 'application/json' } })
    assert.equal(invalidBody.statusCode, 409)
    assert.equal(invalidBody.json().reason, 'IDENTITY_CHANGED')
    assert.equal(auditCount(), before)
    const buyerCannotSell = await f.call(f.owner.token, 'GET', '/merchant/orders')
    assert.equal(buyerCannotSell.statusCode, 403)
    assert.equal(buyerCannotSell.json().reason, 'MERCHANT_REQUIRED')
    assert.equal((await f.change(f.owner.token, 'merchant')).statusCode, 200)
    assert.equal((await f.change(f.owner.token, 'buyer')).statusCode, 200)
    const staleBuyer = await f.call(f.owner.token, 'POST', '/member/cart',
      { ...f.goods[0], requestKey: randomUUID() }, headers(f.owner.token, 'buyer', 1))
    assert.equal(staleBuyer.statusCode, 409)
    assert.equal(staleBuyer.json().reason, 'IDENTITY_CHANGED')
    assert.equal(f.db.one('SELECT * FROM carts'), undefined)
    assert.deepEqual(f.db.all<{ actor_kind: Identity; summary: string }>(
      "SELECT actor_kind,summary FROM audit_log WHERE action='identity.switch' ORDER BY id").map(row => [row.actor_kind, JSON.parse(row.summary)]), [
      ['merchant', { before: 'merchant', after: 'buyer' }], ['buyer', { before: 'buyer', after: 'merchant' }],
      ['merchant', { before: 'merchant', after: 'buyer' }]
    ])
    const persisted = f.accounts.login(f.owner.account, f.password)
    assert.equal(persisted.identity, 'merchant')
    assert.equal(f.accounts.authenticate(`Bearer ${f.owner.token}`).identity, 'buyer')
    f.db.run("UPDATE user_identities SET revoked_at=granted_at+1 WHERE user_id=? AND identity='buyer'", f.owner.id)
    assert.equal((await f.call(f.owner.token, 'GET', '/member/profile')).statusCode, 401)
  } finally { await f.app.close() }
})

test('每种身份的入口配置各自恢复，冲突、跨身份入口和不可隐藏入口拒绝写入', async () => {
  const f = await fixture()
  const path = '/member/identity-layout'
  const get = () => f.call(f.owner.token, 'GET', path)
  const set = (hiddenEntries: string[], expectedRevision = 0) => f.call(f.owner.token, 'PUT', path, { hiddenEntries, expectedRevision })
  try {
    assert.deepEqual((await get()).json().result, { identity: 'merchant', hiddenEntries: [], revision: 0 })
    for (const entry of ['home-search', 'merchant-orders', 'merchant-after-sales', 'merchant-service', 'does-not-exist']) {
      const denied = await set([entry])
      assert.equal(denied.statusCode, 400)
      assert.equal(denied.json().reason, 'INVALID_IDENTITY_LAYOUT')
    }
    const merchant = { identity: 'merchant', hiddenEntries: ['merchant-products'], revision: 1 }
    assert.deepEqual((await set(merchant.hiddenEntries)).json().result, merchant)
    const conflict = await set(['merchant-promotions'])
    assert.equal(conflict.statusCode, 409)
    assert.equal(conflict.json().reason, 'IDENTITY_LAYOUT_CHANGED')
    assert.deepEqual(conflict.json().result, merchant)
    assert.equal((await f.change(f.owner.token, 'buyer')).statusCode, 200)
    assert.deepEqual((await get()).json().result, { identity: 'buyer', hiddenEntries: [], revision: 0 })
    assert.equal((await set(['buyer-orders'])).statusCode, 400)
    assert.equal((await set(['buyer-service'])).statusCode, 400)
    const buyer = { identity: 'buyer', hiddenEntries: ['home-search'], revision: 1 }
    assert.deepEqual((await set(buyer.hiddenEntries)).json().result, buyer)
    assert.equal((await f.change(f.owner.token, 'merchant')).statusCode, 200)
    assert.deepEqual((await get()).json().result, merchant)
    assert.equal((await f.change(f.owner.token, 'buyer')).statusCode, 200)
    assert.deepEqual((await get()).json().result, buyer)
    assert.equal((await f.call(f.buyer.token, 'GET', path)).json().result.revision, 0)
  } finally { await f.app.close() }
})

test('店主用买家身份可购买付款，评价与退货、仅退款、已付款取消检查稳定的店主归属', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.change(f.owner.token, 'buyer')).statusCode, 200)
    const id = await f.createOrder(f.owner.token, f.owner.id)
    const cancellation = await f.call(f.owner.token, 'POST', `/member/order/${id}/cancel-requests`, { requestKey: randomUUID() })
    assert.equal(cancellation.statusCode, 403)
    assert.equal(cancellation.json().reason, 'OWN_STORE_ACTION')
    const merchantSession = f.accounts.login(f.owner.account, f.password)
    const paymentId = f.db.one<{ id: string }>("SELECT id FROM payments WHERE order_id=? AND state='succeeded'", id)!.id
    const requestId = randomUUID()
    const now = f.clock.now()
    // Historical pending case for the merchant-side boundary. The buyer endpoint above cannot create it.
    f.db.run("INSERT INTO order_cancel_requests(id,order_id,sequence,requested_by,payment_id,state,created,deadline_at) VALUES(?,?,1,?,?,'pending',?,?)",
      requestId, id, f.owner.id, paymentId, now, now + 72 * 3600_000)
    const resolve = await f.call(merchantSession.token, 'POST', `/merchant/orders/${id}/cancel-requests/${requestId}/resolve`,
      { requestKey: randomUUID(), decision: 'approve' })
    assert.equal(resolve.statusCode, 403)
    assert.equal(resolve.json().reason, 'OWN_STORE_ACTION')
    assert.equal(f.db.one<{ state: string }>('SELECT state FROM order_cancel_requests WHERE id=?', requestId)!.state, 'pending')
    f.db.run('DELETE FROM order_cancel_requests WHERE id=?', requestId)
    assert.equal((await f.call(merchantSession.token, 'POST', `/merchant/orders/${id}/ship`, { carrier: '顺丰', trackingNo: 'SF12345678' })).statusCode, 200)
    assert.equal((await f.call(f.owner.token, 'PUT', `/member/order/${id}/receipt`)).statusCode, 200)
    for (const kind of ['return-no-reason', 'return-quality', 'refund-missing']) {
      const sale = await f.call(f.owner.token, 'POST', `/member/order/${id}/after-sales`, { requestKey: randomUUID(), kind, items: f.goods })
      assert.equal(sale.statusCode, 403)
      assert.equal(sale.json().reason, 'OWN_STORE_ACTION')
      assert.match(sale.json().msg, /店主不能/)
    }
    const review = await f.call(f.owner.token, 'PUT', `/member/order/${id}/evaluation`, { score: 5, content: '不能评价自家商品' })
    assert.equal(review.statusCode, 403)
    assert.equal(review.json().reason, 'OWN_STORE_ACTION')
    assert.match(review.json().msg, /不能评价自家店铺/)
    for (const table of ['evaluations', 'after_sale_actions', 'order_cancel_actions', 'refunds']) {
      assert.equal(f.db.one(`SELECT * FROM ${table}`), undefined)
    }
    const unpaid = await f.createOrder(f.owner.token, f.owner.id, false)
    assert.equal((await f.call(f.owner.token, 'PUT', `/member/order/${unpaid}/cancel`)).statusCode, 200)
  } finally { await f.app.close() }
})

test('多身份亲友仅在买家身份和既有绑定范围内代付', async () => {
  const f = await fixture()
  try {
    const id = await f.createOrder(f.buyer.token, f.buyer.id, false)
    const payerPath = `/member/order/${id}/payer`
    const payPath = `/member/order/${id}/mock-pay`
    assert.equal((await f.call(f.buyer.token, 'PUT', payerPath, { friendId: f.owner.id })).statusCode, 403)
    const invitation = await f.call(f.buyer.token, 'POST', '/member/relations', { account: f.owner.account })
    assert.equal(invitation.statusCode, 200)
    const relationPath = `/member/relations/${invitation.json().result.id}`
    assert.equal((await f.call(f.owner.token, 'PUT', relationPath, { action: 'accept' })).statusCode, 403)
    assert.equal((await f.change(f.owner.token, 'buyer')).statusCode, 200)
    assert.equal((await f.call(f.owner.token, 'PUT', relationPath, { action: 'accept' })).statusCode, 200)
    assert.equal((await f.call(f.buyer.token, 'PUT', payerPath, { friendId: f.owner.id })).statusCode, 200)
    assert.equal((await f.call(f.other.token, 'POST', payPath, { amountCents: 2371 })).statusCode, 403)
    assert.equal((await f.change(f.owner.token, 'merchant')).statusCode, 200)
    assert.equal((await f.call(f.owner.token, 'POST', payPath, { amountCents: 2371 })).json().reason, 'BUYER_REQUIRED')
    assert.equal((await f.change(f.owner.token, 'buyer')).statusCode, 200)
    assert.equal((await f.call(f.owner.token, 'POST', payPath, { amountCents: 2371 })).statusCode, 200)
    assert.equal(f.db.one<{ paid_by: string }>('SELECT paid_by FROM orders WHERE id=?', id)!.paid_by, f.owner.id)
    assert.equal((await f.call(f.owner.token, 'PUT', `/member/order/${id}/evaluation`, { score: 5, content: '亲友不能替买家评价' })).statusCode, 403)
  } finally { await f.app.close() }
})

test('报价和退货确认凭据绑定身份版本，切回买家后旧凭据不继续使用', async () => {
  const f = await fixture()
  try {
    const quotePath = '/member/quote-preview'
    const skuId = f.goods[0]!.skuId
    assert.equal((await f.change(f.owner.token, 'buyer')).statusCode, 200)
    const previous = (await f.call(f.owner.token, 'POST', quotePath, { items: f.goods })).json().result.receipt
    const repeat = () => f.call(f.owner.token, 'POST', quotePath, { items: f.goods, previousReceipt: previous })
    assert.ok((await repeat()).json().result.comparison)
    const policy = (await f.call(f.owner.token, 'GET', `/member/order/pre?skuId=${skuId}&count=1`)).json().result.returnPolicyToken
    assert.equal((await f.change(f.owner.token, 'merchant')).statusCode, 200)
    assert.equal((await repeat()).statusCode, 403)
    assert.equal((await f.change(f.owner.token, 'buyer')).statusCode, 200)
    assert.equal((await repeat()).json().result.comparison, null)
    const address = f.testData.address({ userId: f.owner.id, receiver: '买家', contact: '13800000000', address: '测试地址' })
    const stale = await f.call(f.owner.token, 'POST', '/member/order', {
      addressId: address.id, source: 'buy-now', goods: f.goods, expectedAmountCents: 2371,
      expectedReturnPolicyToken: policy, requestKey: randomUUID(), returnPolicyConfirmed: true
    })
    assert.equal(stale.statusCode, 409)
    assert.equal(stale.json().reason, 'RETURN_POLICY_CHANGED')
    assert.equal(f.db.one('SELECT id FROM orders'), undefined)
  } finally { await f.app.close() }
})

test('两次登录切到相同身份版本，旧登录的报价和退货确认凭据不能跨会话使用', async () => {
  const f = await fixture()
  try {
    const quotePath = '/member/quote-preview'
    const prePath = `/member/order/pre?skuId=${f.goods[0]!.skuId}&count=1`
    const quote = async (token: string, previousReceipt?: string) => {
      const response = await f.call(token, 'POST', quotePath, { items: f.goods, previousReceipt })
      assert.equal(response.statusCode, 200)
      return response.json().result
    }
    const firstSwitch = await f.change(f.owner.token, 'buyer')
    assert.equal(firstSwitch.statusCode, 200)
    const oldQuote = await quote(f.owner.token)
    const oldPolicy = (await f.call(f.owner.token, 'GET', prePath)).json().result.returnPolicyToken
    assert.ok((await quote(f.owner.token, oldQuote.receipt)).comparison)
    assert.equal((await f.call(f.owner.token, 'POST', '/logout')).statusCode, 200)

    const login = await f.app.inject({ method: 'POST', url: '/login', payload: { account: f.owner.account, password: f.password } })
    assert.equal(login.statusCode, 200)
    const secondToken = login.json().result.token as string
    assert.notEqual(secondToken, f.owner.token)
    const secondSwitch = await f.change(secondToken, 'buyer')
    assert.deepEqual(secondSwitch.json().result, firstSwitch.json().result)
    const newQuote = await quote(secondToken, oldQuote.receipt)
    assert.equal(newQuote.comparison, null)
    assert.ok((await quote(secondToken, newQuote.receipt)).comparison)

    const address = f.testData.address({ userId: f.owner.id, receiver: '买家', contact: '13800000000', address: '测试地址' })
    const order = (expectedReturnPolicyToken: string) => f.call(secondToken, 'POST', '/member/order', {
      addressId: address.id, source: 'buy-now', goods: f.goods, expectedAmountCents: 2371,
      expectedReturnPolicyToken, requestKey: randomUUID(), returnPolicyConfirmed: true
    })
    const stale = await order(oldPolicy)
    assert.equal(stale.statusCode, 409)
    assert.equal(stale.json().reason, 'RETURN_POLICY_CHANGED')
    assert.equal(f.db.one('SELECT id FROM orders'), undefined)
    const latestPolicy = (await f.call(secondToken, 'GET', prePath)).json().result.returnPolicyToken
    assert.equal((await order(latestPolicy)).statusCode, 200)
  } finally { await f.app.close() }
})

test('等待渠道账单期间切换身份，迟到对账返回409且无写入', async () => {
  const f = await fixture()
  let begin!: () => void
  let release!: (rows: []) => void
  const entered = new Promise<void>(resolve => { begin = resolve })
  const blocked = new Promise<[]>(resolve => { release = resolve })
  try {
    const date = '2026-01-01'
    const channel = f.payments.channel!
    const original = channel.exportBill!.bind(channel)
    channel.exportBill = requested => {
      if (requested !== date) return original(requested)
      begin()
      return blocked
    }
    const run = f.call(f.owner.token, 'POST', '/merchant/reconciliation/run', { date }, headers(f.owner.token, 'merchant'))
    await entered
    assert.equal((await f.change(f.owner.token, 'buyer')).statusCode, 200)
    release([])
    const rejected = await run
    assert.equal(rejected.statusCode, 409)
    assert.equal(rejected.json().reason, 'IDENTITY_CHANGED')
    assert.equal(f.db.one('SELECT date FROM reconciliation_runs WHERE date=?', date), undefined)
    assert.equal(f.db.one('SELECT id FROM reconciliation_differences WHERE date=?', date), undefined)
  } finally {
    release([])
    await f.app.close()
  }
})
