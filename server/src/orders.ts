import { randomUUID } from 'node:crypto'
import { Database } from './database.ts'
import { Accounts, type User } from './accounts.ts'
import { Catalog } from './catalog.ts'
import { ensure } from './errors.ts'

interface Order {
  id: string; owner_id: string; state: number; amount: number; address: string;
  request_key: string; request_body: string; created: number; expires: number;
  invited_payer: string | null; paid_by: string | null; paid_at: number | null;
  received_by: string | null; received_at: number | null; shipped_at: number | null
}
interface Item { order_id: string; sku_id: string; product_id: string; name: string; picture: string; spec: string; price: number; count: number }
export interface CreateOrder {
  requestKey: string; addressId: string; goods: { skuId: string; count: number }[]
}
export class Orders {
  db: Database
  accounts: Accounts
  catalog: Catalog
  mockPayments: boolean
  constructor(db: Database, accounts: Accounts, catalog: Catalog, mockPayments: boolean) {
    this.db = db; this.accounts = accounts; this.catalog = catalog; this.mockPayments = mockPayments
  }
  private get(id: string): Order {
    const order = this.db.one<Order>('SELECT * FROM orders WHERE id=?', id)
    ensure(order, 404, '订单不存在')
    return order
  }
  private items(id: string) { return this.db.all<Item>('SELECT * FROM order_items WHERE order_id=?', id) }
  private owner(user: User, order: Order) { ensure(user.id === order.owner_id, 403, '只有下单人可以操作') }
  private proxyReceipt(user: User, order: Order) {
    return !!order.paid_by && order.paid_by !== order.owner_id && this.accounts.bound(order.owner_id, user.id)
  }
  private canRead(user: User, order: Order) {
    return user.id === order.owner_id || user.id === order.paid_by ||
      (order.state === 1 && user.id === order.invited_payer && this.accounts.bound(order.owner_id, user.id)) ||
      (order.state === 3 && this.proxyReceipt(user, order)) || user.id === order.received_by
  }
  private account(id: string | null) { return id ? this.db.one<{ account: string }>('SELECT account FROM users WHERE id=?', id)?.account ?? '' : '' }
  private present(order: Order, user: User) {
    const own = order.owner_id === user.id
    const items = this.items(order.id)
    const evaluation = this.db.one<{ score: number; content: string; created: number }>('SELECT * FROM evaluations WHERE order_id=?', order.id)
    return {
      id: order.id, orderState: order.state, ownerAccount: this.account(order.owner_id),
      payerAccount: this.account(order.paid_by), invitedPayerAccount: this.account(order.invited_payer), receivedByAccount: this.account(order.received_by),
      paymentMode: order.paid_by ? (order.paid_by === order.owner_id ? 'self' : 'family') : (order.invited_payer ? 'family' : 'self'),
      receivedAt: order.received_at, serverManaged: true,
      canPay: order.state === 1 && (order.invited_payer ? order.invited_payer === user.id && this.accounts.bound(order.owner_id, user.id) : own),
      canReceive: order.state === 3 && (own || this.proxyReceipt(user, order)),
      canEvaluate: own && order.state === 4, canInvitePayer: own && order.state === 1,
      countdown: Math.max(0, Math.floor((order.expires - Date.now()) / 1000)),
      createTime: new Date(order.created).toISOString(), payLatestTime: new Date(order.expires).toISOString(),
      payMoney: order.amount / 100, totalMoney: order.amount / 100, postFee: 0, payChannel: 1, payType: 1,
      totalNum: items.reduce((sum, item) => sum + item.count, 0),
      skus: items.map(item => ({ id: item.sku_id, spuId: item.product_id, name: item.name, image: item.picture,
        attrsText: item.spec, properties: [{ propertyMainName: '规格', propertyValueName: item.spec }],
        quantity: item.count, realPay: item.price / 100, curPrice: item.price / 100 })),
      evaluation: evaluation ? { orderId: order.id, score: evaluation.score, content: evaluation.content, createdAt: evaluation.created } : null,
      ...(own || user.role === 'merchant' ? { address: JSON.parse(order.address) } : {})
    }
  }
  detail(user: User, id: string) {
    this.expire()
    const order = this.get(id)
    ensure(this.canRead(user, order), 403, '无权查看此订单')
    return this.present(order, user)
  }
  list(user: User, state = 0, family = false) {
    this.expire()
    const orders = family ? this.db.all<Order>('SELECT * FROM orders ORDER BY created DESC,id').filter(o =>
      o.owner_id !== user.id && this.canRead(user, o) && (!state || o.state === state)
    ) : state ? this.db.all<Order>('SELECT * FROM orders WHERE owner_id=? AND state=? ORDER BY created DESC,id', user.id, state)
      : this.db.all<Order>('SELECT * FROM orders WHERE owner_id=? ORDER BY created DESC,id', user.id)
    return orders.map(o => this.present(o, user))
  }
  preOrder(user: User) {
    this.expire()
    const goods = this.catalog.cart(user).filter(item => item.selected).map(item => ({ ...item,
      price: String(item.price), payPrice: String(item.price), totalPrice: String(item.price * item.count), totalPayPrice: String(item.price * item.count) }))
    const total = goods.reduce((sum, item) => sum + Math.round(Number(item.price) * 100) * item.count, 0) / 100
    return { goods, userAddresses: this.accounts.addresses(user), summary: { discountPrice: 0, goodsCount: goods.reduce((sum, item) => sum + item.count, 0), postFee: 0, totalPayPrice: total, totalPrice: total } }
  }
  create(user: User, data: CreateOrder) {
    this.expire()
    const canonical = JSON.stringify({ addressId: data.addressId, goods: [...data.goods].sort((a, b) => a.skuId.localeCompare(b.skuId)) })
    return this.db.transaction(() => {
      const existing = this.db.one<Order>('SELECT * FROM orders WHERE owner_id=? AND request_key=?', user.id, data.requestKey)
      if (existing) {
        ensure(existing.request_body === canonical, 409, '同一次下单不能修改商品或地址，请重新结算')
        return { id: existing.id }
      }
      ensure(new Set(data.goods.map(i => i.skuId)).size === data.goods.length, 400, '商品规格重复')
      const address = this.db.one<{ data: string }>('SELECT data FROM addresses WHERE id=? AND user_id=?', data.addressId, user.id)
      ensure(address, 400, '请选择自己的收货地址')
      const items = data.goods.map(item => ({ ...this.catalog.sku(item.skuId), count: item.count }))
      for (const item of items) {
        const result = this.db.run('UPDATE skus SET stock=stock-? WHERE id=? AND stock>=?', item.count, item.id, item.count)
        ensure(result.changes === 1, 409, '商品刚刚售罄或剩余库存不足，请刷新')
      }
      const amount = items.reduce((sum, i) => sum + i.price * i.count, 0)
      const id = randomUUID(), now = Date.now()
      this.db.run('INSERT INTO orders(id,owner_id,state,amount,address,request_key,request_body,created,expires) VALUES(?,?,1,?,?,?,?,?,?)', id, user.id, amount, address.data, data.requestKey, canonical, now, now + 15 * 60_000)
      for (const item of items) {
        this.db.run('INSERT INTO order_items VALUES(?,?,?,?,?,?,?,?)', id, item.id, item.product_id, item.name, item.picture, item.spec, item.price, item.count)
        this.db.run('DELETE FROM carts WHERE user_id=? AND sku_id=?', user.id, item.id)
      }
      return { id }
    })
  }
  private restore(order: Order) {
    for (const item of this.items(order.id)) this.db.run('UPDATE skus SET stock=stock+? WHERE id=?', item.count, item.sku_id)
    this.db.run('UPDATE orders SET state=6 WHERE id=? AND state=1', order.id)
  }
  expire() {
    if (!this.db.one('SELECT id FROM orders WHERE state=1 AND expires<=? LIMIT 1', Date.now())) return
    this.db.transaction(() => {
      for (const order of this.db.all<Order>('SELECT * FROM orders WHERE state=1 AND expires<=?', Date.now())) this.restore(order)
    })
  }
  cancel(user: User, id: string) {
    return this.db.transaction(() => {
      const order = this.get(id); this.owner(user, order)
      if (order.state === 6) return { id }
      ensure(order.state === 1, 409, '只有未付款订单可以取消')
      this.restore(order)
      return { id }
    })
  }
  invitePayer(user: User, id: string, friendId: string | null) {
    this.expire()
    return this.db.transaction(() => {
      const order = this.get(id); this.owner(user, order)
      ensure(order.state === 1, 409, '只能为待付款订单选择付款方式')
      ensure(!friendId || this.accounts.bound(user.id, friendId), 403, '只能邀请已确认绑定的亲友代付')
      this.db.run('UPDATE orders SET invited_payer=? WHERE id=?', friendId, id)
      return { id }
    })
  }
  pay(user: User, id: string, expectedAmount: number) {
    ensure(this.mockPayments, 403, '此环境未启用模拟支付')
    this.expire()
    return this.db.transaction(() => {
      const order = this.get(id)
      ensure(expectedAmount === order.amount, 409, '订单金额变化，请刷新后重试')
      if (order.paid_by === user.id) return { id }
      ensure(order.state === 1, 409, '订单已付款或已取消')
      if (order.invited_payer) ensure(order.invited_payer === user.id && this.accounts.bound(order.owner_id, user.id), 403, '仅指定且仍绑定的亲友可代付')
      else this.owner(user, order)
      this.db.run('UPDATE orders SET state=2,paid_by=?,paid_at=? WHERE id=? AND state=1', user.id, Date.now(), id)
      return { id }
    })
  }
  merchantList(user: User) {
    ensure(user.role === 'merchant', 403, '需要商家权限')
    return this.db.all<Order>('SELECT * FROM orders WHERE state=2 ORDER BY created').map(o => this.present(o, user))
  }
  ship(user: User, id: string) {
    ensure(user.role === 'merchant', 403, '只有商家可以发货')
    return this.db.transaction(() => {
      const order = this.get(id)
      ensure(order.state === 2, 409, '订单不在待发货状态')
      this.db.run('UPDATE orders SET state=3,shipped_at=? WHERE id=?', Date.now(), id)
      return { id }
    })
  }
  remind(user: User, id: string) {
    const order = this.get(id); this.owner(user, order)
    ensure(order.state === 2, 409, '订单不在待发货状态')
    return { id } // Reminder never changes the shipment state.
  }
  receive(user: User, id: string) {
    return this.db.transaction(() => {
      const order = this.get(id)
      ensure(user.id === order.owner_id || this.proxyReceipt(user, order), 403, '仅下单人或代付订单中仍绑定的代收人可收货')
      ensure(order.state === 3, 409, '订单尚未发货或已确认收货')
      this.db.run('UPDATE orders SET state=4,received_by=?,received_at=? WHERE id=? AND state=3', user.id, Date.now(), id)
      return { id }
    })
  }
  evaluate(user: User, id: string, score: number, content: string) {
    return this.db.transaction(() => {
      const order = this.get(id); this.owner(user, order)
      ensure(order.state === 4, 409, '订单未收货或已评价')
      this.db.run('INSERT INTO evaluations VALUES(?,?,?,?)', id, score, content, Date.now())
      this.db.run('UPDATE orders SET state=5 WHERE id=?', id)
      return { id }
    })
  }
}
