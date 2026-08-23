import { RequestAxios } from 'network'
import { CategoryItem, HDMGoodsItem } from 'models'
import { Banner, Goods, HotResult, SearchResult, RecommendParams } from '../../domain/models'
import { generateFallbackGoods } from './mockData'

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

export const searchGoodsAPI = (data: object) => {
  return RequestAxios.post<SearchResult>("/search/all", data)
}

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
    const params: GoodsDetailParams = { id: source.id }
    const detail: Goods = await RequestAxios.getSilent<Goods>(
      '/goods',
      params
    )
    // 部分接口会以 200 返回空结果，不能把 undefined 继续传给详情子组件。
    if (detail) {
      return detail
    }
    return generateFallbackGoods(source)
  } catch {
    return generateFallbackGoods(source)
  }
}
