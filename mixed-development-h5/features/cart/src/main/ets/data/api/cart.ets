import { RequestAxios, BusinessError } from 'network'
import {
  CartGoodsModel,
  CreateOrderParams,
  CreateOrderResult,
  DeleteCartParams,
  OrderItem,
  OrderListParams,
  OrderPage,
  PreOrder,
  UpdateCartParams
} from 'models'

// 获取购物车列表
export const getCartListAPI = () => {
  return RequestAxios.get<CartGoodsModel[]>('/member/cart')
}

// 修改购物车单项（数量/选中状态）
export const updateCart = (skuId: string, data: UpdateCartParams) => {
  return RequestAxios.put<CartGoodsModel>(`/member/cart/${skuId}`, data)
}

// 全选或取消全选
export const selectOrUnSelect = (data: UpdateCartParams) => {
  return RequestAxios.put<null>('/member/cart/selected', data)
}

// 删除购物车商品
export const delCart = (data: DeleteCartParams) => {
  return RequestAxios.delete<null>('/member/cart', data)
}

// 获取订单结算信息（静默：失效商品等业务错误由结算页统一给出更明确的提示）
export const getPreOrderAPI = () => {
  return RequestAxios.getSilent<PreOrder>('/member/order/pre')
}

// 创建订单
export const createOrderAPI = (data: CreateOrderParams) => {
  return RequestAxios.post<CreateOrderResult>('/member/order', data)
}

export const getOrderListAPI = (params: OrderListParams) => {
  return RequestAxios.get<OrderPage>('/member/order', params)
}

// 按订单号查询最新服务端状态，不能用支付回调替代。
// 静默：支付结果页和订单详情页都有自己的失败态与重试入口，避免叠加一层 toast。
export const getOrderDetailAPI = (orderId: string) => {
  return RequestAxios.getSilent<OrderItem>(`/member/order/${orderId}`)
}

export interface ConsignmentResult {
}

export interface OrderStateResult {
  id: string
}

interface CancelOrderParams {
  cancelReason: string
}

interface EmptyParams {
}

const CANCEL_REASON_UNWANTED: CancelOrderParams = { cancelReason: '不想要了' }
const EMPTY_PARAMS: EmptyParams = {}

// 模拟发货（后端真实提供）：GET /member/order/consignment/{id}
export const consignmentOrderAPI = (orderId: string): Promise<ConsignmentResult> => {
  return RequestAxios.getSilent<ConsignmentResult>(`/member/order/consignment/${orderId}`)
}

// 取消订单：PUT /member/order/{id}/cancel  body: { cancelReason: string }
export const cancelOrderAPI = (orderId: string): Promise<OrderStateResult> => {
  return RequestAxios.putSilent<OrderStateResult>(`/member/order/${orderId}/cancel`, CANCEL_REASON_UNWANTED)
}

// 旧版取消接口，仅在 PUT 版本不存在（404/405）时作为兼容路径使用。
export const cancelOrderFallbackAPI = (orderId: string): Promise<OrderStateResult> => {
  return RequestAxios.getSilent<OrderStateResult>(`/member/order/cancel/${orderId}`)
}

/**
 * 只有接口本身不存在才值得走旧接口；业务失败（如"已发货不能取消"）必须原样抛出，
 * 否则会对同一个订单打两次写请求。
 */
export function isFallbackWorthTrying(error: Error): boolean {
  const status: number | undefined = (error as BusinessError).httpStatus
  return status === 404 || status === 405
}

export async function cancelOrderWithFallback(orderId: string): Promise<void> {
  try {
    await cancelOrderAPI(orderId)
  } catch (error) {
    const reason: Error = error as Error
    if (!isFallbackWorthTrying(reason)) {
      throw reason
    }
    await cancelOrderFallbackAPI(orderId)
  }
}

// 确认收货：PUT /member/order/{id}/receipt
export const receiptOrderAPI = (orderId: string): Promise<OrderStateResult> => {
  return RequestAxios.putSilent<OrderStateResult>(`/member/order/${orderId}/receipt`, EMPTY_PARAMS)
}

export const commentOrderAPI = (orderId: string): Promise<OrderStateResult> => {
  return RequestAxios.putSilent<OrderStateResult>(`/member/order/${orderId}/evaluation`, EMPTY_PARAMS)
}
