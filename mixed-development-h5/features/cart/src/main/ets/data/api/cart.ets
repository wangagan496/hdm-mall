import { RequestAxios } from 'network'
import {
  CartGoodsModel,
  CheckoutSelection,
  CreateOrderParams,
  CreateOrderResult,
  DeleteCartParams,
  FamilyRelation,
  FamilyRelationPage,
  GoodsItems,
  OrderItem,
  OrderListParams,
  OrderPage,
  PaymentStartResult,
  PaymentFields,
  PreOrder,
  UpdateCartParams
} from 'models'
export { requestOrderCancelAPI, withdrawOrderCancelAPI, resolveOrderCancelAPI, getCancelActionReceiptAPI } from 'storage'

// 获取购物车列表
export const getCartListAPI = (token: string) => {
  return RequestAxios.getForSession<CartGoodsModel[]>('/member/cart', token)
}

interface GuessLikeParams {
  page: number
}

// 猜你喜欢分页数据，供购物袋/支付结果页的 HDMGuess 组件通过 loader 注入使用
export const getGuessLikeAPI = (page: number) => {
  return RequestAxios.get<GoodsItems>('/home/goods/guessLike', { page } as GuessLikeParams)
}

// 修改购物车单项（数量/选中状态）
export const updateCart = (skuId: string, data: UpdateCartParams) => {
  return RequestAxios.put<CartGoodsModel>(`/member/cart/${skuId}`, data)
}

export const updateCheckoutCartAPI = (skuId: string, data: UpdateCartParams, token: string) => {
  return RequestAxios.putForSession<CartGoodsModel>(`/member/cart/${skuId}`, data, token)
}

// 全选或取消全选
export const selectOrUnSelect = (data: UpdateCartParams) => {
  return RequestAxios.put<null>('/member/cart/selected', data)
}

// 删除购物车商品
export const delCart = (data: DeleteCartParams) => {
  return RequestAxios.delete<null>('/member/cart', data)
}

// 结算预览：读取已选商品、地址和金额，不创建订单、不扣库存。
// 静默请求：失败提示统一由 CheckView 显示。
export const getPreOrderAPI = (token: string, selection?: CheckoutSelection) => {
  const query = selection ? `?skuId=${encodeURIComponent(selection.skuId)}&count=${selection.count}` : ''
  return RequestAxios.getForSession<PreOrder>('/member/order/pre' + query, token)
}

// 确认购买后才创建订单，返回真实订单号供收银台使用；创建成功不代表已付款。
// 同一次下单重试必须沿用 requestKey；服务端据此防止重复生成订单。
export const createOrderAPI = (data: CreateOrderParams, token: string) => {
  return RequestAxios.postWithSession<CreateOrderResult>('/member/order', data, token)
}

export const getOrderListAPI = (params: OrderListParams, token: string) => {
  return RequestAxios.getForSession<OrderPage>(`/member/order?page=${params.page}&pageSize=${params.pageSize}&orderState=${params.orderState}`, token)
}

// 按订单号查询最新服务端状态，不能用支付回调替代。
// 静默：支付结果页和订单详情页都有自己的失败态与重试入口，避免叠加一层 toast。
export const getOrderDetailAPI = (orderId: string, token?: string) => {
  if (token) return RequestAxios.getForSession<OrderItem>(`/member/order/${orderId}`, token)
  return RequestAxios.getWithoutToast<OrderItem>(`/member/order/${orderId}`)
}

export interface ConsignmentResult extends OrderItem {
}

export interface OrderStateResult {
  id: string
}

interface CancelOrderParams {
  cancelReason: string
}

interface EmptyParams {
}

interface PaymentPayload { amountCents: number }

const CANCEL_REASON_UNWANTED: CancelOrderParams = { cancelReason: '不想要了' }
const EMPTY_PARAMS: EmptyParams = {}

// 提醒发货：POST /member/order/{id}/reminder
export const remindShipmentAPI = (orderId: string, token?: string): Promise<ConsignmentResult> => {
  if (token) return RequestAxios.postWithSession<ConsignmentResult>(`/member/order/${orderId}/reminder`, EMPTY_PARAMS, token)
  return RequestAxios.postSilent<ConsignmentResult>(`/member/order/${orderId}/reminder`)
}

