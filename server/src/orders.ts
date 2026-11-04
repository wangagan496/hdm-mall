import { randomUUID } from 'node:crypto'
import { Database } from './database.ts'
import { Accounts, type User } from './accounts.ts'
import { Catalog } from './catalog.ts'
import { ensure } from './errors.ts'
import { recordStockMovement } from './inventory.ts'

// 与手机端 models/OrderState.ets 的状态码保持一致；数据库仍保存原来的数字。
const ORDER_STATE = {
  AWAITING_PAYMENT: 1,
  AWAITING_SHIPMENT: 2,
  AWAITING_RECEIPT: 3,
  AWAITING_REVIEW: 4,
  COMPLETED: 5,
  CANCELLED: 6
} as const
const PAYMENT_WINDOW_MS = 15 * 60_000
const EXPIRATION_READ_INTERVAL_MS = 1_000

interface Order {
  id: string
  owner_id: string
  state: number
  amount: number // 服务端金额统一以“分”保存和计算。
  address: string // 下单时的地址副本，后续修改地址簿不会改变它。
  request_key: string
  request_body: string // 第一次下单的内容，用于核对重试请求。
  created: number
  expires: number
  invited_payer: string | null
  paid_by: string | null
  paid_at: number | null
  received_by: string | null
  received_at: number | null
  shipped_at: number | null
}
interface Item {
  order_id: string
  sku_id: string
  product_id: string
  name: string
  picture: string
  spec: string
  price: number
  count: number
}
type CheckoutItem = ReturnType<Catalog['sku']> & { count: number }
export interface CreateOrder {
  requestKey: string
  addressId: string
  goods: { skuId: string; count: number }[]
}
export class Orders {
  db: Database
  accounts: Accounts
  catalog: Catalog
  mockPayments: boolean
  private lastExpirationReadCheck = 0
  constructor(db: Database, accounts: Accounts, catalog: Catalog, mockPayments: boolean) {
    this.db = db
    this.accounts = accounts
    this.catalog = catalog
    this.mockPayments = mockPayments
  }
  private get(id: string): Order {
    const order = this.db.one<Order>('SELECT * FROM orders WHERE id=?', id)
    ensure(order, 404, '订单不存在')
    return order
  }
  private items(id: string) {
    return this.db.all<Item>('SELECT * FROM order_items WHERE order_id=?', id)
  }
  private owner(user: User, order: Order) {
    ensure(user.id === order.owner_id, 403, '只有下单人可以操作')
  }
  private canConfirmFamilyReceipt(user: User, order: Order) {
    // 亲友代付的订单允许仍与下单人绑定的亲友代收，不限于实际付款人。
    const paidBySomeoneElse = Boolean(order.paid_by) && order.paid_by !== order.owner_id
    if (!paidBySomeoneElse) {
      return false
    }
    const stillBoundToOrderOwner = this.accounts.bound(order.owner_id, user.id)
    return stillBoundToOrderOwner
  }
  private canRead(user: User, order: Order) {
    if (user.id === order.owner_id || user.id === order.paid_by) {
      return true
    }
    // 待付款时，只有受邀且绑定关系仍有效的亲友可以查看。
    if (order.state === ORDER_STATE.AWAITING_PAYMENT && user.id === order.invited_payer &&
      this.accounts.bound(order.owner_id, user.id)) {
      return true
    }
    if (order.state === ORDER_STATE.AWAITING_RECEIPT && this.canConfirmFamilyReceipt(user, order)) {
      return true
    }
    return user.id === order.received_by
  }
  private account(id: string | null) {
    if (!id) return ''
    return this.db.one<{ account: string }>('SELECT account FROM users WHERE id=?', id)?.account ?? ''
  }

  // 已付款时按实际付款人判断；未付款时按是否邀请了亲友判断。
  private paymentMode(order: Order): 'self' | 'family' {
    if (order.paid_by) {
      return order.paid_by === order.owner_id ? 'self' : 'family'
    }
    return order.invited_payer ? 'family' : 'self'
  }

