import { CategoryItem, HDMGoodsItem } from 'models'
import { Banner, HotResult, RecommendParams } from '../../domain/models'
import {
  getBannerAPI,
  getCategoryAPI,
  getHomeNewAPI,
  getHotResultAPI,
  getInVogueAPI,
  getOneStopAPI,
  getRecommendAPI
} from './home'

export interface HomeCoreRequests {
  bannerRequest: Promise<Banner[]>
  categoryRequest: Promise<CategoryItem[]>
  hotRequest: Promise<HotResult>
  inVogueRequest: Promise<HotResult>
  oneStopRequest: Promise<HotResult>
  newGoodsRequest: Promise<HDMGoodsItem[]>
  recommendRequest: Promise<HDMGoodsItem[]>
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
    const recommendRequest: Promise<HDMGoodsItem[]> =
      getRecommendAPI({ limit: 8 } as RecommendParams)
    // 预挂空 catch：HomeView 挂载前请求失败不产生未处理的 Promise 拒绝，
    // 消费方后续仍能按原逻辑拿到 rejected 状态并走兜底。
    bannerRequest.catch((): void => {})
    categoryRequest.catch((): void => {})
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
