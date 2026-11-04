import { BusinessVariable, GlobalVariable, PAGE_PATH } from 'constants'
import { BreakPointEnum, BreakPointType, CategoryItem, GoodsItems, HDMGoodsItem, ListDataSource } from 'models'
import { HDMEmpty, HDMGoods, HDMLoadingText, HDMProgressLoading } from 'ui_components'
import { downLoadManager, preloadImages, pushCardManager } from 'utils'
import {
  getBannerAPI,
  getCategoryAPI,
  getHomeNewAPI,
  getHotResultAPI,
  getInVogueAPI,
  getOneStopAPI,
  getRecommendPageAPI,
  normalizeGoodsSummaryPicturesAPI,
  fillPromotionGoods,
  getDistinctGoods,
  getBannerSearchParam,
  uniqueGoodsById
} from '../../data/api'
import {
  HomeBannerSection,
  HomeCategorySection,
  HomeSaleGoodsSection,
  HomeNewGoodsSection,
  HomeDiscountSection,
  DiscountSectionParams
} from '../components'
import { Banner, HotResult, SearchRouterParam } from '../../domain/models'
import { emitter } from '@kit.BasicServicesKit'
import { common } from '@kit.AbilityKit'
import { storeManager } from 'storage'
import { HomeGoodsDeduplication, HomeGoodsResult } from '../utils/HomeGoodsDeduplication'
import { LaunchPerf } from 'utils'
import { HomePrefetch, HomeCoreRequests } from '../../data/api/homePrefetch'

/** 头部区块（banner、分类、促销、新品）作为瀑布流的第一个分组，只有 1 个 FlowItem、独占一行 */
const HEADER_SECTION: SectionOptions = { itemsCount: 1, crossCount: 1 }
const RECOMMEND_SECTION_INDEX: number = 1

@Component
export struct HomeView {
  @StorageProp(GlobalVariable.BREAK_POINT_KEY) @Watch('onBreakPointChange')
  breakPoint: string = ""
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @State banners: Banner[] = []
  @State categories: CategoryItem[] = []
  @State saleGoods: HDMGoodsItem[] = []
  @State hotGoods: HDMGoodsItem[] = []
  @State oneGoods: HDMGoodsItem[] = []
  @State newGoods: HDMGoodsItem[] = []

  recommendDataSource: ListDataSource<HDMGoodsItem> = new ListDataSource<HDMGoodsItem>()
  /**
   * 首页只有一个滚动容器：头部区块和推荐流都是同一个 WaterFlow 的子节点，靠 sections 混排
   * （官方布局指南：相比 Scroll 嵌套 WaterFlow，sections 方案不需要处理嵌套滚动的事件传递）。
   * 约束：所有分组 itemsCount 之和必须等于实际子节点数，且要避免 itemsCount 为 0 的分组，
   * 所以推荐分组只在拿到第一批数据后才 push，之后每次追加数据都同步 update。
   */
  @State sections: WaterFlowSections = new WaterFlowSections()
  @State searchOpacity: number = 0
  @State loading: boolean = false
  @State isFinished: boolean = false
  @State isRefreshing: boolean = false
  @State refreshActive: boolean = false
  @State homeLoadFailed: boolean = false
  page: number = 1
  private homeRequestId: number = 0
  private recommendRequesting: boolean = false
  private recommendGeneration: number = 0
  private active: boolean = true
  scroller: Scroller = new Scroller()
  @Consume stackPath: NavPathStack

  private openSearch(): void {
    this.stackPath.pushPathByName(PAGE_PATH.SEARCH_PAGE, null)
  }

  private openBannerGoods(banner: Banner): void {
    const routeParam: SearchRouterParam | undefined = getBannerSearchParam(banner)
    if (!routeParam) {
      return
    }
    this.stackPath.pushPathByName(PAGE_PATH.SEARCH_RESULT_PAGE, routeParam)
  }

  private recommendColumns(): number {
    return new BreakPointType({ sm: 2, md: 4, lg: 6 }).getValue(this.breakPoint)
  }

  private buildRecommendSection(): SectionOptions {
    return {
      itemsCount: this.recommendDataSource.totalCount(),
      crossCount: this.recommendColumns(),
      columnsGap: 10,
      rowsGap: 10,
      margin: { left: 16, right: 16, top: 10, bottom: 10 }
    }
  }

