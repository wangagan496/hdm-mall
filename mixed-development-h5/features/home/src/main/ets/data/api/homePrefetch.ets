import { CategoryItem, GoodsItems, HDMGoodsItem } from 'models'
import { preloadImages } from 'utils'
import { Banner, HotResult } from '../../domain/models'
import {
  getBannerAPI,
  getCategoryAPI,
  getHomeNewAPI,
  getHotResultAPI,
  getInVogueAPI,
  getOneStopAPI,
  getRecommendPageAPI
} from './home'

export interface HomeCoreRequests {
  bannerRequest: Promise<Banner[]>
  categoryRequest: Promise<CategoryItem[]>
  hotRequest: Promise<HotResult>
  inVogueRequest: Promise<HotResult>
  oneStopRequest: Promise<HotResult>
  newGoodsRequest: Promise<HDMGoodsItem[]>
  recommendRequest: Promise<GoodsItems>
}

/**
 * 冷启动预加载：在 Ability onCreate 阶段就发出首页六个首屏请求，
 * 与 HSP 加载、Navigation/Tabs 构建并行执行，缩短首屏网络等待。
 * HomeView 挂载后通过 take() 取走在途请求；预加载未启动时 take()
 * 返回 null，调用方现场发请求，行为与优化前一致。
 */
export class HomePrefetch {
  private static requests: HomeCoreRequests | null = null

  static start(): void {
    if (HomePrefetch.requests) {
      return
    }
    const bannerRequest: Promise<Banner[]> = getBannerAPI()
    const categoryRequest: Promise<CategoryItem[]> = getCategoryAPI()
    const hotRequest: Promise<HotResult> = getHotResultAPI()
    const inVogueRequest: Promise<HotResult> = getInVogueAPI()
    const oneStopRequest: Promise<HotResult> = getOneStopAPI()
    const newGoodsRequest: Promise<HDMGoodsItem[]> = getHomeNewAPI()
    const recommendRequest: Promise<GoodsItems> = getRecommendPageAPI(1)
    // 接口一返回就预加载首批图片，与页面创建并行；不等待图片下载完成。
    // 这里处理失败不改变原请求，页面仍能拿到原始成功／失败结果。
    bannerRequest.then((banners: Banner[]): void => {
      preloadImages(banners.map((banner: Banner): string => banner.imgUrl))
    }).catch((): void => {})
    categoryRequest.then((categories: CategoryItem[]): void => {
      preloadImages(categories.map((category: CategoryItem): ResourceStr => category.picture))
    }).catch((): void => {})
    hotRequest.catch((): void => {})
    inVogueRequest.catch((): void => {})
    oneStopRequest.catch((): void => {})
    newGoodsRequest.catch((): void => {})
    recommendRequest.catch((): void => {})
    HomePrefetch.requests = {
      bannerRequest,
      categoryRequest,
      hotRequest,
      inVogueRequest,
      oneStopRequest,
      newGoodsRequest,
      recommendRequest
    }
  }

  static take(): HomeCoreRequests | null {
    const requests: HomeCoreRequests | null = HomePrefetch.requests
    HomePrefetch.requests = null
    return requests
  }
}

export function homePrefetchStart(): void {
  HomePrefetch.start()
}
