import { AfterSale } from './AfterSaleModels'
import { InvoiceInput, InvoiceDetail } from './InvoiceModels'
import { ReturnPolicyFields } from './ReturnPolicy'

export interface HDMGoodsItem extends ReturnPolicyFields {
  id: string
  name: string
  desc: string
  price: string | number
  picture: ResourceStr
  orderNum: number
  originalPrice?: string | number
}

// 收藏和足迹只保存可序列化的商品快照，不持久化 Resource 等运行时对象。
export interface LocalGoodsItem {
  id: string
  name: string
  desc: string
  price: string | number
  picture: string
  orderNum: number
  originalPrice?: string | number
  updatedAt: number
}

export interface CategoryItem {
  children?: CategoryItemChild[]
  goods?: HDMGoodsItem[]
  id: string
  name: string
  picture: ResourceStr
}

export interface CategoryItemChild {
  id: string
  name: string
  picture: ResourceStr
  goods?: HDMGoodsItem[]
}

export interface GoodsItems {
  counts: number
  items: HDMGoodsItem[]
  page: number
  pages: number
  pageSize: number
}

export interface HDMUser {
  status?: string
  deletionDueAt?: number
  id?: string
  role?: string
  birthday?: string
  cityCode?: string
  gender?: string
  mobile?: string
  profession?: string
  provinceCode?: string
  countyCode?: string
  fullLocation?: string
  token: string
  nickname: string
  avatar: string
  account: string
}

export interface FamilyRelation {
  id: string
  status: string
  ownerId: string
  friendId: string
  ownerAccount: string
  friendAccount: string
}

export interface FamilyRelationPage {
  items: FamilyRelation[]
  counts: number
  page: number
  pages: number
  pageSize: number
}

export interface CartGoods extends ReturnPolicyFields {
  available?: boolean
  unavailableReason?: string
  count: number
  id: string
  name: string
  picture: string
  price: number
  selected: boolean
  skuId: string
  stock: number
  attrsText: string
}

@Observed
export class CartGoodsModel implements CartGoods {
  @Track returnPolicy: string = 'standard'
  @Track returnPolicyReason: string = ''
  @Track returnPolicyNote: string = ''
  @Track available: boolean = true
  @Track unavailableReason: string = ''
  // @Track 让 @ObjectLink 仅在实际变更的属性上触发最小化刷新
  @Track count: number = 0
  @Track id: string = ''
  @Track name: string = ''
  @Track picture: string = ''
  @Track price: number = 0
  @Track selected: boolean = false
  @Track skuId: string = ''
  @Track stock: number = 0
  @Track attrsText: string = ''

  constructor(model: CartGoods) {
    this.returnPolicy = model.returnPolicy || 'standard'
    this.returnPolicyReason = model.returnPolicyReason || ''
    this.returnPolicyNote = model.returnPolicyNote || ''
    this.available = model.available !== false
    this.unavailableReason = model.unavailableReason || ''
    this.count = model.count
    this.id = model.id
    this.name = model.name
    this.picture = model.picture
    this.price = model.price
    this.selected = model.selected && this.available
    this.skuId = model.skuId
    this.stock = model.stock
    this.attrsText = model.attrsText
  }
}

export interface AddCartParams {
  skuId: string
  count: number
  requestKey: string
}

export interface CartCount {
  count: number
}

export interface UpdateCartParams {
  selected?: boolean
  count?: number
}

export interface DeleteCartParams {
  ids: string[]
}

export interface AddressItem {
  address: string
  contact: string
  fullLocation: string
  id: string
  isDefault: 0 | 1
  receiver: string
  provinceCode: number
  cityCode: number
  countyCode: number
}

export interface OrderGoodsItem extends ReturnPolicyFields {
  stock?: number
  attrsText: string
  count: number
  id: string
  name: string
  payPrice: string
  picture: string
  price: string
  skuId: string
  totalPayPrice: string
  totalPrice: string
}

export interface Summary {
  discountPrice: number
  goodsCount: number
  postFee: number
  totalPayPrice: number
  totalPrice: number
}

export interface PromotionRule { thresholdCents: number; discountCents: number; enabled: boolean; revision: number }
export interface PromotionQuote {
  rule: PromotionRule
  discountCents: number
  amountCents: number
  remainingCents: number
}

export interface PreOrder {
  returnPolicyToken?: string
  promotion?: PromotionQuote
  excludedGoods?: ExcludedCheckoutGoods[]
  goods: OrderGoodsItem[]
  userAddresses: AddressItem[]
  summary: Summary
}

export interface ExcludedCheckoutGoods { skuId: string; name: string; reason: string }

export interface CreateOrderParamsGoods {
  skuId: string
  count: number
}

export interface CreateOrderParams {
  invoice?: InvoiceInput
  expectedPromotionRevision?: number
  returnPolicyConfirmed?: boolean
  expectedReturnPolicyToken?: string
  expectedAmountCents: number
  source?: 'cart' | 'buy-now'
  requestKey?: string
  deliveryTimeType: number
  payType: number
  buyerMessage: string
  payChannel: number
  goods: CreateOrderParamsGoods[]
  addressId: string
}