  /** 数据源变化后调用：按官方要求先改数据源、再同步分组的 itemsCount。 */
  private syncRecommendSection(): void {
    if (this.recommendDataSource.totalCount() === 0) {
      if (this.sections.length() > RECOMMEND_SECTION_INDEX) {
        this.sections.splice(RECOMMEND_SECTION_INDEX, 1)
      }
      return
    }
    const section: SectionOptions = this.buildRecommendSection()
    if (this.sections.length() <= RECOMMEND_SECTION_INDEX) {
      this.sections.push(section)
    } else {
      this.sections.update(RECOMMEND_SECTION_INDEX, section)
    }
  }

  onBreakPointChange(): void {
    // sections 模式下 columnsTemplate 不生效，列数变化要更新分组的 crossCount
    this.syncRecommendSection()
  }

  aboutToAppear() {
    this.active = true
    this.recommendGeneration++
    this.recommendRequesting = false
    this.page = 1
    this.isFinished = false
    LaunchPerf.mark('homeAboutToAppear')
    this.sections.splice(0, this.sections.length(), [HEADER_SECTION])
    this.syncRecommendSection()
    // 消费 onCreate 阶段预加载的在途请求；未预加载时回退为现场发请求。
    const preloadedRequests: HomeCoreRequests | null = HomePrefetch.take()
    const recommendRequest: Promise<GoodsItems> =
      preloadedRequests ? preloadedRequests.recommendRequest :
        getRecommendPageAPI(1)
    recommendRequest.catch((): void => {})
    const generation: number = this.recommendGeneration
    this.getHomeData(false, preloadedRequests).then((): void => {
      if (this.active && generation === this.recommendGeneration) {
        this.getRecommend(recommendRequest)
      }
    })
    this.registerEvent()
  }

  private homeDataCb: () => void = () => {
    this.getHomeData()
  }

  registerEvent() {
    emitter.on(BusinessVariable.UPDATE_HOME_DATA, this.homeDataCb)
  }

  aboutToDisappear(): void {
    this.active = false
    this.homeRequestId++
    this.recommendGeneration++
    this.recommendRequesting = false
    emitter.off(BusinessVariable.UPDATE_HOME_DATA, this.homeDataCb)
  }

