import { HDMGoodsItem } from 'models'
import { Goods } from '../../domain/models'
import { HDMSkuType, HDMSpec } from 'ui_components'

// 未选全规格时，@ohmos/sku 只回传 picture 和 specsText，不保证有 id 或库存。
export function normalizeSkuSelection(sku?: HDMSkuType): HDMSkuType {
  return {
    id: sku?.id ?? '',
    skuCode: sku?.skuCode ?? '',
    price: sku?.price ?? '',
    oldPrice: sku?.oldPrice ?? '',
    inventory: sku?.inventory ?? 0,
    specs: sku?.specs ?? [],
    specsText: sku?.specsText ?? null,
    picture: sku?.picture ?? null
  }
}

function skuSupportsSelection(sku: HDMSkuType, selectedValues: (string | undefined)[]): boolean {
  for (let index: number = 0; index < selectedValues.length; index++) {
    const selectedValue: string | undefined = selectedValues[index]
    if (!selectedValue) {
      continue
    }
    if (index >= sku.specs.length || sku.specs[index].valueName !== selectedValue) {
      return false
    }
  }
  return true
}

/**
 * SKU 组件要求每条可点击的选择路径都能命中有库存的 SKU。
 * 挂载前修正初始选中和禁用状态，避免不完整的接口规格矩阵触发组件内部空值访问。
 */
export function normalizeSkuSpecs(skus: HDMSkuType[], specs: HDMSpec[]): HDMSpec[] {
  const availableSkus: HDMSkuType[] = skus.filter((sku: HDMSkuType): boolean => sku.inventory > 0)
  const normalizedSpecs: HDMSpec[] = specs.map((spec: HDMSpec): HDMSpec => {
    const normalizedSpec: HDMSpec = {
      name: spec.name,
      values: []
    }
    spec.values.forEach(value => {
      normalizedSpec.values.push({
        name: value.name,
        picture: value.picture,
        selected: value.selected,
        disabled: value.disabled
      })
    })
    return normalizedSpec
  })
  const selectedValues: (string | undefined)[] = []

  normalizedSpecs.forEach((spec: HDMSpec): void => {
    const selectedValue = spec.values.find(value => value.selected)
    selectedValues.push(selectedValue ? selectedValue.name : undefined)
  })

  const hasSelection: boolean = selectedValues.some((value: string | undefined): boolean => !!value)
  if (hasSelection && !availableSkus.some((sku: HDMSkuType): boolean => {
    return skuSupportsSelection(sku, selectedValues)
  })) {
    normalizedSpecs.forEach((spec: HDMSpec): void => {
      spec.values.forEach(value => value.selected = false)
    })
    selectedValues.fill(undefined)
  }

  normalizedSpecs.forEach((spec: HDMSpec, specIndex: number): void => {
    spec.values.forEach(value => {
      const candidateValues: (string | undefined)[] = selectedValues.slice()
      candidateValues[specIndex] = value.name
      value.disabled = !availableSkus.some((sku: HDMSkuType): boolean => {
        return skuSupportsSelection(sku, candidateValues)
      })
    })
  })

  return normalizedSpecs
}

function getPictureKey(item: HDMGoodsItem): string {
  if (typeof item.picture !== 'string') {
    return ''
  }
  return item.picture.split('?')[0].split('#')[0].toLowerCase()
}

function getContentKey(item: HDMGoodsItem): string {
  const name: string = item.name.trim().toLowerCase()
  if (!name) {
    return ''
  }
  return `${name}|${item.price.toString().trim()}`
}

