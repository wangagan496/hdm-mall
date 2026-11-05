// 独立内存数据；Full 模式只准备账号、地址和购物袋，分页探针另行准备订单。
import { buildTestApp } from '../../server/test/helpers/fixtures.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
const f = await buildTestApp({ databasePath: ':memory:', mockPayments: true,
  publicUrl: 'http://127.0.0.1:3000', uploadsPath: join(tmpdir(), 'hdm-device-trade-uploads') })
const product = f.testData.product({ name: '设备独立测试商品',
  skus: [{ spec: '标准款', priceCents: 2371, stock: 23 }] })
const sku = product.skus[0]!
for (const account of ['device_buyer', 'device_friend', 'device_merchant']) {
  f.testData.account({ account, password: 'Device-trade-123', role: account === 'device_merchant' ? 'merchant' : 'buyer' })
}
const buyer = f.accounts.login('device_buyer', 'Device-trade-123')
const user = f.accounts.authenticate(`Bearer ${buyer.token}`)
const address = f.testData.address({ userId: user.id, receiver: '设备验收', contact: '13800138000', fullLocation: '测试省 测试市 测试区',
  provinceCode: 'test', cityCode: 'test', countyCode: 'test', address: '独立模拟器验收地址', isDefault: 0 })
f.app.get('/device-fixture', async () => ({ fixture: 'device-trade', pid: process.pid,
  skuId: sku.id, amountCents: sku.priceCents, initialStock: sku.stock }))
f.app.addHook('onResponse', async (req, reply) => {
  if (req.method !== 'GET') console.log(JSON.stringify({ method: req.method, route: req.routeOptions.url,
    status: reply.statusCode, contentType: req.headers['content-type'], contentLength: req.headers['content-length'] }))
})
f.app.addHook('onError', async (_req, _reply, error) => { console.log(JSON.stringify({ errorCode: error.code })) })
await f.app.inject({ method: 'POST', url: '/member/cart', headers: { authorization: `Bearer ${buyer.token}` }, payload: { skuId: sku.id, count: 1 } })
if (process.argv.includes('--relations')) {
  for (let index = 0; index <= 10; index++) {
    const account = `probe_${String(index).padStart(2, '0')}`
    const friend = f.testData.account({ account, password: 'Device-trade-123' })
    const id = f.testData.relation({ ownerId: user.id, friendId: friend.id }).id
    f.db.run('UPDATE relations SET created=? WHERE id=?', 1000 + index, id)
  }
}
// 分页探针单独准备 11 笔代付订单；Full 模式仍由设备完成全部交易操作。
if (process.argv.includes('--pagination')) {
  const friend = f.accounts.login('device_friend', 'Device-trade-123')
  const friendUser = f.accounts.authenticate(`Bearer ${friend.token}`)
  f.testData.relation({ ownerId: user.id, friendId: friend.id })
  const orders = f.orders
  for (let index = 1; index <= 11; index++) {
    const order = orders.create(user, { requestKey: randomUUID(), addressId: address.id, goods: [{ skuId: sku.id, count: 1 }] })
    orders.invitePayer(user, order.id, friend.id)
    orders.pay(friendUser, order.id, sku.priceCents)
    f.db.run('UPDATE orders SET created=? WHERE id=?', f.clock.now() - 60000 + index, order.id)
    f.db.run('UPDATE order_items SET name=? WHERE order_id=?', `分页商品 ${String(index).padStart(2, '0')}`, order.id)
  }
}
await f.app.listen({ port: 3103, host: '127.0.0.1' })
console.log('RESULT isolated trade fixture ready')