  // 首次进入显示整页加载；下拉刷新时保留当前内容，只显示下拉刷新提示。
  async getHomeData(keepCurrentContent: boolean = false, preloadedRequests?: HomeCoreRequests | null): Promise<void> {
    const requestId: number = ++this.homeRequestId
    if (!keepCurrentContent) {
      this.loading = true
    }

    const bannerRequest: Promise<Banner[]> =
      preloadedRequests ? preloadedRequests.bannerRequest : getBannerAPI()
    const categoryRequest: Promise<CategoryItem[]> =
      preloadedRequests ? preloadedRequests.categoryRequest : getCategoryAPI()
    const hotRequest: Promise<HotResult> =
      preloadedRequests ? preloadedRequests.hotRequest : getHotResultAPI()
    const inVogueRequest: Promise<HotResult> =
      preloadedRequests ? preloadedRequests.inVogueRequest : getInVogueAPI()
    const oneStopRequest: Promise<HotResult> =
      preloadedRequests ? preloadedRequests.oneStopRequest : getOneStopAPI()
    const newGoodsRequest: Promise<HDMGoodsItem[]> =
      preloadedRequests ? preloadedRequests.newGoodsRequest : getHomeNewAPI()

    // 核心首屏内容单独到达即可解除全屏 Loading，避免被推荐/促销接口拖住。
    // 失败时仍交给下面的 allSettled 统一处理，不会产生未捕获 Promise。
    let coreContentShown: boolean = false
    const showCoreContent = (): void => {
      if (!coreContentShown && requestId === this.homeRequestId) {
        coreContentShown = true
        this.loading = false
        LaunchPerf.mark('homeCoreContentLoaded')
        LaunchPerf.report()
      }
    }
    bannerRequest.then((value: Banner[]): void => {
      if (requestId === this.homeRequestId) {
        if (!preloadedRequests) {
          preloadImages(value.map((banner: Banner): string => banner.imgUrl))
        }
        this.banners = value
        showCoreContent()
      }
    }, (): void => {})
    categoryRequest.then((value: CategoryItem[]): void => {
      if (requestId === this.homeRequestId) {
        if (!preloadedRequests) {
          preloadImages(value.map((category: CategoryItem): ResourceStr => category.picture))
        }
        this.categories = value
        AppStorage.setOrCreate(BusinessVariable.CATEGORY_DATA, value)
        showCoreContent()
      }
    }, (): void => {})

    const result = await Promise.allSettled([
      bannerRequest, categoryRequest, hotRequest,
      inVogueRequest, oneStopRequest, newGoodsRequest
    ])

    if (requestId !== this.homeRequestId) {
      return
    }

    this.homeLoadFailed = result.every((item: PromiseSettledResult<Banner[] | CategoryItem[] | HotResult | HDMGoodsItem[]>): boolean => item.status === 'rejected')
    if (keepCurrentContent && this.homeLoadFailed) {
      this.loading = false
      return
    }

    // 与上方请求一一对应，用业务名称读取结果，避免靠记忆猜 result[2] 是哪个区块。
    const bannerResult = result[0]
    const categoryResult = result[1]
    const saleGoodsResult = result[2]
    const hotGoodsResult = result[3]
    const oneStopResult = result[4]
    const newGoodsResult = result[5]
    if (bannerResult.status === "fulfilled") {
      this.banners = bannerResult.value
    }
    if (categoryResult.status === "fulfilled") {
      this.categories = categoryResult.value
      AppStorage.setOrCreate(BusinessVariable.CATEGORY_DATA, this.categories)
    }
    const saleGoodsRaw: HDMGoodsItem[] = this.getPromotionGoodsOrEmpty(saleGoodsResult)
    const hotGoodsRaw: HDMGoodsItem[] = this.getPromotionGoodsOrEmpty(hotGoodsResult)
    const oneGoodsRaw: HDMGoodsItem[] = this.getPromotionGoodsOrEmpty(oneStopResult)
    const newGoodsRaw: HDMGoodsItem[] = newGoodsResult.status === "fulfilled" ? newGoodsResult.value : []

    const deduplicatedGoods = HomeGoodsDeduplication.processHomeGoods(
      saleGoodsRaw,
      hotGoodsRaw,
      oneGoodsRaw,
      newGoodsRaw,
      getDistinctGoods,
      fillPromotionGoods
    )

    // 先显示已取到的商品，再后台校正图片，避免用户一直等在加载画面。
    preloadImages(deduplicatedGoods.newGoods.map((item: HDMGoodsItem): ResourceStr => item.picture))
    this.saleGoods = deduplicatedGoods.saleGoods
    this.hotGoods = deduplicatedGoods.hotGoods
    this.oneGoods = deduplicatedGoods.oneGoods
    this.newGoods = deduplicatedGoods.newGoods
    this.loading = false
    void this.normalizePromotionPictures(deduplicatedGoods, requestId).catch(() => {
    })
  }

  // 促销接口把商品放在第一个子分类下；请求失败或没有该分类时按空列表处理。
  private getPromotionGoodsOrEmpty(result: PromiseSettledResult<HotResult>): HDMGoodsItem[] {
    if (result.status === 'rejected') {
      return []
    }
    return result.value?.subTypes?.[0]?.goodsItems?.items || []
  }

  private async normalizePromotionPictures(goods: HomeGoodsResult, requestId: number): Promise<void> {
    const normalizedPromotions: HDMGoodsItem[][] = await Promise.all([
      normalizeGoodsSummaryPicturesAPI(goods.saleGoods),
      normalizeGoodsSummaryPicturesAPI(goods.hotGoods),
      normalizeGoodsSummaryPicturesAPI(goods.oneGoods)
    ])

    if (requestId !== this.homeRequestId) {
      return
    }

    // 只预加载校正后的图片网址，避免为即将被替换的旧网址额外下载。
    for (const promotionGoods of normalizedPromotions) {
      preloadImages(promotionGoods.map((item: HDMGoodsItem): ResourceStr => item.picture))
    }
    this.saleGoods = normalizedPromotions[0]
    if (this.saleGoods.length > 0) {
      void this.pushImageToCard(this.saleGoods).catch(() => {
        // 服务卡片推送失败不影响首页展示
      })
    }
    this.hotGoods = normalizedPromotions[1]
    this.oneGoods = normalizedPromotions[2]
  }

