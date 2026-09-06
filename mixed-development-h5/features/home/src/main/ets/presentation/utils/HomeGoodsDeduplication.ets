import { HDMGoodsItem } from 'models'

/**
 * 商品去重逻辑封装类
 * 用于处理首页多个推荐模块之间的商品去重
 */
export class HomeGoodsDeduplication {
  private static readonly PROMOTION_LIMIT: number = 4

  /**
   * 处理首页商品数据，返回去重后的各模块商品列表
   */
  static processHomeGoods(
    saleGoods: HDMGoodsItem[],
    hotGoods: HDMGoodsItem[],
    oneGoods: HDMGoodsItem[],
    newGoods: HDMGoodsItem[],
    getDistinctGoods: (
      primary: HDMGoodsItem[],
      excluded: HDMGoodsItem[],
      fallbacks: HDMGoodsItem[][],
      limit?: number
    ) => HDMGoodsItem[],
    fillPromotionGoods: (
      distinctGoods: HDMGoodsItem[],
      sectionGoods: HDMGoodsItem[],
      limit: number
    ) => HDMGoodsItem[]
  ): HomeGoodsResult {
    const selectedSaleGoods: HDMGoodsItem[] =
      getDistinctGoods(saleGoods, newGoods, [hotGoods, oneGoods], HomeGoodsDeduplication.PROMOTION_LIMIT)

    const saleAndNewGoods: HDMGoodsItem[] = newGoods.concat(selectedSaleGoods)
    const selectedHotGoods: HDMGoodsItem[] =
      getDistinctGoods(hotGoods, saleAndNewGoods, [oneGoods, saleGoods], HomeGoodsDeduplication.PROMOTION_LIMIT)

    const promotedGoods: HDMGoodsItem[] = selectedSaleGoods.concat(selectedHotGoods)
    const reservedGoods: HDMGoodsItem[] = newGoods.concat(promotedGoods)
    const distinctOneGoods: HDMGoodsItem[] =
      getDistinctGoods(oneGoods, reservedGoods, [hotGoods, saleGoods], HomeGoodsDeduplication.PROMOTION_LIMIT)
    const selectedOneGoods: HDMGoodsItem[] = fillPromotionGoods(distinctOneGoods, oneGoods, HomeGoodsDeduplication.PROMOTION_LIMIT)

    const displayedGoods: HDMGoodsItem[] = selectedSaleGoods.concat(selectedHotGoods, selectedOneGoods)
    const processedNewGoods: HDMGoodsItem[] = getDistinctGoods(newGoods, displayedGoods, [])

    return {
      saleGoods: selectedSaleGoods,
      hotGoods: selectedHotGoods,
      oneGoods: selectedOneGoods,
      newGoods: processedNewGoods
    }
  }
}

export interface HomeGoodsResult {
  saleGoods: HDMGoodsItem[]
  hotGoods: HDMGoodsItem[]
  oneGoods: HDMGoodsItem[]
  newGoods: HDMGoodsItem[]
}
