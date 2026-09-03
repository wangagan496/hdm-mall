import { HDMGoodsItem } from 'models'
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
  content: string
  createTime: string
  id: string
  member: GoodsEvaluationMember | null
  pictures: string[] | null
  score: number
}

export interface GoodsEvaluationPage {
  counts: number
  items: GoodsEvaluation[]
  page: number
  pageSize: number
  pages: number
}

// 7个属性 extend继承这7个属性 再增加5个属性
export interface Goods extends HDMGoodsItem {
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
