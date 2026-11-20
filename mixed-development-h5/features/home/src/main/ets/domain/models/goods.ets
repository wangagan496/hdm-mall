import { HDMGoodsItem, ReviewField, PromiseMaterialSource, PromiseSnapshot } from 'models'
import { HDMSkuType, HDMSpec } from 'ui_components'

// 其他略
export interface GoodsProperty {
  name: string;
  value: string;
}

export interface GoodsDetail {
  pictures: string[];
  properties: GoodsProperty[];
}

export interface GoodsEvaluationMember {
  avatar?: string
  nickname?: string
}

export interface GoodsEvaluation {
  logisticsScore?: number
  serviceScore?: number
  serviceOccurred?: boolean
  items?: ReviewField[]
  badges?: string[]
  receiptBasis?: string
  reply?: string
  content: string
  createTime: string
  id: string
  member: GoodsEvaluationMember | null
  pictures: string[] | null
  score: number
}

export interface GoodsReviewSummary { product:number|null; logistics:number|null; service:number|null; neutral:number; negative:number }
export interface GoodsEvaluationPage {
  summary?: GoodsReviewSummary
  counts: number
  items: GoodsEvaluation[]
  page: number
  pageSize: number
  pages: number
}

// 7个属性 extend继承这7个属性 再增加5个属性
export interface Goods extends HDMGoodsItem {
  categoryName?: string
  promiseSnapshot?: PromiseSnapshot
  promiseSources?: PromiseMaterialSource[]
  status?: string
  available?: boolean
  inventory: number
  mainPictures: string[]
  details: GoodsDetail
  specs: HDMSpec[]
  skus: HDMSkuType[]
}

export interface HmSpecValue {
  name: string
  picture: string | null
  selected: boolean | null
  disabled: boolean | null
}
