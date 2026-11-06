import { HDMSkuType, HDMSpec } from 'ui_components'
import { HDMGoodsItem } from 'models'
import { Goods } from '../../domain/models'
import { normalizeSkuSelection, normalizeSkuSpecs } from './goodsPresentation'
import { isFallbackSkuId } from './mockData'

export interface PendingLoginSelection {
  goodsId: string
  sku: HDMSkuType
  count: number
  token: string
  action?: 'cart' | 'buy-now'
  requestKey?: string
  created?: number
  accountId?: string
  entry?: HDMGoodsItem
}

export function isPendingTradeValid(selection: PendingLoginSelection, now: number, accountId: string): boolean {
  return !!selection && !!selection.goodsId && !!selection.requestKey && !!selection.action &&
    Number.isFinite(selection.created) && selection.created! <= now && now - selection.created! <= 30 * 60_000 &&
    (!selection.accountId || selection.accountId === accountId)
}

export interface RestoredLoginSelection {
  sku: HDMSkuType
  count: number
  specs: HDMSpec[]
  invalid: boolean
}

export function canPreserveLoginSelection(previousToken: string, nextToken: string): boolean {
  return previousToken.length === 0 && nextToken.length > 0
}

export function restoreLoginSelection(selection: PendingLoginSelection, goods: Goods, demo: boolean = false): RestoredLoginSelection {
  const current: HDMSkuType | undefined = goods.skus?.find(item => item.id === selection.sku.id)
  const valid: boolean = goods.id === selection.goodsId && !!current && !isFallbackSkuId(current.id) &&
    Number.isInteger(selection.count) && selection.count >= 1 && selection.count <= 999 &&
    selection.count <= current.inventory && (demo || String(current.price) === String(selection.sku.price)) &&
    current.specs.length === selection.sku.specs.length &&
    current.specs.every((spec, index) => spec.name === selection.sku.specs[index].name &&
      spec.valueName === selection.sku.specs[index].valueName) &&
    goods.specs.every(spec => !!current.specs.find(value => value.name === spec.name &&
      spec.values.some(option => option.name === value.valueName)))
  const sku: HDMSkuType = normalizeSkuSelection(valid ? current : undefined)
  const specs: HDMSpec[] = normalizeSkuSpecs(goods.skus, goods.specs)
  specs.forEach(spec => {
    spec.values.forEach(value => {
      value.selected = valid && sku.specs.some(selected => selected.name === spec.name && selected.valueName === value.name)
    })
  })
  return { sku, count: valid ? selection.count : 1,
    specs: normalizeSkuSpecs(goods.skus, specs), invalid: !valid }
}
