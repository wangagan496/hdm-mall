import { ExcludedCheckoutGoods, PromotionQuote } from './BusinessModels'
import { ReturnPolicyGoods } from './ReturnPolicy'

export interface CheckoutPrice {
  skuId: string
  name: string
  spec: string
  priceCents: number
  count: number
  subtotalCents: number
}
export interface CheckoutShortage {
  skuId: string
  name: string
  spec: string
  requiredCount: number
  remainingCount: number
}
export interface CheckoutDetail {
  returnPolicyToken?: string
  promotion?: PromotionQuote
  totalAmountCents?: number
  goods: CheckoutPrice[] | CheckoutShortage[] | ExcludedCheckoutGoods[] | ReturnPolicyGoods[]
}
export interface CheckoutFailure {
  status: number
  reason: string
  result?: CheckoutDetail
}
export interface OrderRequestResult {
  id: string
  orderState: number
  expiresAt: number
}
export interface PendingOrderRequest {
  accountId: string
  requestKey: string
  summary: string
}
