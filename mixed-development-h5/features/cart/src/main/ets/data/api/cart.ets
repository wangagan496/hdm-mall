import { RequestAxios } from 'network'
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
export const getOrderDetailAPI = (orderId: string) => {
  return RequestAxios.get<OrderItem>(`/member/order/${orderId}`)
}

export interface ConsignmentResult {
}

export const consignmentOrderAPI = (orderId: string): Promise<ConsignmentResult> => {
  return RequestAxios.get<ConsignmentResult>(`/member/order/consignment/${orderId}`)
}
