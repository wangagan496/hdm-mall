import { ExcludedCheckoutGoods } from './BusinessModels'

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
  totalAmountCents?: number
  goods: CheckoutPrice[] | CheckoutShortage[] | ExcludedCheckoutGoods[]
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

