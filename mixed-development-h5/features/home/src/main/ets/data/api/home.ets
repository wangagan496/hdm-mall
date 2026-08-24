import { RequestAxios } from 'network'
import { CategoryItem, HDMGoodsItem } from 'models'
import { Banner, Goods, HotResult, SearchResult, RecommendParams } from '../../domain/models'
import { generateFallbackGoods } from './mockData'
import { normalizeGoodsPresentation, normalizeGoodsSummaryPicture } from './goodsPresentation'

export const getBannerAPI = () => {
  return RequestAxios.get<Banner[]>("/home/banner")
}

export const getCategoryAPI = () => {
  return RequestAxios.get<CategoryItem[]>("/home/category/head")
}

export const getHotResultAPI = () => {
  return RequestAxios.get<HotResult>("/hot/preference")
}

export const getInVogueAPI = () => {
  return RequestAxios.get<HotResult>("/hot/inVogue")
}

export const getOneStopAPI = () => {
  return RequestAxios.get<HotResult>("/hot/oneStop")
}

export const getHomeNewAPI = () => {
  return RequestAxios.get<HDMGoodsItem[]>("/home/new")
}

export const getRecommendAPI = (params: RecommendParams) => {
  return RequestAxios.get<HDMGoodsItem[]>("/home/recommend", params)
}

async function requestGoodsDetail(goodsId: string): Promise<Goods> {
  const params: GoodsDetailParams = { id: goodsId }
  const detail: Goods = await RequestAxios.getSilent<Goods>('/goods', params)
  if (!detail || detail.id !== goodsId) {
    throw new Error('商品详情与入口商品不匹配')
  }
  return detail
}

export const searchGoodsAPI = (data: object) => {
  return RequestAxios.post<SearchResult>('/search/all', data)
}

export function normalizeGoodsSummaryPictures(
  items: HDMGoodsItem[],
  details: (Goods | undefined)[]
): HDMGoodsItem[] {
  return items.map((item: HDMGoodsItem, index: number): HDMGoodsItem => {
    const detail: Goods | undefined = details[index]
    if (!detail || detail.id !== item.id) {
      return item
    }
    return normalizeGoodsSummaryPicture(item, detail)
  })
}

export const normalizeGoodsSummaryPicturesAPI = async (
  items: HDMGoodsItem[]
): Promise<HDMGoodsItem[]> => {
  const results: PromiseSettledResult<Goods>[] = await Promise.allSettled(
    items.map((item: HDMGoodsItem): Promise<Goods> => requestGoodsDetail(item.id))
  )
  const details: (Goods | undefined)[] = results.map((result: PromiseSettledResult<Goods>): Goods | undefined => {
    if (result.status !== 'fulfilled') {
      return undefined
    }
    return result.value
  })
  return normalizeGoodsSummaryPictures(items, details)
}

export const normalizeSearchGoodsPicturesAPI = normalizeGoodsSummaryPicturesAPI

export interface RealGoodsItem {
  goodsId: string
  goodsName: string
  goodsPrice: number
  imageUrl: string
}

export interface RealGoodsList {
  data: RealGoodsItem[]
}

export interface RealGoodsResponse {
  list: RealGoodsList
}

interface RealSearchParams {
  searchText: string
  page: string
  everyNum: string
}

interface GoodsDetailParams {
  id: string
}

export const getRealSearchGoodsAPI = (
  searchText: string = '休闲',
  page: string = '1',
  everyNum: string = '4'
): Promise<RealGoodsResponse> => {
  const params: RealSearchParams = { searchText, page, everyNum }
  return RequestAxios.getRaw<RealGoodsResponse>(
    'https://hmajax.itheima.net/api-s/searchGoodsList',
    params
  )
}

export const getDetailAPI = async (source: HDMGoodsItem): Promise<Goods> => {
  try {
    const detail: Goods = await requestGoodsDetail(source.id)
    return normalizeGoodsPresentation(source, detail)
  } catch {
    return generateFallbackGoods(source)
  }
}
