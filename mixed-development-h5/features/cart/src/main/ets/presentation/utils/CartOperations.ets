import { CartGoodsModel, UpdateCartParams } from 'models'
import { authCart } from 'storage'
import { Logger } from 'utils'
import { delCart as deleteCartItemsAPI, selectOrUnSelect as saveAllSelectedAPI, updateCart as saveCartItemAPI } from '../../data/api'

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
 * 购物袋业务操作：先保存商品变更，再刷新购物袋数量显示。
 * 单件勾选和数量修改均在服务端成功后回写 cart；请求失败交给 CartView 提示。
 * 下方的金额／勾选计算只服务于页面展示，不负责创建订单。
 */
export class CartOperationHelper {
  // 修改某件商品的购买数量，不是刷新购物袋图标上的数字。
  static async updateCartCount(cart: CartGoodsModel, requestedQuantity: number): Promise<void> {
    if (requestedQuantity < 1) {
      return
    }
    const requestedChange: UpdateCartParams = { count: requestedQuantity }
    await saveCartItemAPI(cart.skuId, requestedChange)
    // 等保存成功再显示新数量；请求失败会跳过这行，由页面提示失败。
    cart.count = requestedQuantity
    await authCart.updateCartCount()
  }

  // 勾选／取消勾选单件商品，不改变它的购买数量。
  static async updateCartSelection(cart: CartGoodsModel, selected: boolean): Promise<void> {
    const requestedChange: UpdateCartParams = { selected }
    await saveCartItemAPI(cart.skuId, requestedChange)
    cart.selected = selected
    await authCart.updateCartCount()
  }

  // 删除指定商品后刷新数量；页面在此方法成功返回后移除对应商品。
  static async deleteCartItems(skuIds: string[]): Promise<void> {
    await deleteCartItemsAPI({ ids: skuIds })
    await authCart.updateCartCount()
  }

  // 批量保存全选／取消全选；页面状态由 CartView 更新。
  static async toggleSelectAll(selected: boolean): Promise<void> {
    await saveAllSelectedAPI({ selected })
    await authCart.updateCartCount()
  }

  // 以下是页面合计、勾选判断与通用辅助方法。
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
      Logger.error(`[CartOperation] ${operationName} failed: ${error}`)
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
        return total + Math.round(cart.price * 100) * cart.count
      }, 0) / 100
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

}
