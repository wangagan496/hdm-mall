import { RequestAxios } from 'network'
import {
  CartGoodsModel,
  CreateOrderParams,
  CreateOrderResult,
  DeleteCartParams,
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

// 获取订单结算信息
export const getPreOrderAPI = () => {
  return RequestAxios.get<PreOrder>('/member/order/pre')
}

// 创建订单
export const createOrderAPI = (data: CreateOrderParams) => {
  return RequestAxios.post<CreateOrderResult>('/member/order', data)
}
