import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { serviceFixture } from './helpers/service-fixture.ts'

const company = { titleType: 'company', title: '测试单位', taxId: '91310000TEST1234567', email: 'invoice@example.test' }

test('B1 结算登记开票、商家标记后本人可见，其他买家不可见，审计无邮箱税号', async () => {
  const f = await serviceFixture()
  try {
    const created = await f.create(company)
    assert.equal(created.status, 200)
    const id = created.body.result.id
    const detail = await f.call('GET', `/member/order/${id}`)
    assert.equal(detail.body.result.invoice?.titleType, 'company')
    assert.equal(detail.body.result.invoice.email, company.email)
    assert.equal(detail.body.result.invoice.status, 'requested')
    assert.equal((await f.call('GET', `/member/order/${id}`, undefined, f.other.token)).status, 403)
    assert.equal((await f.call('POST', `/merchant/orders/${id}/invoice/issued`, { requestKey: randomUUID() })).status, 403)
    await f.complete(id)
    const issue = { requestKey: randomUUID(), number: 'TEST-INVOICE-001' }
    assert.equal((await f.call('POST', `/merchant/orders/${id}/invoice/issued`, issue, f.merchant.token)).status, 200)
    assert.equal((await f.call('POST', `/merchant/orders/${id}/invoice/issued`, issue, f.merchant.token)).status, 200)
    const issued = (await f.call('GET', `/member/order/${id}`)).body.result.invoice
    assert.equal(issued.status, 'issued')
    assert.equal(issued.number, issue.number)
    for (const action of ['invoice.request', 'invoice.issued']) {
      const response = await f.call('GET', '/merchant/audit-log?action=' + action, undefined, f.merchant.token)
      assert.equal(response.status, 200)
      assert.equal(response.body.result.counts, 1)
      const audit = JSON.stringify(response.body)
      assert.equal(audit.includes(company.email), false)
      assert.equal(audit.includes(company.taxId), false)
    }
  } finally { await f.close() }
})

test('B1 完成后可补登记，未完成与越权拒绝，个人无需税号、号码可不填', async () => {
  const f = await serviceFixture()
  try {
    const id = (await f.create()).body.result.id
    const data = { titleType: 'individual', title: '个人', email: 'buyer@example.test' }
    const url = `/member/order/${id}/invoice`
    assert.equal((await f.call('PUT', url, data)).status, 409)
    await f.complete(id)
    assert.equal((await f.call('PUT', url, data, f.other.token)).status, 403)
    assert.equal((await f.call('PUT', url, data)).status, 200)
    assert.equal((await f.call('PUT', url, data)).status, 200)
    const issued = await f.call('POST', `/merchant/orders/${id}/invoice/issued`, { requestKey: randomUUID() }, f.merchant.token)
    assert.equal(issued.status, 200)
    assert.equal(issued.body.result.number, '')
    assert.equal((await f.call('PUT', url, { ...data, title: '修改抬头' })).status, 409)
  } finally { await f.close() }
})

test('B1 开票字段校验在下单事务前完成，拒绝缺税号、非法邮箱和空抬头', async () => {
  const f = await serviceFixture()
  try {
    for (const data of [{ ...company, taxId: undefined }, { ...company, taxId: 'bad' },
      { ...company, email: 'not-an-email' }, { ...company, title: '   ' }]) {
      assert.equal((await f.create(data)).status, 400)
    }
    const list = await f.call('GET', '/member/order?page=1&pageSize=10')
    assert.equal(list.status, 200)
    assert.equal(list.body.result.counts, 0)
  } finally { await f.close() }
})
