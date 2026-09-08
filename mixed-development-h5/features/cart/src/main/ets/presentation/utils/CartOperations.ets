import { CartGoodsModel, UpdateCartParams } from 'models'
import { authCart } from 'storage'
import { delCart, selectOrUnSelect, updateCart } from '../../data/api'

/**
 * 购物车操作接口
 * 统一管理购物车的增删改查操作
 */
export interface ICartOperations {
  /**
   * 更新商品选中状态
   */
  updateSelected(cartId: string, selected: boolean): Promise<void>

  /**
   * 更新商品数量
   */
  updateCount(cartId: string, count: number): Promise<void>

  /**
   * 删除商品
   */
  deleteCart(cartId: string): Promise<void>

  /**
   * 全选/取消全选
   */
  updateAllSelected(selected: boolean): Promise<void>
}

/**
 * 购物车操作辅助类
 * 提供统一的错误处理和日志记录
 */
export class CartOperationHelper {
  /**
   * 执行购物车操作并处理错误
   */
  static async execute<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<boolean> {
    try {
      await operation()
      return true
    } catch (error) {
      console.error(`[CartOperation] ${operationName} failed`, error)
      return false
    }
  }

  /**
   * 批量更新购物车选中状态
   */
  static batchUpdateSelected(
    carts: CartGoodsModel[],
    selected: boolean
  ): CartGoodsModel[] {
    return carts.map(cart => {
      cart.selected = selected
      return cart
    })
  }

  /**
   * 计算选中商品的总价
   */
  static calculateTotalPrice(carts: CartGoodsModel[]): number {
    return carts
      .filter(cart => cart.selected)
      .reduce((total, cart) => {
        return total + (cart.price * cart.count)
      }, 0)
  }

  /**
   * 计算选中商品的数量
   */
  static calculateSelectedCount(carts: CartGoodsModel[]): number {
    return carts
      .filter(cart => cart.selected)
      .reduce((total, cart) => total + cart.count, 0)
  }

  /**
   * 检查是否全选
   */
  static isAllSelected(carts: CartGoodsModel[]): boolean {
    if (carts.length === 0) {
      return false
    }
    return carts.every(cart => cart.selected)
  }

  /**
   * 获取选中的商品列表
   */
  static getSelectedCarts(carts: CartGoodsModel[]): CartGoodsModel[] {
    return carts.filter(cart => cart.selected)
  }

  static checkIsAllSelected(carts: CartGoodsModel[]): boolean {
    return CartOperationHelper.isAllSelected(carts)
  }

  static async deleteCartItems(skuIds: string[]): Promise<void> {
    await delCart({ ids: skuIds })
    await authCart.updateCartCount()
  }

  static async updateCartSelection(cart: CartGoodsModel, selected: boolean): Promise<void> {
    const data: UpdateCartParams = { selected, count: cart.count }
    await updateCart(cart.skuId, data)
    // 服务端成功后才回写本地状态，保证界面与服务端一致
    cart.selected = selected
    await authCart.updateCartCount()
  }

  static async updateCartCount(cart: CartGoodsModel, count: number): Promise<void> {
    if (count < 1) {
      return
    }
    const data: UpdateCartParams = { selected: cart.selected, count }
    await updateCart(cart.skuId, data)
    // 服务端成功后才回写本地数量
    cart.count = count
    await authCart.updateCartCount()
  }

  static async toggleSelectAll(selected: boolean): Promise<void> {
    await selectOrUnSelect({ selected, count: 0 })
    await authCart.updateCartCount()
  }
}
