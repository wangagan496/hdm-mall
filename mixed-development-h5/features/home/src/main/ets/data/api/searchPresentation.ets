import { HDMGoodsItem } from 'models'

function matchesCategoryKeyword(name: string, keyword: string): boolean {
  if (keyword.includes('双肩包')) {
    return name.includes('双肩包') || name.includes('背包')
  }
  if (keyword.includes('遮阳帽')) {
    return name.includes('遮阳帽') || name.includes('防晒帽')
  }
  if (keyword.includes('光学眼镜')) {
    return name.includes('光学眼镜') || name.includes('近视眼镜') ||
      name.includes('眼镜框') || name.includes('镜架')
  }
  return true
}

export function isSearchGoodsRelevant(
  item: HDMGoodsItem,
  keyword: string,
  categoryId?: string
): boolean {
  const normalizedKeyword: string = keyword.trim().toLowerCase()
  const normalizedName: string = item.name.trim().toLowerCase()

  // 后端的相关词搜索会把普通收纳包混入“手提包”；两者用途不同，列表层不应误导用户。
  if (normalizedKeyword.includes('手提包') &&
    normalizedName.includes('收纳包') &&
    !normalizedName.includes('手提包')) {
    return false
  }
  // “收纳包”分类由关键词接口承载，只保留名称明确属于该分类的商品。
  if (normalizedKeyword.includes('收纳包') && !normalizedName.includes('收纳包')) {
    return false
  }
  // 从分类入口进入时宁可显示真实空状态，也不把相邻品类当作当前分类商品。
  if (categoryId && !matchesCategoryKeyword(normalizedName, normalizedKeyword)) {
    return false
  }
  return true
}

export function filterSearchGoods(
  items: HDMGoodsItem[],
  keyword: string,
  categoryId?: string
): HDMGoodsItem[] {
  return items.filter((item: HDMGoodsItem): boolean => isSearchGoodsRelevant(item, keyword, categoryId))
}
