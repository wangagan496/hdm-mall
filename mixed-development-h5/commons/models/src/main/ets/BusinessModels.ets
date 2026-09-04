export interface HDMGoodsItem {
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
  token: string
  nickname: string
  avatar: string
  account: string
}

export interface CartGoods {
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
  count: number = 0
  id: string = ''
  name: string = ''
  picture: string = ''
  price: number = 0
  selected: boolean = false
  skuId: string = ''
  stock: number = 0
  attrsText: string = ''

  constructor(model: CartGoods) {
    this.count = model.count
    this.id = model.id
    this.name = model.name
    this.picture = model.picture
    this.price = model.price
    this.selected = model.selected
    this.skuId = model.skuId
    this.stock = model.stock
    this.attrsText = model.attrsText
  }
}

export interface AddCartParams {
  skuId: string
  count: number
}

export interface CartCount {
  count: number
}

export interface UpdateCartParams {
  selected: boolean
  count: number
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

export interface OrderGoodsItem {
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

export interface PreOrder {
  goods: OrderGoodsItem[]
  userAddresses: AddressItem[]
  summary: Summary
}

export interface CreateOrderParamsGoods {
  skuId: string
  count: number
}

export interface CreateOrderParams {
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

export interface OrderListParams {
  page: number
  pageSize: number
  orderState: number
}

export interface OrderPage {
  counts: number
  items: OrderItem[]
  page: number
  pageSize: number
  pages: number
}

export interface OrderSku {
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
