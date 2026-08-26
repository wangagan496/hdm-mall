/**
 * 商品ID接口
 */
export interface IHasId {
  id: string
}

/**
 * 商品价格接口
 */
export interface IHasPrice {
  price: string
}

/**
 * 商品折扣接口
 */
export interface IHasDiscount {
  discount?: number
}

/**
 * 完整商品接口
 */
export interface IHasPriceAndDiscount extends IHasPrice, IHasDiscount {}

/**
 * 商品工具类
 * 提供商品去重、过滤等通用功能
 */
export class GoodsUtils {
  /**
   * 商品去重 - 根据商品ID去重
   * @param goodsList 商品列表
   * @returns 去重后的商品列表
   */
  static removeDuplicates<T extends IHasId>(goodsList: T[]): T[] {
    if (!goodsList || goodsList.length === 0) {
      return []
    }

    const seenIds = new Set<string>()
    const uniqueGoods: T[] = []

    for (const goods of goodsList) {
      if (!seenIds.has(goods.id)) {
        seenIds.add(goods.id)
        uniqueGoods.push(goods)
      }
    }

    return uniqueGoods
  }

  /**
   * 合并多个商品列表并去重
   * @param lists 多个商品列表
   * @returns 合并去重后的商品列表
   */
  static mergeAndRemoveDuplicates<T extends IHasId>(...lists: T[][]): T[] {
    const allGoods = lists.flat()
    return GoodsUtils.removeDuplicates(allGoods)
  }

  /**
   * 过滤掉指定ID的商品
   * @param goodsList 商品列表
   * @param excludeIds 要排除的商品ID集合
   * @returns 过滤后的商品列表
   */
  static filterByExcludeIds<T extends IHasId>(goodsList: T[], excludeIds: Set<string>): T[] {
    if (!goodsList || goodsList.length === 0) {
      return []
    }

    return goodsList.filter(goods => !excludeIds.has(goods.id))
  }

  /**
   * 从促销商品中排除已存在的商品
   * @param saleGoods 促销商品列表
   * @param existingGoods 已存在的商品列表
   * @returns 过滤后的促销商品列表
   */
  static filterSaleGoods<T extends IHasId>(saleGoods: T[], existingGoods: T[]): T[] {
    if (!saleGoods || saleGoods.length === 0) {
      return []
    }

    // 创建已存在商品的ID集合
    const existingIds = new Set<string>(existingGoods.map(g => g.id))

    // 过滤掉已存在的商品
    return saleGoods.filter(goods => !existingIds.has(goods.id))
  }

  /**
   * 按价格排序商品
   * @param goodsList 商品列表
   * @param ascending 是否升序，默认降序
   * @returns 排序后的商品列表
   */
  static sortByPrice<T extends IHasPrice>(goodsList: T[], ascending: boolean = false): T[] {
    if (!goodsList || goodsList.length === 0) {
      return []
    }

    return [...goodsList].sort((a, b): number => {
      const priceA = parseFloat(a.price)
      const priceB = parseFloat(b.price)
      return ascending ? priceA - priceB : priceB - priceA
    })
  }

  /**
   * 格式化商品价格显示
   * @param price 价格字符串
   * @returns 格式化后的价格字符串
   */
  static formatPrice(price: string): string {
    const numPrice = parseFloat(price)
    if (isNaN(numPrice)) {
      return '¥0.00'
    }
    return `¥${numPrice.toFixed(2)}`
  }

  /**
   * 检查商品是否有促销活动
   * @param goods 商品对象
   * @returns 是否有促销
   */
  static hasPromotion<T extends IHasDiscount>(goods: T): boolean {
    return goods.discount !== null && goods.discount !== undefined && goods.discount < 1
  }

  /**
   * 计算促销价格
   * @param goods 商品对象
   * @returns 促销后的价格
   */
  static getPromotionPrice<T extends IHasPriceAndDiscount>(goods: T): string {
    if (!GoodsUtils.hasPromotion(goods)) {
      return goods.price
    }

    const originalPrice = parseFloat(goods.price)
    const discount = goods.discount || 1
    const promotionPrice = originalPrice * discount

    return promotionPrice.toFixed(2)
  }
}
