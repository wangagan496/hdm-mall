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
  fillPromotionGoods,
  getDistinctGoods
} from '../../data/api'
import { HDMDiscountGoods } from '../components'
import { Banner, Params, DiscountType, RecommendParams } from '../../domain/models'
import { emitter } from '@kit.BasicServicesKit'
import { common } from '@kit.AbilityKit'
import { storeManager } from 'storage'

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
    const saleGoods: HDMGoodsItem[] = result[2].status === "fulfilled" ?
      result[2].value?.subTypes?.[0]?.goodsItems?.items || [] : []
    const hotGoods: HDMGoodsItem[] = result[3].status === "fulfilled" ?
      result[3].value?.subTypes?.[0]?.goodsItems?.items || [] : []
    const oneGoods: HDMGoodsItem[] = result[4].status === "fulfilled" ?
      result[4].value?.subTypes?.[0]?.goodsItems?.items || [] : []
    const newGoods: HDMGoodsItem[] = result[5].status === "fulfilled" ? result[5].value : []

    const promotionLimit: number = 4
    const selectedSaleGoods: HDMGoodsItem[] =
      getDistinctGoods(saleGoods, newGoods, [hotGoods, oneGoods], promotionLimit)
    const saleAndNewGoods: HDMGoodsItem[] = newGoods.concat(selectedSaleGoods)
    const selectedHotGoods: HDMGoodsItem[] =
      getDistinctGoods(hotGoods, saleAndNewGoods, [oneGoods, saleGoods], promotionLimit)
    const promotedGoods: HDMGoodsItem[] = selectedSaleGoods.concat(selectedHotGoods)
    const reservedGoods: HDMGoodsItem[] = newGoods.concat(promotedGoods)
    const distinctOneGoods: HDMGoodsItem[] =
      getDistinctGoods(oneGoods, reservedGoods, [hotGoods, saleGoods], promotionLimit)
    const selectedOneGoods: HDMGoodsItem[] = fillPromotionGoods(distinctOneGoods, oneGoods, promotionLimit)

    this.saleGoods = selectedSaleGoods
    if (this.saleGoods.length > 0) {
      this.pushImageToCard(this.saleGoods)
    }
    this.hotGoods = selectedHotGoods
    this.oneGoods = selectedOneGoods
    const displayedGoods: HDMGoodsItem[] = promotedGoods.concat(selectedOneGoods)
    this.newGoods = getDistinctGoods(newGoods, displayedGoods, [])

    this.loading = false
  }

  async pushImageToCard(list: HDMGoodsItem[]) {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext
    const fileList = await downLoadManager.downLoadImages(context, list.map(item => item.picture as string))
    pushCardManager.pushImageToCard(fileList, storeManager.getFormId())
  }

  async getRecommend() {
    const list = await getRecommendAPI({ limit: this.page * 8 } as RecommendParams)
    this.recommendDataSource.loadData(list)
    if (list.length === this.page * 8) {
      this.page++
    } else {
      this.isFinished = true
    }
  }

  @Builder
  DiscountBuilder(params: Params) {
    Column() {
      Row({ space: 10 }) {
        Text(params.title)
          .fontColor($r('[ui_components].color.black'))
          .fontSize(14)
        Text(params.subTitle)
          .fontColor($r('[ui_components].color.text'))
          .fontSize(11)
      }
      .width('100%')
      .margin({ bottom: 10 })

      List({ space: 10 }) {
        ForEach(params.list, (item: HDMGoodsItem) => {
          ListItem() {
            HDMDiscountGoods({ type: DiscountType.DISCOUNT, goods: item })
          }
          .onClick(() => {
            this.stackPath.pushPath({
              name: PAGE_PATH.GOODS_PAGE,
              param: item
            })
          })
        })
      }
      .width('100%')
      .height(116)
      .scrollBar(BarState.Off)
      .listDirection(Axis.Horizontal)
    }
    .height(160)
    .layoutWeight(1)
    .padding(10)
    .backgroundColor(params.bg)
    .borderRadius(8)
  }

  @Builder
  getRefreshBuilder() {
    Row() {
      HDMProgressLoading({ loadingWidth: 30 })
    }
    .justifyContent(FlexAlign.Center)
    .width("100%")
  }

  @Builder
  BannerSectionBuilder() {
    Swiper() {
      ForEach(this.banners, (item: Banner) => {
        Image(item.imgUrl)
      })
    }
    .displayCount(
      new BreakPointType({ sm: 1, md: 2, lg: 3 }).getValue(this.breakPoint)
    )
    .itemSpace(
      new BreakPointType({ sm: 0, md: 10, lg: 20 }).getValue(this.breakPoint)
    )
    .indicator(
      this.breakPoint === BreakPointEnum.sm ?
        DotIndicator.dot()
          .itemWidth(8).itemHeight(4).color('#33191919')
          .selectedItemWidth(24).selectedItemHeight(4).selectedColor('#191919') : false
    )
  }

  @Builder
  CategorySectionBuilder() {
    List({
      space: new BreakPointType({ sm: 14, md: 36, lg: 72 }).getValue(this.breakPoint)
    }) {
      ForEach(this.categories, (item: CategoryItem) => {
        ListItem() {
          Column() {
            Image(item.picture)
              .width(56)
              .aspectRatio(1)
            Text(item.name)
              .fontSize(10)
              .fontColor('#CC191919')
          }
          .width(60).height(80).borderRadius(30).clip(true)
          .backgroundImage(item.picture)
          .backgroundImageSize(ImageSize.Contain)
          .backgroundImagePosition(Alignment.Center)
          .backgroundBlurStyle(BlurStyle.BACKGROUND_ULTRA_THICK, { scale: 0.25 })
        }
        .onClick(() => {
          AppStorage.setOrCreate('currentTabIndex', 1)
        })
      })
    }
    .width('100%').height(92).scrollBar(BarState.Off)
    .listDirection(Axis.Horizontal).alignListItem(ListItemAlign.Center)
  }

  @Builder
  SaleGoodsSectionBuilder() {
    Column({ space: 10 }) {
      Image($r('app.media.home_cmd_title'))
        .width(150).height(20)
      Row() {
        Image($r('app.media.home_cmd_inner'))
          .width(86).height(116)
        List({
          space: new BreakPointType({ sm: 14, md: 36, lg: 72 }).getValue(this.breakPoint)
        }) {
          ForEach(this.saleGoods, (item: HDMGoodsItem) => {
            ListItem() {
              HDMDiscountGoods({ goods: item })
            }
            .onClick(() => {
              this.stackPath.pushPath({ name: PAGE_PATH.GOODS_PAGE, param: item })
            })
          })
        }
        .layoutWeight(1).width('100%').height(116)
        .backgroundColor($r('[ui_components].color.white'))
        .borderRadius({ topRight: 8, bottomRight: 8 })
        .padding({ right: 10, left: 10 })
        .scrollBar(BarState.Off).listDirection(Axis.Horizontal)
      }
    }
    .width('100%').height(166)
    .backgroundImage($r('app.media.home_cmd_sm'))
    .backgroundImageSize(ImageSize.Cover)
    .borderRadius(8).padding(10)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  NewGoodsSectionBuilder() {
    Column({ space: 10 }) {
      Image($r('app.media.home_new'))
        .width(146).height(19)
      List({
        space: new BreakPointType({ sm: 14, md: 36, lg: 72 }).getValue(this.breakPoint)
      }) {
        ForEach(this.newGoods, (item: HDMGoodsItem) => {
          ListItem() {
            HDMDiscountGoods({ type: DiscountType.NEW, goods: item })
          }
          .onClick(() => {
            this.stackPath.pushPath({ name: PAGE_PATH.GOODS_PAGE, param: item })
          })
        })
      }
      .width('100%').height(116).scrollBar(BarState.Off).listDirection(Axis.Horizontal)
    }
    .width('100%').height(156).padding(10)
    .backgroundColor('#F7EFF5').borderRadius(8)
    .alignItems(HorizontalAlign.Start)
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
                this.BannerSectionBuilder()
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
                this.CategorySectionBuilder()
                this.SaleGoodsSectionBuilder()
                Row({ space: 10 }) {
                  this.DiscountBuilder({
                    title: '爆款推荐', subTitle: '最受欢迎', bg: '#EDF1FB', list: this.hotGoods
                  })
                  this.DiscountBuilder({
                    title: '一站买全', subTitle: '精心优选', bg: '#FCF6EA', list: this.oneGoods
                  })
                }
                this.NewGoodsSectionBuilder()
                WaterFlow() {
                  LazyForEach(this.recommendDataSource, (item: HDMGoodsItem) => {
                    FlowItem() {
                      HDMGoods({ goods: item })
                    }
                  })
                }
                .columnsTemplate(new BreakPointType({ sm: "1fr 1fr", md: "1fr 1fr 1fr", lg: "1fr 1fr 1fr 1fr" }).getValue(this.breakPoint))
                .columnsGap(8)
                .rowsGap(10)
              }
              .padding({ left: 8, right: 8, bottom: 10, top: 10 })
            }
          }
          .scrollBar(BarState.Off)
          .onDidScroll((_xOffset: number, yOffset: number,) => {
            this.yOffset += yOffset
            if (this.yOffset > this.topHeight && this.yOffset < (this.topHeight + 40)) {
              this.searchOpacity = (this.yOffset - this.topHeight) / 40
            } else if (this.yOffset >= (this.topHeight + 40)) {
              this.searchOpacity = 1
            } else {
              this.searchOpacity = 0
            }
          })
          .onReachEnd(async () => {
            if (!this.isReachLoad && !this.isFinished) {
              this.isReachLoad = true
              await this.getRecommend()
              this.isReachLoad = false
            }
          })
        }
        .onRefreshing(async () => {
          await this.getHomeData(true)
          this.page = 1
          this.yOffset = 0
          this.recommendDataSource.loadData([])
          this.isFinished = false
          this.isReachLoad = false
          this.isRefreshing = false
        })
      }

      Row() {
        Row({ space: 4 }) {
          Image($r('[ui_components].media.ic_public_search'))
            .width(16)
            .height(16)
            .fillColor($r('[ui_components].color.white'))
          Text('搜索...')
            .fontSize(14)
            .fontColor($r('[ui_components].color.white'))
        }
        .backgroundColor('#33191919')
        .width('100%')
        .height(40)
        .borderRadius(20)
        .padding({ left: 12 })
        .onClick(() => {
          this.stackPath.pushPath({ name: PAGE_PATH.SEARCH_PAGE })
        })
      }
      .padding({ left: 16, right: 16, top: this.topHeight, bottom: this.topHeight })
      .opacity(this.searchOpacity)
      .backgroundColor($r("[ui_components].color.white"))
      .linearGradient({
        direction: GradientDirection.Bottom,
        colors: [["#ffdebfee", 0], [$r("[ui_components].color.white"), 1]]
      })

      if (this.yOffset > 100) {
        Row() {
          Image($r("app.media.home_top"))
            .width(30)
            .aspectRatio(1)
            .fillColor("#0095d3")
        }
        .justifyContent(FlexAlign.Center)
        .width(40)
        .aspectRatio(1)
        .borderRadius(20)
        .backgroundColor("#fff8f9fa")
        .alignRules({
          right: { anchor: '__container__', align: HorizontalAlign.End },
          bottom: { anchor: '__container__', align: VerticalAlign.Bottom }
        })
        .margin({ right: 20, bottom: 80 })
        .onClick(() => {
          this.scroller.scrollEdge(Edge.Top)
        })
      }
    }
  }
}