export function getDistinctGoods(
  primary: HDMGoodsItem[],
  excluded: HDMGoodsItem[],
  fallbacks: HDMGoodsItem[][],
  limit: number = primary.length
): HDMGoodsItem[] {
  const result: HDMGoodsItem[] = []
  const blockedIds: Set<string> = new Set<string>()
  const blockedPictures: Set<string> = new Set<string>()
  const blockedContents: Set<string> = new Set<string>()

  excluded.forEach((item: HDMGoodsItem): void => {
    blockedIds.add(item.id)
    const pictureKey: string = getPictureKey(item)
    const contentKey: string = getContentKey(item)
    if (pictureKey) {
      blockedPictures.add(pictureKey)
    }
    if (contentKey) {
      blockedContents.add(contentKey)
    }
  })

  const appendGoods = (candidates: HDMGoodsItem[]): void => {
    candidates.forEach((item: HDMGoodsItem): void => {
      if (result.length >= limit) {
        return
      }
      const pictureKey: string = getPictureKey(item)
      const contentKey: string = getContentKey(item)
      if (blockedIds.has(item.id) ||
        (pictureKey && blockedPictures.has(pictureKey)) ||
        (contentKey && blockedContents.has(contentKey))) {
        return
      }
      blockedIds.add(item.id)
      if (pictureKey) {
        blockedPictures.add(pictureKey)
      }
      if (contentKey) {
        blockedContents.add(contentKey)
      }
      result.push(item)
    })
  }

  appendGoods(primary)
  fallbacks.forEach((items: HDMGoodsItem[]): void => appendGoods(items))
  return result
}

export function fillPromotionGoods(
  distinctGoods: HDMGoodsItem[],
  sectionGoods: HDMGoodsItem[],
  limit: number
): HDMGoodsItem[] {
  return getDistinctGoods(distinctGoods, [], [sectionGoods], limit)
}

export function findProductPicture(source: HDMGoodsItem, detail: Goods): string {
  const pictureCounts: Map<string, number> = new Map<string, number>()
  let repeatedPicture: string = ''
  let repeatedCount: number = 1
  ;(detail.mainPictures || []).forEach((picture: string): void => {
    if (!picture) {
      return
    }
    const count: number = (pictureCounts.get(picture) || 0) + 1
    pictureCounts.set(picture, count)
    if (count > repeatedCount) {
      repeatedPicture = picture
      repeatedCount = count
    }
  })
  // 测试数据中偶尔会把另一类商品误放在首图，但后续真实商品图会重复出现。
  // 只有存在重复证据时才纠正，正常的多角度轮播仍沿用用户在列表看到的封面。
  if (repeatedPicture) {
    return repeatedPicture
  }
  if (typeof source.picture === 'string' && source.picture) {
    return source.picture
  }
  if (typeof detail.picture === 'string' && detail.picture) {
    return detail.picture
  }
  const pictures: string[] = detail.mainPictures || []
  if (pictures.length > 0) {
    return pictures[0]
  }
  return ''
}

export function normalizeGoodsSummaryPicture(source: HDMGoodsItem, detail: Goods): HDMGoodsItem {
  return {
    id: source.id,
    name: source.name,
    desc: source.desc,
    price: source.price,
    picture: findProductPicture(source, detail),
    orderNum: source.orderNum,
    originalPrice: source.originalPrice
  }
}

export function normalizeGoodsPresentation(source: HDMGoodsItem, detail: Goods): Goods {
  const productPicture: string = findProductPicture(source, detail)
  return {
    // /hot、/home、/search 与 /goods 的展示价格并不总是一致。
    // 详情页继续使用真实详情的库存、规格和 SKU，但首屏展示字段必须沿用用户点击的卡片。
    id: source.id,
    name: source.name,
    desc: source.desc,
    price: source.price,
    picture: productPicture,
    orderNum: source.orderNum,
    originalPrice: source.originalPrice || detail.originalPrice,
    inventory: detail.inventory,
    mainPictures: productPicture ? [productPicture] : [],
    details: detail.details,
    specs: normalizeSkuSpecs(detail.skus, detail.specs),
    skus: detail.skus
  }
}

export function excludeFailedPicture(pictures: string[], failedPicture: string): string[] {
  return pictures.filter((picture: string): boolean => picture !== failedPicture)
}