  private cardImageSequence: number = 0

  async pushImageToCard(list: HDMGoodsItem[]): Promise<void> {
    const sequence: number = ++this.cardImageSequence
    const formIdList: string[] = storeManager.getFormId()
    if (formIdList.length === 0) {
      // 没有添加过服务卡片时不必下载图片
      return
    }
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext
    const fileList = await downLoadManager.downLoadImages(context, list.map(item => item.picture as string))
    try {
      if (sequence !== this.cardImageSequence) {
        return
      }
      await pushCardManager.pushImageToCard(fileList, formIdList)
    } finally {
      downLoadManager.releaseImages(fileList)
    }
  }

  private async refreshRecommendations(): Promise<void> {
    this.recommendGeneration++
    this.recommendRequesting = false
    this.page = 1
    this.isFinished = false
    await this.getRecommend()
  }

  async getRecommend(preloadedRequest?: Promise<GoodsItems>) {
    if (!this.active || this.recommendRequesting || this.isFinished) {
      return
    }
    const generation: number = this.recommendGeneration
    this.recommendRequesting = true
    try {
      let newItems: HDMGoodsItem[] = []
      do {
        const requestedPage: number = this.page
        const result: GoodsItems = await (
          preloadedRequest || getRecommendPageAPI(requestedPage)
        )
        preloadedRequest = undefined
        if (!this.active || generation !== this.recommendGeneration) { return }
        const list: HDMGoodsItem[] = uniqueGoodsById(result.items)
        const displayedGoods: HDMGoodsItem[] = this.newGoods.concat(this.saleGoods, this.hotGoods, this.oneGoods)
        for (let index = 0; requestedPage > 1 && index < this.recommendDataSource.totalCount(); index++) {
          displayedGoods.push(this.recommendDataSource.getData(index))
        }
        newItems = getDistinctGoods(list, displayedGoods, [], list.length)
        const normalizedItems: HDMGoodsItem[] = await normalizeGoodsSummaryPicturesAPI(newItems)
        if (!this.active || generation !== this.recommendGeneration) { return }
        if (requestedPage === 1) {
          this.recommendDataSource.loadData(normalizedItems)
        } else if (normalizedItems.length > 0) {
          this.recommendDataSource.addArr(normalizedItems)
        }
        if (normalizedItems.length > 0) {
          preloadImages(normalizedItems.map((item: HDMGoodsItem): ResourceStr => item.picture))
        }
        this.syncRecommendSection()
        if (requestedPage >= result.pages) {
          this.isFinished = true
          break
        }
        this.page++
      } while (newItems.length === 0 && !this.isFinished)
    } catch (_) {
      // 推荐区不是首屏阻塞内容，请求失败后保留重试能力。
    } finally {
      if (generation === this.recommendGeneration) { this.recommendRequesting = false }
    }
  }

  @Builder
  getRefreshBuilder() {
    Row() {
      // 只在下拉/刷新期间创建 loading 环：静止时 Refresh 把 builder 收在内容上方，但环的下沿仍会露出约 25px，
      // 而且 HDMProgressLoading 内部的 100ms 定时器和无限旋转动画会一直跑。
      if (this.refreshActive) {
        HDMProgressLoading({ loadingWidth: 30 })
      }
    }
    .justifyContent(FlexAlign.Center)
    .width("100%")
    .height(40)
  }

