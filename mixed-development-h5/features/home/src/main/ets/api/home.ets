import { RequestAxios, CategoryItem, HDMGoodsItem } from 'basic'
import { Banner, Goods, HotResult, SearchResult } from '../viewmodel'
import { generateRandomMockGoods } from './mockData'

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

export const getRecommendAPI = (params: object) => {
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

export const getRealSearchGoodsAPI = (
  searchText: string = '休闲',
  page: string = '1',
  everyNum: string = '4'
): Promise<RealGoodsResponse> => {
  return RequestAxios.getRaw<RealGoodsResponse>(
    'https://hmajax.itheima.net/api-s/searchGoodsList',
    { searchText, page, everyNum }
  )
}

export const getDetailAPI = async (id: string): Promise<Goods> => {
  try {
    return await RequestAxios.getSilent<Goods>(
      'https://pcapi-xiaotuxian-front-devtest.itheima.net/goods',
      { id }
    )
  } catch {
    return generateRandomMockGoods(id)
  }
}