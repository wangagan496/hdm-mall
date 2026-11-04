import { HDMGoodsItem } from 'models'

// 与服务端 SQLite BINARY 的 UTF-8 字符顺序一致，避免本机语言改变同价商品的次序。
export function compareGoodsIds(left: string, right: string): number {
  let l: number = 0
  let r: number = 0
  while (l < left.length && r < right.length) {
    const a: number = left.codePointAt(l) ?? 0
    const b: number = right.codePointAt(r) ?? 0
    if (a !== b) return a - b
    l += a > 0xFFFF ? 2 : 1
    r += b > 0xFFFF ? 2 : 1
  }
  return (left.length - l) - (right.length - r)
}

interface SearchFailureResponse { status: number }
interface SearchFailure extends Error {
  code?: string
  httpStatus?: number
  response?: SearchFailureResponse
}

export function searchFailureMessage(error: Error): string {
  const failure = error as SearchFailure
  const status: number | undefined = failure.httpStatus || failure.response?.status
  if (status === 401) return '登录已过期，请重新登录后查询'
  if (status === 400) return '查询条件已失效，请重新搜索或选择分类'
  if (status === 429) return '查询过于频繁，请稍后重试'
  if (status !== undefined && status >= 500) return '商品服务暂时不可用，请稍后重试'
  if (failure.code === 'ECONNABORTED' || failure.code === 'ETIMEDOUT') return '商品查询超时，请稍后重试'
  if (failure.code === 'ERR_NETWORK') return '网络连接失败，请检查网络后重试'
  return '商品加载失败，请稍后重试'
}

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
