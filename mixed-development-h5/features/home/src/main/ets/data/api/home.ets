import { RequestAxios } from 'network'
import { CategoryItem, GoodsItems, HDMGoodsItem } from 'models'
import {
  Banner,
  Goods,
  GoodsEvaluationPage,
  HotResult,
  SearchResult,
  RecommendParams,
  SearchRouterParam
} from '../../domain/models'
import { generateFallbackGoods } from './mockData'
import { normalizeGoodsPresentation, normalizeGoodsSummaryPicture } from './goodsPresentation'

const goodsDetailCache: Map<string, Promise<Goods>> = new Map<string, Promise<Goods>>()
const BANNER_CATEGORY_PREFIX: string = '/category/'

export function getBannerCategoryId(hrefUrl: string): string {
  if (!hrefUrl.startsWith(BANNER_CATEGORY_PREFIX)) {
    return ''
  }
  return hrefUrl.substring(BANNER_CATEGORY_PREFIX.length).trim()
}

export function getBannerSearchParam(banner: Banner): SearchRouterParam | undefined {
  // Banner 42 advertises winter socks, but the service href points to women's shoes.
  // Keep the static campaign semantics aligned with the actual product category.
  if (banner.id === '42') {
    return { keyword: '短袜', categoryId: '1191110004' }
  }

  const categoryId: string = getBannerCategoryId(banner.hrefUrl)
  if (categoryId === '1181622003') {
    return { keyword: '箱包手袋', categoryId }
  }
  if (categoryId === '1181622001') {
    return { keyword: '气质女装', categoryId }
  }
  return undefined
}

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

interface GuessLikeParams {
  page: number
}

// 猜你喜欢分页数据，供 HDMGuess 组件通过 loader 注入使用
export const getGuessLikeAPI = (page: number) => {
  return RequestAxios.get<GoodsItems>("/home/goods/guessLike", { page } as GuessLikeParams)
}

export function uniqueGoodsById(items: HDMGoodsItem[]): HDMGoodsItem[] {
  const ids: Set<string> = new Set<string>()
  return items.filter((item: HDMGoodsItem): boolean => {
    if (ids.has(item.id)) {
      return false
    }
    ids.add(item.id)
    return true
  })
}

async function fetchGoodsDetail(goodsId: string): Promise<Goods> {
  const params: GoodsDetailParams = { id: goodsId }
  const detail: Goods = await RequestAxios.getSilent<Goods>('/goods', params)
  if (!detail || detail.id !== goodsId) {
    throw new Error('商品详情与入口商品不匹配')
  }
  return detail
}

async function requestGoodsDetail(goodsId: string): Promise<Goods> {
  const cachedRequest: Promise<Goods> | undefined = goodsDetailCache.get(goodsId)
  if (cachedRequest) {
    return cachedRequest
  }

  const request: Promise<Goods> = fetchGoodsDetail(goodsId)
  goodsDetailCache.set(goodsId, request)
  try {
    return await request
  } catch {
    // Failed requests remain retryable instead of poisoning this session's cache.
    goodsDetailCache.delete(goodsId)
    throw new Error('商品详情请求失败')
  }
}

export const searchGoodsAPI = (data: object) => {
  return RequestAxios.post<SearchResult>('/search/all', data)
}

export const getGoodsEvaluationsAPI = (
  goodsId: string,
  page: number = 1,
  pageSize: number = 2
) => {
  const params: GoodsEvaluationParams = { page, pageSize }
  return RequestAxios.get<GoodsEvaluationPage>(`/goods/${goodsId}/evaluate/page`, params)
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

interface GoodsEvaluationParams {
  page: number
  pageSize: number
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