export interface CreateOrderResult {
  id: string
}

export interface OrderItem {
  shippedAt?: number | null
  signedAt?: number | null
  receivedAt?: number | null
  logistics?: OrderLogistics | null
  channelTransactionId?: string | null
  invoice?: InvoiceDetail | null
  afterSales?: AfterSale[]
  canApplyAfterSale?: boolean
  afterSaleActive?: boolean
  afterSaleKinds?: string[]
  afterSaleDeadline?: number
  noReasonDeadline?: number
  afterSaleNotice?: string
  address?: AddressItem
  serverManaged?: boolean
  ownerAccount?: string
  payerAccount?: string
  invitedPayerAccount?: string
  receivedByAccount?: string
  paymentMode?: string
  paymentChannel?: string
  canResumePayment?: boolean
  paymentState?: 'none' | 'confirming' | 'paid' | 'review'
  refunds?: OrderRefund[]
  paymentNotice?: string
  needsAttention?: boolean
  canPay?: boolean
  canCancel?: boolean
  cancelRequest?: OrderCancelRequest | null
  canRequestCancel?: boolean
  canWithdrawCancel?: boolean
  canResolveCancel?: boolean
  canShip?: boolean
  cancelRequestNotice?: string
  cancelConfirmation?: CancelConfirmation | null
  serverNow?: number
  canReceive?: boolean
  canEvaluate?: boolean
  canInvitePayer?: boolean
  evaluation?: LocalEvaluationItem | null
  countdown: number
  createTime: string
  id: string
  orderState: 1 | 2 | 3 | 4 | 5 | 6
  payChannel: number
  payLatestTime: string
  payMoney: number
  payType: number
  postFee: number
  skus: OrderSku[]
  totalMoney: number
  totalNum: number
}

export interface CheckoutSelection {
  skuId: string
  count: number
}

export interface PendingTradeInfo {
  accountId: string
  requestKey: string
  goodsId: string
  created: number
  entry?: HDMGoodsItem
}

export interface OrderCancelRequest {
  id: string
  sequence: number
  state: 'pending' | 'withdrawn' | 'approved' | 'rejected-shipped' | 'auto-approved'
  createdAt: number
  deadlineAt: number
  resolvedAt: number | null
  rejectReason: string | null
  refundId: string | null
}

export interface CancelConfirmation {
  amountCents: number
  payerAccount: string
  paymentMode: string
  message: string
}

export interface CancelActionIntent {
  orderId: string
  cancelRequestId: string
  action: 'request' | 'withdraw' | 'approve' | 'reject-and-ship'
  reason: string
  carrier?: string
  trackingNo?: string
}

export interface PendingCancelAction extends CancelActionIntent {
  accountId: string
  requestKey: string
}

export interface CancelActionReceipt {
  id: string
  orderId: string
  cancelRequestId: string
  action: string
  appliedState: string
  appliedAt: number
  refundId: string | null
}

export interface OrderRefund {
  id: string
  amount: number
  payerAccount: string
  paidAt: number | null
  state: string
  reason: string
  channelRefundId?: string | null
}

export interface ShipmentInput { carrier: string; trackingNo: string }
export interface LogisticsEvent { id: string; state: string; occurredAt: number; description: string }
export interface OrderLogistics { orderId: string; carrier: string; trackingNo: string; source: string; state: string; created: number; events: LogisticsEvent[] }

export interface PaymentStartResult {
  id: string
  orderId: string
  paymentId: string
  state: string
  checkoutUrl?: string
  sandbox?: boolean
}

export interface OrderAttentionCount {
  count: number
}

export interface PaymentFields {
  paymentChannel?: string
  canResumePayment?: boolean
  paymentState: string
  refunds: OrderRefund[]
  paymentNotice: string
  needsAttention: boolean
  canPay: boolean
  canCancel: boolean
  countdown: number
}

export interface OrderListParams {
  page: number
  pageSize: number
  orderState: number
}

export interface FamilyGroupCounts {
  pay: number
  receipt: number
  pending: number
  all: number
}

export interface OrderPage {
  groupCounts?: FamilyGroupCounts
  counts: number
  items: OrderItem[]
  page: number
  pageSize: number
  pages: number
}

export interface OrderSku extends ReturnPolicyFields {
  afterSaleKinds?: string[]
  afterSaleRemaining?: number
  discountShareCents?: number
  attrsText: string
  curPrice: number
  id: string
  image: string
  name: string
  properties: Property[]
  quantity: number
  realPay: number
  spuId: string
}

export interface Property {
  propertyMainName: string
  propertyValueName: string
}

export interface PayResultParams {
  payResult: boolean
  orderId: string
}

/** 本地演示评价：仅用于补齐「待评价」演示闭环，不会提交到后端。 */
export interface LocalEvaluationItem {
  hiddenReason?: string | null
  orderId: string
  score: number
  content: string
  createdAt: number
}

/** 叠加在服务端订单之上的本地推进标记；不为真支付，UI 需显著标识"本地演示"。 */
export interface DemoOrderOverlay {
  orderId: string
  advancedState: number
  updatedAt: number
}