  private canPay(user: User, order: Order): boolean {
    if (order.state !== ORDER_STATE.AWAITING_PAYMENT) return false
    if (order.invited_payer) {
      return order.invited_payer === user.id && this.accounts.bound(order.owner_id, user.id)
    }
    return order.owner_id === user.id
  }
  private present(order: Order, user: User, merchantShipment = false) {
    const isOrderOwner = order.owner_id === user.id
    const items = this.items(order.id)
    const evaluation = this.db.one<{ score: number; content: string; created: number }>('SELECT * FROM evaluations WHERE order_id=?', order.id)
    return {
      id: order.id, orderState: order.state, ownerAccount: this.account(order.owner_id),
      payerAccount: this.account(order.paid_by), invitedPayerAccount: this.account(order.invited_payer), receivedByAccount: this.account(order.received_by),
      paymentMode: this.paymentMode(order),
      receivedAt: order.received_at, serverManaged: true,
      canPay: this.canPay(user, order),
      canReceive: order.state === ORDER_STATE.AWAITING_RECEIPT && (isOrderOwner || this.canConfirmFamilyReceipt(user, order)),
      canEvaluate: isOrderOwner && order.state === ORDER_STATE.AWAITING_REVIEW,
      canInvitePayer: isOrderOwner && order.state === ORDER_STATE.AWAITING_PAYMENT,
      countdown: Math.max(0, Math.floor((order.expires - Date.now()) / 1000)),
      createTime: new Date(order.created).toISOString(), payLatestTime: new Date(order.expires).toISOString(),
      payMoney: order.amount / 100, totalMoney: order.amount / 100, postFee: 0, payChannel: 1, payType: 1,
      totalNum: items.reduce((sum, item) => sum + item.count, 0),
      skus: items.map(item => ({ id: item.sku_id, spuId: item.product_id, name: item.name, image: item.picture,
        attrsText: item.spec, properties: [{ propertyMainName: '规格', propertyValueName: item.spec }],
        quantity: item.count, realPay: item.price / 100, curPrice: item.price / 100 })),
      evaluation: evaluation ? { orderId: order.id, score: evaluation.score, content: evaluation.content, createdAt: evaluation.created } : null,
      ...(isOrderOwner || (merchantShipment && user.role === 'merchant') ? { address: JSON.parse(order.address) } : {})
    }
  }
  detail(user: User, id: string) {
    this.expireIfDue()
    const order = this.get(id)
    ensure(this.canRead(user, order), 403, '无权查看此订单')
    return this.present(order, user)
  }
  private listFilter(user: User, state: number, family: boolean) {
    const stateFilter = state ? 'o.state=?' : 'o.state<>?'
    const values: (string | number)[] = [state || ORDER_STATE.CANCELLED, user.id]
    if (!family) return { where: `${stateFilter} AND o.owner_id=?`, values }
    // 与 canRead 一致，把亲友可读范围直接交给数据库筛选。
    const bound = "EXISTS(SELECT 1 FROM relations r WHERE r.owner_id=o.owner_id AND r.friend_id=? AND r.status='accepted')"
    values.push(user.id, user.id, user.id, user.id, user.id)
    return { where: `${stateFilter} AND o.owner_id<>? AND (o.paid_by=? OR o.received_by=? OR
      (o.state=1 AND o.invited_payer=? AND ${bound}) OR
      (o.state=3 AND o.paid_by IS NOT NULL AND o.paid_by<>o.owner_id AND ${bound}))`, values }
  }
  list(user: User, state = 0, family = false) {
    this.expireIfDue()
    const filter = this.listFilter(user, state, family)
    return this.db.all<Order>(`SELECT o.* FROM orders o WHERE ${filter.where} ORDER BY o.created DESC,o.id`, ...filter.values)
      .map(order => this.present(order, user))
  }
  listPage(user: User, state: number, page: number, pageSize: number) {
    this.expireIfDue()
    const filter = this.listFilter(user, state, false)
    return this.queryPage(user, filter, page, pageSize)
  }
  familyPage(user: User, page: number, pageSize: number) {
    this.expireIfDue()
    return this.queryPage(user, this.listFilter(user, 0, true), page, pageSize)
  }
  private queryPage(user: User, filter: { where: string; values: (string | number)[] }, page: number, pageSize: number, merchantShipment = false) {
    const counts = this.db.one<{ count: number }>(`SELECT COUNT(*) AS count FROM orders o WHERE ${filter.where}`, ...filter.values)!.count
    const offset = (page - 1) * pageSize
    const direction = merchantShipment ? 'ASC' : 'DESC'
    const rows = offset >= counts ? [] : this.db.all<Order>(`SELECT o.* FROM orders o WHERE ${filter.where} ORDER BY o.created ${direction},o.id LIMIT ? OFFSET ?`,
      ...filter.values, pageSize, offset)
    return { items: rows.map(order => this.present(order, user, merchantShipment)), counts, pages: Math.ceil(counts / pageSize), page, pageSize }
  }
  preOrder(user: User) {
    this.expireIfDue()
    // 只预览购物车里已勾选的商品，不扣库存、不创建订单。
    const selectedGoods = this.catalog.cart(user).filter(item => item.selected)
    const goods = selectedGoods.map(item => ({
      ...item,
      price: String(item.price),
      payPrice: String(item.price),
      totalPrice: String(item.price * item.count),
      totalPayPrice: String(item.price * item.count)
    }))
    // 先换算成整数“分”再合计，最后转成“元”供页面显示。
    const totalCents = goods.reduce((sum, item) => sum + Math.round(Number(item.price) * 100) * item.count, 0)
    const totalYuan = totalCents / 100
    const goodsCount = goods.reduce((sum, item) => sum + item.count, 0)
    return {
      goods,
      userAddresses: this.accounts.addresses(user),
      summary: { discountPrice: 0, goodsCount, postFee: 0, totalPayPrice: totalYuan, totalPrice: totalYuan }
    }
  }
  create(user: User, data: CreateOrder) {
    this.expire()
    // 按规格编号排好再记录：同样的商品即使提交顺序不同，也算同一次下单。
    const normalizedRequestBody = JSON.stringify({
      addressId: data.addressId,
      goods: [...data.goods].sort((left, right) => left.skuId.localeCompare(right.skuId))
    })
    // 查重、扣库存、保存订单和移除购物车商品必须一起成功；任何一步失败都回滚。
    return this.db.transaction(() => {
      // 第一步：同一个用户用同一个 requestKey 重试时，找回原订单。
      const existing = this.db.one<Order>('SELECT * FROM orders WHERE owner_id=? AND request_key=?', user.id, data.requestKey)
      if (existing) {
        ensure(existing.request_body === normalizedRequestBody, 409, '同一次下单不能修改商品或地址，请重新结算')
        return { id: existing.id }
      }
      // 第二步：检查规格是否重复、地址是否属于下单人，价格从服务端商品资料取。
      const uniqueSkuIds = new Set(data.goods.map(item => item.skuId))
      ensure(uniqueSkuIds.size === data.goods.length, 400, '商品规格重复')
      const address = this.db.one<{ data: string }>('SELECT data FROM addresses WHERE id=? AND user_id=?', data.addressId, user.id)
      ensure(address, 400, '请选择自己的收货地址')
      const items = data.goods.map(item => ({ ...this.catalog.sku(item.skuId), count: item.count }))
      this.reserveStock(items)
      const id = this.saveOrderAndItems(user, data.requestKey, normalizedRequestBody, address.data, items)
      for (const item of items) {
        recordStockMovement(this.db, { kind: 'reserve', skuId: item.id, delta: -item.count, orderId: id, actorId: user.id })
        this.db.run('DELETE FROM carts WHERE user_id=? AND sku_id=?', user.id, item.id)
      }
      return { id }
    })
  }
  // 这两个步骤只使用入口持有的事务，不提交、不另开事务。
  private reserveStock(items: CheckoutItem[]) {
    for (const item of items) {
      const result = this.db.run('UPDATE skus SET stock=stock-? WHERE id=? AND stock>=?', item.count, item.id, item.count)
      ensure(result.changes === 1, 409, '商品刚刚售罄或剩余库存不足，请刷新')
    }
  }
  private saveOrderAndItems(user: User, requestKey: string, requestBody: string, address: string, items: CheckoutItem[]) {
    const id = randomUUID(), now = Date.now()
    const amount = items.reduce((sum, item) => sum + item.price * item.count, 0)
    this.db.run('INSERT INTO orders(id,owner_id,state,amount,address,request_key,request_body,created,expires) VALUES(?,?,?,?,?,?,?,?,?)',
      id, user.id, ORDER_STATE.AWAITING_PAYMENT, amount, address, requestKey, requestBody, now, now + PAYMENT_WINDOW_MS)
    for (const item of items) {
      this.db.run('INSERT INTO order_items VALUES(?,?,?,?,?,?,?,?)', id, item.id, item.product_id, item.name, item.picture, item.spec, item.price, item.count)
    }
    return id
  }
  // 调用方已在事务中确认订单待付款；归还库存与改为已取消不能分开提交。
  private cancelAndRestoreStock(order: Order, actor?: User) {
    for (const item of this.items(order.id)) {
      this.db.run('UPDATE skus SET stock=stock+? WHERE id=?', item.count, item.sku_id)
      recordStockMovement(this.db, actor ?
        { kind: 'cancel', skuId: item.sku_id, delta: item.count, orderId: order.id, actorId: actor.id } :
        { kind: 'expire', skuId: item.sku_id, delta: item.count, orderId: order.id })
    }
    this.db.run('UPDATE orders SET state=? WHERE id=? AND state=?', ORDER_STATE.CANCELLED, order.id, ORDER_STATE.AWAITING_PAYMENT)
  }
  expireIfDue(now = Date.now()) {
    if (now - this.lastExpirationReadCheck < EXPIRATION_READ_INTERVAL_MS) return
    this.expire(now)
    this.lastExpirationReadCheck = now
  }
  expire(now = Date.now()) {
    const hasExpiredOrders = this.db.one('SELECT id FROM orders WHERE state=1 AND expires<=? LIMIT 1', now)
    if (!hasExpiredOrders) return
    this.db.transaction(() => {
      // 进入事务后再查一次，只处理此刻仍未付款且已超时的订单。
      const expiredOrders = this.db.all<Order>('SELECT * FROM orders WHERE state=1 AND expires<=?', now)
      for (const order of expiredOrders) {
        this.cancelAndRestoreStock(order)
      }
    })
  }
  cancel(user: User, id: string) {
    return this.db.transaction(() => {
      const order = this.get(id)
      this.owner(user, order)
      // 重复取消直接返回，不能再归还一次库存。
      if (order.state === ORDER_STATE.CANCELLED) return this.present(order, user)
      ensure(order.state === ORDER_STATE.AWAITING_PAYMENT, 409, '只有未付款订单可以取消')
      this.cancelAndRestoreStock(order, user)
      return this.present(this.get(id), user)
    })
  }
  invitePayer(user: User, id: string, friendId: string | null) {
    this.expire()
    return this.db.transaction(() => {
      const order = this.get(id)
      this.owner(user, order)
      ensure(order.state === ORDER_STATE.AWAITING_PAYMENT, 409, '只能为待付款订单选择付款方式')
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
      // 手机提交的金额只用于核对，实际应付金额始终取订单记录中的“分”。
      ensure(expectedAmount === order.amount, 409, '订单金额变化，请刷新后重试')
      if (order.paid_by === user.id) return { id }
      ensure(order.state === ORDER_STATE.AWAITING_PAYMENT, 409, '订单已付款或已取消')
      if (order.invited_payer) {
        ensure(order.invited_payer === user.id && this.accounts.bound(order.owner_id, user.id), 403, '仅指定且仍绑定的亲友可代付')
      } else {
        this.owner(user, order)
      }
      this.db.run('UPDATE orders SET state=2,paid_by=?,paid_at=? WHERE id=? AND state=1', user.id, Date.now(), id)
      return { id }
    })
  }
  merchantList(user: User) {
    ensure(user.role === 'merchant', 403, '需要商家权限')
    const ordersToShip = this.db.all<Order>('SELECT * FROM orders WHERE state=2 ORDER BY created')
    return ordersToShip.map(order => this.present(order, user, true))
  }
  merchantPage(user: User, page: number, pageSize: number) {
    ensure(user.role === 'merchant', 403, '需要商家权限')
    return this.queryPage(user, { where: 'o.state=?', values: [ORDER_STATE.AWAITING_SHIPMENT] }, page, pageSize, true)
  }
  ship(user: User, id: string) {
    ensure(user.role === 'merchant', 403, '只有商家可以发货')
    return this.db.transaction(() => {
      const order = this.get(id)
      ensure(order.state === ORDER_STATE.AWAITING_SHIPMENT, 409, '订单不在待发货状态')
      this.db.run('UPDATE orders SET state=3,shipped_at=? WHERE id=?', Date.now(), id)
      return { id }
    })
  }
  remind(user: User, id: string) {
    const order = this.get(id)
    this.owner(user, order)
    ensure(order.state === ORDER_STATE.AWAITING_SHIPMENT, 409, '订单不在待发货状态')
    return this.present(order, user) // 催发货只确认请求，不把订单改成已发货。
  }
  receive(user: User, id: string) {
    return this.db.transaction(() => {
      const order = this.get(id)
      ensure(user.id === order.owner_id || this.canConfirmFamilyReceipt(user, order), 403, '仅下单人或代付订单中仍绑定的代收人可收货')
      ensure(order.state === ORDER_STATE.AWAITING_RECEIPT, 409, '订单尚未发货或已确认收货')
      this.db.run('UPDATE orders SET state=4,received_by=?,received_at=? WHERE id=? AND state=3', user.id, Date.now(), id)
      return this.present(this.get(id), user)
    })
  }
  evaluate(user: User, id: string, score: number, content: string) {
    return this.db.transaction(() => {
      const order = this.get(id)
      this.owner(user, order)
      ensure(order.state === ORDER_STATE.AWAITING_REVIEW, 409, '订单未收货或已评价')
      this.db.run('INSERT INTO evaluations VALUES(?,?,?,?)', id, score, content, Date.now())
      this.db.run('UPDATE orders SET state=5 WHERE id=?', id)
      return { id }
    })
  }
}
