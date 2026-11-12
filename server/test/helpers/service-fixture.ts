import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildTestApp } from './fixtures.ts'

export async function serviceFixture(fileBacked = false) {
  const root = await mkdtemp(join(tmpdir(), 'hdm-service-'))
  let now = Date.UTC(2026, 10, 11)
  const ctx = await buildTestApp({ databasePath: fileBacked ? join(root, 'data', 'mall.sqlite') : ':memory:', uploadsPath: join(root, 'uploads'), mockPayments: true,
    publicUrl: 'http://localhost', clock: { now: () => now } })
  const password = randomBytes(24).toString('hex')
  const buyer = ctx.testData.account({ account: 'service_buyer', password })
  const other = ctx.testData.account({ account: 'service_other', password })
  const merchant = ctx.testData.account({ account: 'service_seller', password, role: 'merchant' })
  const address = ctx.testData.address({ userId: buyer.id, receiver: 'Buyer', contact: '13800000000', address: '测试地址' })
  const product = ctx.testData.product({ name: '服务测试商品', skus: [{ spec: '标准', priceCents: 1000, stock: 100 }] })
  const call = async (method: string, url: string, payload?: object, token = buyer.token) => {
    const response = await ctx.app.inject({ method: method as never, url, headers: { authorization: 'Bearer ' + token }, payload })
    return { status: response.statusCode, body: response.json() }
  }
  const create = (invoice?: object) => call('POST', '/member/order', { requestKey: randomUUID(), addressId: address.id,
    goods: [{ skuId: product.skus[0]!.id, count: 1 }], expectedAmountCents: 1000, ...(invoice ? { invoice } : {}) })
  const upload = async (url: string, fields: Record<string, string> = {}, token = buyer.token, image = Buffer.from([255,216,255,217]), mime = 'image/jpeg') => {
    const boundary = 'service-' + randomUUID()
    const prefix = Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('')
    const payload = Buffer.concat([Buffer.from(prefix + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: ${mime}\r\n\r\n`), image, Buffer.from(`\r\n--${boundary}--\r\n`)])
    const response = await ctx.app.inject({ method: 'POST', url, headers: { authorization: 'Bearer ' + token, 'content-type': 'multipart/form-data; boundary=' + boundary }, payload })
    return { status: response.statusCode, body: response.json() }
  }
  const complete = async (id: string) => {
    for (const [method, url, payload, token] of [
      ['POST', `/member/order/${id}/mock-pay`, { amountCents: 1000 }, buyer.token],
      ['POST', `/merchant/orders/${id}/ship`, {}, merchant.token],
      ['PUT', `/member/order/${id}/receipt`, {}, buyer.token]
    ] as const) {
      const response = await call(method, url, payload, token)
      if (response.status !== 200) throw new Error('完成订单失败：' + url + ' ' + response.status)
    }
  }
  return { ctx, root, buyer, other, merchant, product, address, call, create, complete, upload,
    requestDeletion: () => call('POST', '/member/account-deletion', { password, acknowledged: true, requestKey: randomUUID() }),
    loginBuyer: () => { buyer.token = ctx.accounts.login(buyer.account, password).token },
    loginMerchant: () => { merchant.token = ctx.accounts.login(merchant.account, password).token },
    advance: (ms: number) => { now += ms }, close: async () => { await ctx.app.close(); await rm(root, { recursive: true, force: true }) } }
}
