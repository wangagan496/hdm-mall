import { BusinessVariable, GlobalVariable, PAGE_PATH } from 'constants'
import { BreakPointEnum, BreakPointType, CategoryItem, HDMGoodsItem, ListDataSource } from 'models'
import { HDMGoods, HDMLoadingText, HDMProgressLoading } from 'ui_components'
import { downLoadManager, pushCardManager } from 'utils'
import {
  getBannerAPI,
  getCategoryAPI,
  getHomeNewAPI,
  getHotResultAPI,
  getInVogueAPI,
  getOneStopAPI,
  getRecommendAPI,
  normalizeGoodsSummaryPicturesAPI,
  fillPromotionGoods,
  getDistinctGoods
} from '../../data/api'
import {
  HomeBannerSection,
  HomeCategorySection,
  HomeSaleGoodsSection,
  HomeNewGoodsSection,
  HomeDiscountSection,
  DiscountSectionParams
} from '../components'
import { Banner, RecommendParams } from '../../domain/models'
import { emitter } from '@kit.BasicServicesKit'
import { common } from '@kit.AbilityKit'
import { storeManager } from 'storage'
import { HomeGoodsDeduplication } from '../utils/HomeGoodsDeduplication'

@Component
export struct HomeView {
  @StorageProp(GlobalVariable.BREAK_POINT_KEY)
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
  @State searchOpacity: number = 0
  @State yOffset: number = 0
  @State loading: boolean = false
  @State isReachLoad: boolean = false
  @State isFinished: boolean = false
  @State isRefreshing: boolean = false
  page: number = 1
  scroller: Scroller = new Scroller()
  @Consume stackPath: NavPathStack

  aboutToAppear() {
    this.getHomeData()
    this.registerEvent()
    this.getRecommend()
  }

  private homeDataCb: () => void = () => {
    this.getHomeData()
  }

  registerEvent() {
    emitter.on(BusinessVariable.UPDATE_HOME_DATA, this.homeDataCb)
  }

  aboutToDisappear(): void {
    emitter.off(BusinessVariable.UPDATE_HOME_DATA, this.homeDataCb)
  }

  async getHomeData(again?: boolean) {
    if (!again) {
      this.loading = true
    }

    const result = await Promise.allSettled([
      getBannerAPI(), getCategoryAPI(), getHotResultAPI(),
      getInVogueAPI(), getOneStopAPI(), getHomeNewAPI()
    ])

    if (result[0].status === "fulfilled") {
      this.banners = result[0].value
    }
    if (result[1].status === "fulfilled") {
      this.categories = result[1].value
      AppStorage.setOrCreate(BusinessVariable.CATEGORY_DATA, this.categories)
    }
    const saleGoodsRaw: HDMGoodsItem[] = result[2].status === "fulfilled" ?
      result[2].value?.subTypes?.[0]?.goodsItems?.items || [] : []
    const hotGoodsRaw: HDMGoodsItem[] = result[3].status === "fulfilled" ?
      result[3].value?.subTypes?.[0]?.goodsItems?.items || [] : []
    const oneGoodsRaw: HDMGoodsItem[] = result[4].status === "fulfilled" ?
      result[4].value?.subTypes?.[0]?.goodsItems?.items || [] : []
    const newGoodsRaw: HDMGoodsItem[] = result[5].status === "fulfilled" ? result[5].value : []

    const deduplicatedGoods = HomeGoodsDeduplication.processHomeGoods(
      saleGoodsRaw,
      hotGoodsRaw,
      oneGoodsRaw,
      newGoodsRaw,
      getDistinctGoods,
      fillPromotionGoods
    )

    const normalizedPromotions: HDMGoodsItem[][] = await Promise.all([
      normalizeGoodsSummaryPicturesAPI(deduplicatedGoods.saleGoods),
      normalizeGoodsSummaryPicturesAPI(deduplicatedGoods.hotGoods),
      normalizeGoodsSummaryPicturesAPI(deduplicatedGoods.oneGoods)
    ])

    this.saleGoods = normalizedPromotions[0]
    if (this.saleGoods.length > 0) {
      this.pushImageToCard(this.saleGoods)
    }
    this.hotGoods = normalizedPromotions[1]
    this.oneGoods = normalizedPromotions[2]
    this.newGoods = deduplicatedGoods.newGoods

    this.loading = false
  }