  @Builder
  HomeHeader() {
    Column() {
      Stack({ alignContent: Alignment.Top }) {
        HomeBannerSection({
          banners: this.banners,
          onBannerClick: (banner: Banner): void => this.openBannerGoods(banner)
        })
        Row() {
          Row({ space: 4 }) {
            Image($r('[ui_components].media.ic_public_search'))
              .width(16).height(16).fillColor($r('[ui_components].color.white'))
            Text('搜索...')
              .fontSize(14).fontColor($r('[ui_components].color.white'))
          }
          .backgroundColor('#33191919')
          .width('100%').height(40).borderRadius(20).padding({ left: 12 })
          .focusable(true)
          .accessibilityText('搜索商品')
          .onClick(() => this.openSearch())
        }
        .padding({ left: 16, right: 16, top: this.topHeight })
      }
      .width('100%')

      Column({ space: 10 }) {
        HomeCategorySection({ categories: this.categories })
        HomeSaleGoodsSection({ saleGoods: this.saleGoods })
        Row({ space: 10 }) {
          HomeDiscountSection({
            params: {
              title: '爆款推荐', subTitle: '最受欢迎', bg: '#EDF1FB', list: this.hotGoods
            } as DiscountSectionParams
          })
          HomeDiscountSection({
            params: {
              title: '一站买全', subTitle: '精心优选', bg: '#FCF6EA', list: this.oneGoods
            } as DiscountSectionParams
          })
        }
        HomeNewGoodsSection({ newGoods: this.newGoods })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 10 })
    }
    .width('100%')
  }

  build() {
    RelativeContainer() {
      if (this.loading) {
        HDMLoadingText({ title: '惠多美商城' })
      } else {
        Refresh({ refreshing: $$this.isRefreshing, builder: this.getRefreshBuilder() }) {
          // 单一滚动容器：第 0 组是头部（1 个 FlowItem 独占一行），第 1 组是推荐流（按断点 2/4/6 列）。
          // 头部和推荐商品都是这个 WaterFlow 的子节点，推荐商品由 LazyForEach 按可视区按需创建。
          WaterFlow({ scroller: this.scroller, sections: this.sections }) {
            FlowItem() {
              this.HomeHeader()
            }
            .width('100%')

            LazyForEach(this.recommendDataSource, (item: HDMGoodsItem) => {
              // sections 模式下 FlowItem 必须显式给宽度，否则子组件的百分比宽度会以整个 WaterFlow 为基准而溢出列宽
              FlowItem() {
                HDMGoods({ goods: item })
              }
              .width('100%')
            }, (item: HDMGoodsItem) => item.id)
          }
          .width('100%')
          .height('100%')
          .cachedCount(4)
          .scrollBar(BarState.Off)
          .onReachEnd(() => {
            if (!this.isFinished) {
              void this.getRecommend()
            }
          })
          .onDidScroll(() => {
            // 只在透明度真正变化时写状态，避免滚动的每一帧都触发整页重绘
            const yOffset: number = this.scroller.currentOffset().yOffset
            const nextOpacity: number = yOffset > 80 ? 1 : yOffset / 80
            if (nextOpacity !== this.searchOpacity) {
              this.searchOpacity = nextOpacity
            }
          })
        }
        .width('100%')
        .height('100%')
        .backgroundColor($r('[ui_components].color.under'))
        .onStateChange((state: RefreshStatus) => {
          // Done 表示"刷新结束、已回到初始位置"，之后不一定再回调 Inactive，只把下拉中/刷新中视为活跃
          this.refreshActive = state === RefreshStatus.Drag
            || state === RefreshStatus.OverDrag
            || state === RefreshStatus.Refresh
        })
        .onRefreshing(async () => {
          await this.getHomeData(true)
          if (this.active) { await this.refreshRecommendations() }
          this.isRefreshing = false
        })
      }

      Row() {
        Row({ space: 4 }) {
          Image($r('[ui_components].media.ic_public_search'))
            .width(16).height(16).fillColor($r('[ui_components].color.white'))
          Text('搜索...')
            .fontSize(14).fontColor($r('[ui_components].color.white'))
        }
        .backgroundColor($r('[ui_components].color.red'))
        .width('100%').height(40).borderRadius(20).padding({ left: 12 })
        .focusable(true)
        .accessibilityText('搜索商品')
        .onClick(() => this.openSearch())
      }
      .width('100%')
      .height(40)
      .padding({ left: 16, right: 16, top: this.topHeight + 10 })
      .opacity(this.searchOpacity)
      .id('search_bar')
      .alignRules({
        top: { anchor: '__container__', align: VerticalAlign.Top },
        left: { anchor: '__container__', align: HorizontalAlign.Start }
      })

      if (this.homeLoadFailed) {
        Column() {
          HDMEmpty({
            tip: '首页内容加载失败，请检查网络后重试',
            buttonText: '重新加载',
            onBtnClick: (): void => {
              void this.getHomeData(true)
            }
          })
        }
        .width('100%')
        .height('100%')
        .backgroundColor($r('[ui_components].color.under'))
        .align(Alignment.Center)
      }
    }
    .width('100%')
    .height('100%')
  }
}
