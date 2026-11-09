import { randomUUID } from 'node:crypto'
import { Database } from './database.ts'
import type { Clock } from './clock.ts'
import { Accounts, type User } from './accounts.ts'
import { Catalog } from './catalog.ts'
import { AppError, ensure } from './errors.ts'
import { recordStockMovement } from './inventory.ts'
import type { Payments } from './payments.ts'
import type { AfterSales } from './after-sales.ts'
import { localAvatarPath } from './avatar.ts'

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
  source?: 'cart' | 'buy-now'
  requestKey: string
  expectedAmountCents: number
  addressId: string
  goods: { skuId: string; count: number }[]
}
interface CancelRequest {
  id: string
  order_id: string
  sequence: number
  requested_by: string
  payment_id: string
  state: 'pending' | 'withdrawn' | 'approved' | 'rejected-shipped' | 'auto-approved'
  created: number
  deadline_at: number
  resolved_at: number | null
  resolved_by: string | null
  reject_reason: string | null
  refund_id: string | null
}
interface CancelReceipt {
  id: string
  orderId: string
  cancelRequestId: string
  action: 'request' | 'withdraw' | 'approve' | 'reject-and-ship' | 'auto-approve'
  appliedState: CancelRequest['state']
  appliedAt: number
  refundId: string | null
}
export class Orders {
  db: Database
  accounts: Accounts
  catalog: Catalog
  mockPayments: boolean
  private lastExpirationReadCheck = Number.NEGATIVE_INFINITY
  private nextExpirationReadCheck = Number.NEGATIVE_INFINITY
  readonly clock: Clock
  private payments?: Payments
  private afterSales?: AfterSales
  constructor(db: Database, accounts: Accounts, catalog: Catalog, mockPayments: boolean, clock: Clock = accounts.clock) {
    this.db = db
    this.accounts = accounts
    this.catalog = catalog
    this.mockPayments = mockPayments
    this.clock = clock
  }
  attachPayments(payments: Payments) { this.payments = payments }
  attachAfterSales(afterSales: AfterSales) { this.afterSales = afterSales }
  private get(id: string, reason?: string): Order {
    const order = this.db.one<Order>('SELECT * FROM orders WHERE id=?', id)
    if (!order) throw new AppError(404, '订单不存在', reason)
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
    if (user.id === order.owner_id || user.id === order.paid_by ||
      this.db.one('SELECT id FROM payments WHERE order_id=? AND payer_id=? LIMIT 1', order.id, user.id)) {
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
    if (this.payments?.hasPending(order.id)) return false
    if (order.invited_payer) {
      return order.invited_payer === user.id && this.accounts.bound(order.owner_id, user.id)
    }
    return order.owner_id === user.id
  }
  private cancelFields(order: Order, user: User, merchantShipment: boolean, paymentOnly: boolean) {
    const serverNow = this.clock.now()
    const disabled = { cancelRequest: null, canRequestCancel: false, canWithdrawCancel: false, canResolveCancel: false,
      canShip: false, cancelRequestNotice: '', cancelConfirmation: null, serverNow }
    if (paymentOnly) return disabled
    const request = this.db.one<CancelRequest>('SELECT * FROM order_cancel_requests WHERE order_id=? ORDER BY sequence DESC LIMIT 1', order.id)
    const pending = request?.state === 'pending'
    const effective = order.state === 2 ? this.payments?.effectivePaymentId(order.id) : undefined
    const owner = order.owner_id === user.id
    const merchant = merchantShipment && user.role === 'merchant'
    const actionable = pending && serverNow < request.deadline_at && order.state === 2
    const canRequestCancel = owner && order.state === 2 && !pending && Boolean(effective)
    let cancelRequestNotice = ''
    if (request) {
      if (pending) cancelRequestNotice = serverNow >= request.deadline_at ? '已到自动处理时间，正在处理' :
        (merchant ? '买家申请取消' : '取消申请审核中') + '；商家将在72小时内处理，超时自动同意'
      else if (request.state === 'withdrawn') cancelRequestNotice = '已撤回取消申请'
      else if (request.state === 'approved') cancelRequestNotice = '商家已同意取消申请'
      else if (request.state === 'auto-approved') cancelRequestNotice = '商家超时未处理，系统已自动同意'
      else cancelRequestNotice = '商家拒绝取消申请：' + request.reject_reason + '。如有问题请联系客服'
    }
    const destination = this.paymentMode(order) === 'family' ? '亲友 ' + this.account(order.paid_by) + ' 的付款账户' : '付款账户'
    return { cancelRequest: request ? { id: request.id, sequence: request.sequence, state: request.state, createdAt: request.created,
      deadlineAt: request.deadline_at, resolvedAt: request.resolved_at, rejectReason: request.reject_reason, refundId: request.refund_id } : null,
      canRequestCancel, canWithdrawCancel: owner && Boolean(actionable), canResolveCancel: merchant && Boolean(actionable),
      canShip: merchant && order.state === 2 && !pending && Boolean(effective), cancelRequestNotice,
      cancelConfirmation: canRequestCancel ? { amountCents: order.amount, payerAccount: this.account(order.paid_by), paymentMode: this.paymentMode(order),
        message: '取消申请提交后，商家同意即不再发货，¥' + (order.amount / 100).toFixed(2) + '将原路退回' + destination + '。确定申请取消吗？' } : null, serverNow }
  }
  private present(order: Order, user: User, merchantShipment = false) {
    const isOrderOwner = order.owner_id === user.id
    const items = this.items(order.id)
    const evaluation = this.db.one<{ score: number; content: string; created: number }>('SELECT * FROM evaluations WHERE order_id=?', order.id)
    const paymentFields = this.payments?.orderFields(order, user)
    const paymentOnly = !isOrderOwner && user.id !== order.paid_by &&
      !!this.db.one('SELECT id FROM payments WHERE order_id=? AND payer_id=? LIMIT 1', order.id, user.id)
    const cancelFields = this.cancelFields(order, user, merchantShipment, paymentOnly)
    const afterSaleFields = this.afterSales?.orderFields(order.id, user)
    if (paymentOnly) return { id: order.id, orderState: order.state, paymentMode: this.paymentMode(order), skus: [], ...paymentFields, ...cancelFields }
    return {
      id: order.id, orderState: order.state, ownerAccount: this.account(order.owner_id),
      payerAccount: this.account(order.paid_by), invitedPayerAccount: this.account(order.invited_payer), receivedByAccount: this.account(order.received_by),
      paymentMode: this.paymentMode(order),
      receivedAt: order.received_at, serverManaged: true,
      canPay: paymentFields?.canPay ?? this.canPay(user, order),
      canReceive: order.state === ORDER_STATE.AWAITING_RECEIPT && (isOrderOwner || this.canConfirmFamilyReceipt(user, order)),
      canEvaluate: isOrderOwner && order.state === ORDER_STATE.AWAITING_REVIEW,
      canInvitePayer: isOrderOwner && order.state === ORDER_STATE.AWAITING_PAYMENT,
      countdown: paymentFields?.countdown ?? Math.max(0, Math.floor((order.expires - this.clock.now()) / 1000)),
      createTime: new Date(order.created).toISOString(), payLatestTime: new Date(order.expires).toISOString(),
      payMoney: order.amount / 100, totalMoney: order.amount / 100, postFee: 0, payChannel: 1, payType: 1,
      totalNum: items.reduce((sum, item) => sum + item.count, 0),
      skus: items.map(item => ({ id: item.sku_id, spuId: item.product_id, name: item.name,
        image: localAvatarPath(item.picture) ? this.catalog.publicUrl + localAvatarPath(item.picture) : item.picture,
        attrsText: item.spec, properties: [{ propertyMainName: '规格', propertyValueName: item.spec }],
        quantity: item.count, realPay: item.price / 100, curPrice: item.price / 100,
        afterSaleRemaining: afterSaleFields?.afterSaleRemaining.find(value => value.skuId === item.sku_id)?.count ?? 0 })),
      evaluation: evaluation ? { orderId: order.id, score: evaluation.score, content: evaluation.content, createdAt: evaluation.created } : null,
      ...(isOrderOwner || (merchantShipment && user.role === 'merchant') ? { address: JSON.parse(order.address) } : {}),
      ...(paymentFields ?? { paymentState: 'none', refunds: [], paymentNotice: '', needsAttention: false,
        canCancel: order.state === ORDER_STATE.AWAITING_PAYMENT && isOrderOwner }),
      ...cancelFields, ...afterSaleFields
    }
  }
  detail(user: User, id: string) {
    this.expireIfDue()
    const order = this.get(id)
    ensure(this.canRead(user, order), 403, '无权查看此订单')
    this.payments?.markViewed(order.id, user.id)
    return this.present(order, user)
  }
  private listFilter(user: User, state: number, family: boolean) {
    const stateFilter = state ? 'o.state=?' : '1=1'
    const values: (string | number)[] = state ? [state, user.id] : [user.id]
    if (!family) return { where: `${stateFilter} AND o.owner_id=?`, values }
    // 与 canRead 一致，把亲友可读范围直接交给数据库筛选。
    const bound = "EXISTS(SELECT 1 FROM relations r WHERE r.owner_id=o.owner_id AND r.friend_id=? AND r.status='accepted')"
    values.push(user.id, user.id, user.id, user.id, user.id, user.id)
    return { where: `${stateFilter} AND o.owner_id<>? AND (
      EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.payer_id=?) OR
      (o.state<>6 AND (o.paid_by=? OR o.received_by=? OR
      (o.state=1 AND o.invited_payer=? AND ${bound}) OR
      (o.state=3 AND o.paid_by IS NOT NULL AND o.paid_by<>o.owner_id AND ${bound}))))`, values }
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
  byRequest(user: User, requestKey: string) {
    this.expireIfDue()
    const order = this.db.one<Order>('SELECT * FROM orders WHERE owner_id=? AND request_key=?', user.id, requestKey)
    ensure(order, 404, '未找到本次提交的订单')
    return { id: order.id, orderState: order.state, expiresAt: order.expires }
  }
  preOrder(user: User, selection?: { skuId: string; count: number }) {
    this.expireIfDue()
    // 只预览购物车里已勾选的商品，不扣库存、不创建订单。
    const selectedSku = selection ? this.catalog.sku(selection.skuId) : undefined
    const cart = selection ? [] : this.catalog.cart(user)
    const excludedGoods = selectedSku && (selectedSku.status !== 'on' || selectedSku.enabled !== 1) ?
      [{ skuId: selectedSku.id, name: selectedSku.name, reason: selectedSku.status === 'off' ? '已下架' : '规格已停用' }] :
      cart.filter(item => !item.available).map(item => ({ skuId: item.skuId, name: item.name, reason: item.unavailableReason }))
    const selectedGoods = selectedSku ? [{ id: selectedSku.product_id, skuId: selectedSku.id, name: selectedSku.name,
      picture: selectedSku.picture, stock: selectedSku.stock, price: selectedSku.price / 100,
      attrsText: selectedSku.spec, count: selection!.count, selected: true }] :
      cart.filter(item => item.selected && item.available)
    const goods = selectedGoods.filter(item => !excludedGoods.some(excluded => excluded.skuId === item.skuId)).map(item => ({
      ...item,
      price: String(item.price),
      payPrice: String(item.price),
      totalPrice: String(Math.round(item.price * 100) * item.count / 100),
      totalPayPrice: String(Math.round(item.price * 100) * item.count / 100)
    }))
    // 先换算成整数“分”再合计，最后转成“元”供页面显示。
    const totalCents = goods.reduce((sum, item) => sum + Math.round(Number(item.price) * 100) * item.count, 0)
    const totalYuan = totalCents / 100
    const goodsCount = goods.reduce((sum, item) => sum + item.count, 0)
    return {
      goods,
      excludedGoods,
      userAddresses: this.accounts.addresses(user),
      summary: { discountPrice: 0, goodsCount, postFee: 0, totalPayPrice: totalYuan, totalPrice: totalYuan }
    }
  }
  create(user: User, data: CreateOrder) {
    ensure(Number.isSafeInteger(data.expectedAmountCents) && data.expectedAmountCents > 0, 400, '请提供整数分报价')
    this.expire()
    // 按规格编号排好再记录：同样的商品即使提交顺序不同，也算同一次下单。
    const normalizedRequestBody = JSON.stringify({
      source: data.source ?? 'cart',
      addressId: data.addressId,
      expectedAmountCents: data.expectedAmountCents,
      goods: [...data.goods].sort((left, right) => left.skuId.localeCompare(right.skuId))
    })
    // 查重、扣库存、保存订单和移除购物车商品必须一起成功；任何一步失败都回滚。
    return this.db.transaction(() => {
      // 第一步：同一个用户用同一个 requestKey 重试时，找回原订单。
      const existing = this.db.one<Order>('SELECT * FROM orders WHERE owner_id=? AND request_key=?', user.id, data.requestKey)
      if (existing) {
        const previous = JSON.parse(existing.request_body) as Omit<CreateOrder, 'requestKey'>
        const previousBody = JSON.stringify({ source: previous.source ?? 'cart', addressId: previous.addressId,
          expectedAmountCents: previous.expectedAmountCents, goods: previous.goods })
        ensure(previousBody === normalizedRequestBody, 409, '同一次下单不能修改来源、商品或地址，请重新结算')
        return { id: existing.id }
      }
      // 第二步：检查规格是否重复、地址是否属于下单人，价格从服务端商品资料取。
      const uniqueSkuIds = new Set(data.goods.map(item => item.skuId))
      ensure(uniqueSkuIds.size === data.goods.length, 400, '商品规格重复')
      const address = this.db.one<{ data: string }>('SELECT data FROM addresses WHERE id=? AND user_id=?', data.addressId, user.id)
      ensure(address, 400, '请选择自己的收货地址')
      const items = data.goods.map(item => ({ ...this.catalog.sku(item.skuId), count: item.count }))
      const unavailable = items.filter(item => item.status !== 'on' || item.enabled !== 1)
      if (unavailable.length) throw new AppError(409, '部分商品暂不可购买，请核对新的结算内容', 'PRODUCT_UNAVAILABLE', {
        goods: unavailable.map(item => ({ skuId: item.id, name: item.name, reason: item.status === 'off' ? '已下架' : '规格已停用' }))
      })
      const totalAmountCents = items.reduce((sum, item) => sum + item.price * item.count, 0)
      if (totalAmountCents !== data.expectedAmountCents) {
        throw new AppError(409, '商品价格有变化，已更新为最新价格，请确认后再提交', 'PRICE_CHANGED', {
          totalAmountCents, goods: items.map(item => ({ skuId: item.id, name: item.name, spec: item.spec,
            priceCents: item.price, count: item.count, subtotalCents: item.price * item.count }))
        })
      }
      this.reserveStock(items)
      const id = this.saveOrderAndItems(user, data.requestKey, normalizedRequestBody, address.data, items)
      for (const item of items) {
        recordStockMovement(this.db, { kind: 'reserve', skuId: item.id, delta: -item.count, orderId: id, actorId: user.id }, this.clock)
        if (data.source !== 'buy-now') this.db.run('DELETE FROM carts WHERE user_id=? AND sku_id=?', user.id, item.id)
      }
      return { id }
    })
  }
  // 这两个步骤只使用入口持有的事务，不提交、不另开事务。
  private reserveStock(items: CheckoutItem[]) {
    const shortages = items.filter(item => item.stock < item.count).map(item => ({ skuId: item.id,
      name: item.name, spec: item.spec, requiredCount: item.count, remainingCount: item.stock }))
    if (shortages.length > 0) throw new AppError(409, '库存不足：' + shortages.map(item => item.name + '（' + item.spec + '）').join('、'),
      'STOCK_SHORTAGE', { goods: shortages })
    for (const item of items) {
      const result = this.db.run('UPDATE skus SET stock=stock-? WHERE id=? AND stock>=?', item.count, item.id, item.count)
      ensure(result.changes === 1, 409, '商品刚刚售罄或剩余库存不足，请刷新')
    }
  }
  private saveOrderAndItems(user: User, requestKey: string, requestBody: string, address: string, items: CheckoutItem[]) {
    const id = randomUUID(), now = this.clock.now()
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
        { kind: 'expire', skuId: item.sku_id, delta: item.count, orderId: order.id }, this.clock)
    }
    this.db.run('UPDATE orders SET state=? WHERE id=? AND state=?', ORDER_STATE.CANCELLED, order.id, ORDER_STATE.AWAITING_PAYMENT)
  }
  expireIfDue(now = this.clock.now()) {
    if (now >= this.lastExpirationReadCheck && now < this.nextExpirationReadCheck) return
    this.expire(now)
    // 合并读请求不能跨过最近订单的付款截止；时钟回拨也必须重新检查。
    const next = this.db.one<{ expires: number }>(`SELECT expires FROM orders WHERE state=1
      AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.order_id=orders.id AND p.state='pending') ORDER BY expires LIMIT 1`)
    this.lastExpirationReadCheck = now
    this.nextExpirationReadCheck = Math.min(now + EXPIRATION_READ_INTERVAL_MS, next?.expires ?? Infinity)
  }
  expire(now = this.clock.now()) {
    const hasExpiredOrders = this.db.one('SELECT id FROM orders WHERE state=1 AND expires<=? LIMIT 1', now)
    if (!hasExpiredOrders) return
    this.db.transaction(() => {
      // 进入事务后再查一次，只处理此刻仍未付款且已超时的订单。
      const expiredOrders = this.db.all<Order>(`SELECT o.* FROM orders o WHERE o.state=1 AND o.expires<=?
        AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.state='pending')`, now)
      for (const order of expiredOrders) {
        this.cancelAndRestoreStock(order)
      }
    })
  }
  cancelActionReceipt(user: User, requestKey: string): CancelReceipt {
    const action = this.db.one<{ result: string }>('SELECT result FROM order_cancel_actions WHERE request_key=? AND actor_id=?', requestKey, user.id)
    if (!action) throw new AppError(404, '未找到本次取消操作', 'CANCEL_ACTION_NOT_FOUND')
    return JSON.parse(action.result) as CancelReceipt
  }
  private async cancelTransaction<Result>(action: (refundIds: string[]) => Result | AppError): Promise<Result> {
    const refundIds: string[] = []
    const result = this.db.transaction(() => action(refundIds))
    if (refundIds.length) await this.payments!.reconcile(this.clock.now(), { refundIds })
    if (result instanceof AppError) throw result
    return result
  }
  private autoApproveIfDue(request: CancelRequest | undefined, now: number, refundIds: string[]) {
    if (!request || request.state !== 'pending' || now < request.deadline_at) return false
    const body = JSON.stringify({ orderId: request.order_id, cancelRequestId: request.id, action: 'auto-approve' })
    this.approveCancel(request, null, 'auto-approve:' + request.id, body, now, refundIds)
    return true
  }
  private cancelDeadlineError() {
    return new AppError(409, '取消申请已超时自动同意，请刷新订单', 'CANCEL_REQUEST_EXPIRED')
  }
  async processDueCancelRequests(now = this.clock.now()) {
    let processed = 0
    const refundIds: string[] = []
    const failed: string[] = []
    const due = this.db.all<{ id: string; order_id: string }>("SELECT id,order_id FROM order_cancel_requests WHERE state='pending' AND deadline_at<=? ORDER BY deadline_at,id", now)
    for (const request of due) {
      try {
        if (this.db.transaction(() => this.autoApproveIfDue(this.getCancelRequest(request.order_id, request.id), now, refundIds))) processed++
      } catch { failed.push(request.id) }
    }
    if (refundIds.length) await this.payments!.reconcile(this.clock.now(), { refundIds })
    return { processed, failed }
  }
  private cancelOwner(user: User, order: Order) {
    if (user.id !== order.owner_id) throw new AppError(403, '只有下单人可以操作', 'CANCEL_OWNER_ONLY')
  }
  private pendingCancel(id: string) {
    return this.db.one<CancelRequest>("SELECT * FROM order_cancel_requests WHERE order_id=? AND state='pending'", id)
  }
  private replayCancelAction(user: User, requestKey: string, body: string): CancelReceipt | undefined {
    const existing = this.db.one<{ actor_id: string | null; request_body: string; result: string }>('SELECT actor_id,request_body,result FROM order_cancel_actions WHERE request_key=?', requestKey)
    if (!existing) return undefined
    if (existing.actor_id !== user.id || existing.request_body !== body) {
      throw new AppError(409, '同一请求号不能用于不同的取消操作', 'CANCEL_REQUEST_KEY_CONFLICT')
    }
    return JSON.parse(existing.result) as CancelReceipt
  }
  private writeCancelAction(request: CancelRequest, user: User | null, action: CancelReceipt['action'], requestKey: string, body: string, now: number): CancelReceipt {
    const result: CancelReceipt = { id: randomUUID(), orderId: request.order_id, cancelRequestId: request.id,
      action, appliedState: request.state, appliedAt: now, refundId: request.refund_id }
    this.db.run('INSERT INTO order_cancel_actions(id,order_id,cancel_request_id,actor_id,action,request_key,request_body,result,created) VALUES(?,?,?,?,?,?,?,?,?)',
      result.id, request.order_id, request.id, user?.id ?? null, action, requestKey, body, JSON.stringify(result), now)
    return result
  }
  requestCancel(user: User, id: string, requestKey: string) {
    return this.cancelTransaction((refundIds) => {
      const order = this.get(id, 'ORDER_NOT_FOUND')
      this.cancelOwner(user, order)
      const body = JSON.stringify({ orderId: id, action: 'request' })
      const existing = this.replayCancelAction(user, requestKey, body)
      if (existing) return existing
      if (order.state === 6) throw new AppError(409, '订单已取消，请查看退款详情', 'ORDER_ALREADY_CANCELLED')
      if (order.state >= 3) throw new AppError(409, '已发货，请联系售后', 'ORDER_ALREADY_SHIPPED')
      if (order.state !== 2) throw new AppError(409, '仅已付款待发货订单可以申请取消', 'CANCEL_NOT_AVAILABLE')
      const pending = this.pendingCancel(id)
      if (this.autoApproveIfDue(pending, this.clock.now(), refundIds)) return new AppError(409, '订单已取消，请查看退款详情', 'ORDER_ALREADY_CANCELLED')
      if (pending) throw new AppError(409, '取消申请审核中，请勿重复申请', 'CANCEL_REQUEST_PENDING')
      const paymentId = this.payments?.effectivePaymentId(id)
      if (!paymentId) throw new AppError(409, '付款记录异常，请联系客服', 'CANCEL_PAYMENT_INVALID')
      const now = this.clock.now()
      const sequence = this.db.one<{ next: number }>('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM order_cancel_requests WHERE order_id=?', id)!.next
      const requestId = randomUUID()
      this.db.run("INSERT INTO order_cancel_requests(id,order_id,sequence,requested_by,payment_id,state,created,deadline_at) VALUES(?,?,?,?,?,'pending',?,?)",
        requestId, id, sequence, user.id, paymentId, now, now + 72 * 3600_000)
      return this.writeCancelAction(this.db.one<CancelRequest>('SELECT * FROM order_cancel_requests WHERE id=?', requestId)!, user, 'request', requestKey, body, now)
    })
  }
  private getCancelRequest(orderId: string, requestId: string) {
    const request = this.db.one<CancelRequest>('SELECT * FROM order_cancel_requests WHERE id=? AND order_id=?', requestId, orderId)
    if (!request) throw new AppError(404, '取消申请不存在', 'CANCEL_REQUEST_NOT_FOUND')
    return request
  }
  private assertCancelPending(request: CancelRequest) {
    if (request.state === 'withdrawn') throw new AppError(409, '取消申请已撤回，请刷新订单', 'CANCEL_REQUEST_WITHDRAWN')
    if (request.state !== 'pending') throw new AppError(409, '取消申请已处理，请刷新订单', 'CANCEL_REQUEST_RESOLVED')
    ensure(this.get(request.order_id).state === 2, 409, '订单不在待发货状态')
  }
  withdrawCancel(user: User, id: string, requestId: string, requestKey: string) {
    return this.cancelTransaction((refundIds) => {
      this.cancelOwner(user, this.get(id, 'ORDER_NOT_FOUND'))
      const request = this.getCancelRequest(id, requestId)
      const body = JSON.stringify({ orderId: id, cancelRequestId: requestId, action: 'withdraw' })
      const existing = this.replayCancelAction(user, requestKey, body)
      if (existing) return existing
      const now = this.clock.now()
      if (this.autoApproveIfDue(request, now, refundIds)) return this.cancelDeadlineError()
      this.assertCancelPending(request)
      const changed = this.db.run("UPDATE order_cancel_requests SET state='withdrawn',resolved_at=?,resolved_by=? WHERE id=? AND state='pending'", now, user.id, requestId)
      ensure(changed.changes === 1, 409, '取消申请已处理，请刷新订单')
      return this.writeCancelAction(this.getCancelRequest(id, requestId), user, 'withdraw', requestKey, body, now)
    })
  }
  private approveCancel(request: CancelRequest, user: User | null, requestKey: string, body: string, now: number, refundIds: string[]) {
    this.assertCancelPending(request)
    if (!this.payments || this.payments.effectivePaymentId(request.order_id) !== request.payment_id) {
      throw new AppError(409, '付款记录异常，请联系客服', 'CANCEL_PAYMENT_INVALID')
    }
    const changed = this.db.run('UPDATE orders SET state=6 WHERE id=? AND state=2', request.order_id)
    ensure(changed.changes === 1, 409, '订单不在待发货状态')
    for (const item of this.items(request.order_id)) {
      const restored = this.db.run('UPDATE skus SET stock=stock+? WHERE id=?', item.count, item.sku_id)
      ensure(restored.changes === 1, 409, '库存释放失败')
      recordStockMovement(this.db, user ?
        { kind: 'cancel', skuId: item.sku_id, delta: item.count, orderId: request.order_id, actorId: user.id } :
        { kind: 'expire', skuId: item.sku_id, delta: item.count, orderId: request.order_id }, this.clock)
    }
    const refundId = this.payments.createOrderCancellationRefund(request.order_id, request.payment_id, now)
    const state = user ? 'approved' : 'auto-approved'
    const resolved = this.db.run("UPDATE order_cancel_requests SET state=?,resolved_at=?,resolved_by=?,refund_id=? WHERE id=? AND state='pending'",
      state, now, user?.id ?? null, refundId, request.id)
    ensure(resolved.changes === 1, 409, '取消申请已处理，请刷新订单')
    refundIds.push(refundId)
    return this.writeCancelAction(this.getCancelRequest(request.order_id, request.id), user, user ? 'approve' : 'auto-approve', requestKey, body, now)
  }
  resolveCancel(user: User, id: string, requestId: string, data: { requestKey: string; decision: 'approve' | 'reject-and-ship'; reason?: string }) {
    if (user.role !== 'merchant') throw new AppError(403, '需要商家权限', 'MERCHANT_REQUIRED')
    const reason = data.reason?.trim()
    if (data.decision === 'reject-and-ship' && !reason) throw new AppError(400, '请填写拒绝原因', 'CANCEL_REASON_REQUIRED')
    if (reason && Array.from(reason).length > 200) throw new AppError(400, '拒绝原因最多填写200字', 'CANCEL_REASON_TOO_LONG')
    return this.cancelTransaction((refundIds) => {
      this.get(id, 'ORDER_NOT_FOUND')
      const request = this.getCancelRequest(id, requestId)
      const body = JSON.stringify({ orderId: id, cancelRequestId: requestId, action: data.decision, ...(data.decision === 'reject-and-ship' ? { reason } : {}) })
      const existing = this.replayCancelAction(user, data.requestKey, body)
      if (existing) return existing
      const now = this.clock.now()
      if (this.autoApproveIfDue(request, now, refundIds)) return this.cancelDeadlineError()
      if (data.decision === 'approve') return this.approveCancel(request, user, data.requestKey, body, now, refundIds)
      this.assertCancelPending(request)
      if (this.payments?.effectivePaymentId(id) !== request.payment_id) throw new AppError(409, '付款记录异常，请联系客服', 'CANCEL_PAYMENT_INVALID')
      const shipped = this.db.run('UPDATE orders SET state=3,shipped_at=? WHERE id=? AND state=2', now, id)
      ensure(shipped.changes === 1, 409, '订单不在待发货状态')
      const resolved = this.db.run("UPDATE order_cancel_requests SET state='rejected-shipped',resolved_at=?,resolved_by=?,reject_reason=? WHERE id=? AND state='pending'", now, user.id, reason!, requestId)
      ensure(resolved.changes === 1, 409, '取消申请已处理，请刷新订单')
      return this.writeCancelAction(this.getCancelRequest(id, requestId), user, 'reject-and-ship', data.requestKey, body, now)
    })
  }
  cancel(user: User, id: string) {
    if (this.payments?.hasPending(id)) {
      return this.payments.cancelPending(user, id).then(() => this.present(this.get(id), user))
    }
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
      ensure(!this.payments?.hasPending(id), 409, '支付确认中不能更改付款人')
      ensure(!friendId || this.accounts.bound(user.id, friendId), 403, '只能邀请已确认绑定的亲友代付')
      this.db.run('UPDATE orders SET invited_payer=? WHERE id=?', friendId, id)
      return { id }
    })
  }
  pay(user: User, id: string, expectedAmount: number) {
    if (this.payments) return this.payments.mockPay(user, id, expectedAmount)
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
      this.db.run('UPDATE orders SET state=2,paid_by=?,paid_at=? WHERE id=? AND state=1', user.id, this.clock.now(), id)
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
    return this.cancelTransaction((refundIds) => {
      const order = this.get(id)
      if (order.state === 6) throw new AppError(409, '买家已取消，不能发货', 'CANCELLED_ORDER_BLOCKS_SHIPMENT')
      const pending = this.pendingCancel(id)
      if (this.autoApproveIfDue(pending, this.clock.now(), refundIds)) return new AppError(409, '买家已取消，不能发货', 'CANCELLED_ORDER_BLOCKS_SHIPMENT')
      if (pending) throw new AppError(409, '买家已申请取消，请先处理取消申请', 'CANCEL_REQUEST_BLOCKS_SHIPMENT')
      ensure(order.state === ORDER_STATE.AWAITING_SHIPMENT, 409, '订单不在待发货状态')
      if (this.payments) ensure(this.payments.effectivePaymentId(id), 409, '订单没有有效支付，不能发货')
      const shipped = this.db.run('UPDATE orders SET state=3,shipped_at=? WHERE id=? AND state=2', this.clock.now(), id)
      ensure(shipped.changes === 1, 409, '订单不在待发货状态')
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
      this.db.run('UPDATE orders SET state=4,received_by=?,received_at=? WHERE id=? AND state=3', user.id, this.clock.now(), id)
      return this.present(this.get(id), user)
    })
  }
  evaluate(user: User, id: string, score: number, content: string) {
    return this.db.transaction(() => {
      const order = this.get(id)
      this.owner(user, order)
      ensure(order.state === ORDER_STATE.AWAITING_REVIEW, 409, '订单未收货或已评价')
      this.db.run('INSERT INTO evaluations VALUES(?,?,?,?)', id, score, content, this.clock.now())
      this.db.run('UPDATE orders SET state=5 WHERE id=?', id)
      return { id }
    })
  }
}