  async pushImageToCard(list: HDMGoodsItem[]) {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext
    const fileList = await downLoadManager.downLoadImages(context, list.map(item => item.picture as string))
    pushCardManager.pushImageToCard(fileList, storeManager.getFormId())
  }

  async getRecommend() {
    const list = await getRecommendAPI({ limit: this.page * 8 } as RecommendParams)
    this.recommendDataSource.loadData(await normalizeGoodsSummaryPicturesAPI(list))
    if (list.length === this.page * 8) {
      this.page++
    } else {
      this.isFinished = true
    }
  }

  @Builder
  getRefreshBuilder() {
    Row() {
      HDMProgressLoading({ loadingWidth: 30 })
    }
    .justifyContent(FlexAlign.Center)
    .width("100%")
  }

  build() {
    RelativeContainer() {
      if (this.loading) {
        HDMLoadingText({ title: 'Beautify' })
      } else {
        Refresh({ refreshing: $$this.isRefreshing, builder: this.getRefreshBuilder() }) {
          Scroll(this.scroller) {
            Column() {
              Stack({ alignContent: Alignment.Top }) {
                HomeBannerSection({ banners: this.banners })
                Row() {
                  Row({ space: 4 }) {
                    Image($r('[ui_components].media.ic_public_search'))
                      .width(16).height(16).fillColor($r('[ui_components].color.white'))
                    Text('搜索...')
                      .fontSize(14).fontColor($r('[ui_components].color.white'))
                  }
                  .backgroundColor('#33191919')
                  .width('100%').height(40).borderRadius(20).padding({ left: 12 })
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

              Column() {
                WaterFlow() {
                  LazyForEach(this.recommendDataSource, (item: HDMGoodsItem) => {
                    FlowItem() {
                      HDMGoods({ goods: item })
                    }
                    .onClick(() => {
                      this.stackPath.pushPath({
                        name: PAGE_PATH.GOODS_PAGE,
                        param: item
                      })
                    })
                  }, (item: HDMGoodsItem) => item.id)
                }
                .columnsTemplate(new BreakPointType({
                  sm: '1fr 1fr',
                  md: '1fr 1fr 1fr 1fr',
                  lg: '1fr 1fr 1fr 1fr 1fr 1fr'
                }).getValue(this.breakPoint))
                .columnsGap(10)
                .rowsGap(10)
                .padding({ left: 16, right: 16 })
                .onReachEnd(async () => {
                  if (this.isReachLoad || this.isFinished) {
                    return
                  }
                  this.isReachLoad = true
                  await this.getRecommend()
                  this.isReachLoad = false
                })
              }
              .width('100%')
              .padding({ top: 10, bottom: 10 })
            }
            .width('100%')
          }
          .width('100%')
          .height('100%')
          .align(Alignment.TopStart)
          .scrollBar(BarState.Off)
          .onDidScroll(() => {
            this.yOffset = this.scroller.currentOffset().yOffset
            this.searchOpacity = this.yOffset > 80 ? 1 : this.yOffset / 80
          })
        }
        .width('100%')
        .height('100%')
        .backgroundColor($r('[ui_components].color.under'))
        .onRefreshing(async () => {
          await this.getHomeData(true)
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
        .onClick(() => {
          this.stackPath.pushPath({ name: PAGE_PATH.SEARCH_PAGE })
        })
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
    }
    .width('100%')
    .height('100%')
  }
}