// 取消订单：PUT /member/order/{id}/cancel  body: { cancelReason: string }
export const cancelOrderAPI = (orderId: string, token?: string): Promise<OrderItem> => {
  if (token) return RequestAxios.putForSession<OrderItem>(`/member/order/${orderId}/cancel`, CANCEL_REASON_UNWANTED, token)
  return RequestAxios.putSilent<OrderItem>(`/member/order/${orderId}/cancel`, CANCEL_REASON_UNWANTED)
}

// 旧版取消接口，仅在 PUT 版本不存在（404/405）时作为兼容路径使用。
export const cancelOrderFallbackAPI = (orderId: string, token?: string): Promise<OrderItem> => {
  if (token) return RequestAxios.getForSession<OrderItem>(`/member/order/cancel/${orderId}`, token)
  return RequestAxios.getWithoutToast<OrderItem>(`/member/order/cancel/${orderId}`)
}

/**
 * 只有接口本身不存在才值得走旧接口；业务失败（如"已发货不能取消"）必须原样抛出，
 * 否则会对同一个订单打两次写请求。
 */
export function isFallbackWorthTrying(error: Error): boolean {
  const failure = error as CancelRequestError
  const status: number | undefined = failure.httpStatus || failure.response?.status
  return status === 404 || status === 405
}

interface CancelRequestError extends Error {
  httpStatus?: number
  response?: CancelResponse
}

interface CancelResponse { status: number }

export async function cancelOrderWithFallback(orderId: string, token?: string): Promise<OrderItem> {
  try {
    return await cancelOrderAPI(orderId, token)
  } catch (error) {
    const reason: Error = error as Error
    if (!isFallbackWorthTrying(reason)) {
      throw reason
    }
    return await cancelOrderFallbackAPI(orderId, token)
  }
}

// 确认收货：PUT /member/order/{id}/receipt
export const receiptOrderAPI = (orderId: string, token?: string): Promise<OrderItem> => {
  if (token) return RequestAxios.putForSession<OrderItem>(`/member/order/${orderId}/receipt`, EMPTY_PARAMS, token)
  return RequestAxios.putSilent<OrderItem>(`/member/order/${orderId}/receipt`, EMPTY_PARAMS)
}

export interface EvaluationPayload {
  score: number
  content: string
}

export const commentOrderAPI = (orderId: string, data: EvaluationPayload, token?: string): Promise<OrderStateResult> => {
  if (token) return RequestAxios.putForSession<OrderStateResult>(`/member/order/${orderId}/evaluation`, data, token)
  return RequestAxios.putSilent<OrderStateResult>(`/member/order/${orderId}/evaluation`, data)
}

export { FamilyRelation } from 'models'

interface PayerPayload { friendId: string | null }

export function startPaymentAPI(orderId: string, amount: number, token: string): Promise<PaymentStartResult> {
  const data: PaymentPayload = { amountCents: Math.round(amount * 100) }
  return RequestAxios.postWithSession<PaymentStartResult>(`/member/order/${orderId}/payments`, data, token)
}

export function refreshPaymentAPI(orderId: string, token: string): Promise<PaymentFields> {
  return RequestAxios.postWithSession<PaymentFields>(`/member/order/${orderId}/payments/refresh`, EMPTY_PARAMS, token)
}

export function invitePayerAPI(orderId: string, friendId: string | null, token: string): Promise<OrderStateResult> {
  const data: PayerPayload = { friendId }
  return RequestAxios.putForSession<OrderStateResult>(`/member/order/${orderId}/payer`, data, token)
}

export function getFamilyRelationsAPI(): Promise<FamilyRelation[]> {
  return RequestAxios.get<FamilyRelation[]>('/member/relations')
}

export function getPayerRelationsPageAPI(page: number, token: string): Promise<FamilyRelationPage> {
  return RequestAxios.getForSession<FamilyRelationPage>('/member/relations/page?scope=payer&page=' + page + '&pageSize=10', token)
}
