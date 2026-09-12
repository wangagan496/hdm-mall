import { HDMGoodsItem, GoodsItems, ListDataSource, BreakPointType } from 'models'
import { HDMGoods } from './HDMGoods'
import { GlobalVariable } from 'constants'

/** 分页拉取"猜你喜欢"数据，由业务模块提供实现。 */
export type GuessLoader = (page: number) => Promise<GoodsItems>

const EMPTY_GUESS_PAGE: GoodsItems = {
  counts: 0,
  items: [],
  page: 1,
  pages: 0,
  pageSize: 0
}

@Component
export struct HDMGuess {
  @StorageProp(GlobalVariable.BREAK_POINT_KEY)
  breakPoint: string = ""
  /**
   * 数据源由调用方注入：公共 UI 组件只负责展示与分页节奏，不直接依赖网络层和具体接口路径，
   * 这样 ui-components 不需要反向依赖 network，也便于在测试里替换数据。
   */
  loader: GuessLoader = (): Promise<GoodsItems> => Promise.resolve(EMPTY_GUESS_PAGE)
  inset: boolean = false
  @State loadFailed: boolean = false
  lazyDataSource: ListDataSource<HDMGoodsItem> = new ListDataSource()
  private loading: boolean = false
  private page: number = 1
  private allPage: number = 1

  aboutToAppear(): void {
    void this.getGuess()
  }

  private hasMore(): boolean {
    return this.page <= this.allPage
  }

  async getGuess(): Promise<void> {
    if (this.loading || !this.hasMore()) {
      return
    }
    this.loading = true
    try {
      const result: GoodsItems = await this.loader(this.page)
      this.lazyDataSource.addArr(result.items)
      this.allPage = result.pages
      // 只有成功后才推进页码，失败时下一次触底重新拉同一页
      this.page++
      if (this.loadFailed) {
        this.loadFailed = false
      }
    } catch {
      this.loadFailed = true
    } finally {
      this.loading = false
    }
  }

  build() {
    Column() {
      Row() {
        Text("猜你喜欢")
          .fontColor($r("app.color.black"))
          .fontSize(this.inset ? 16 : 14)
          .fontWeight(this.inset ? FontWeight.Medium : FontWeight.Normal)
      }
      .height(this.inset ? 48 : 50)
      .width("100%")
      .justifyContent(FlexAlign.Center)
      .backgroundColor(this.inset ? $r("app.color.under") : $r("app.color.white"))

      WaterFlow() {
        LazyForEach(this.lazyDataSource, (item: HDMGoodsItem) => {
          FlowItem() {
            HDMGoods({ goods: item })
          }
        }, (item: HDMGoodsItem) => item.id)
      }
      .cachedCount(4)
      .layoutWeight(1)
      .nestedScroll({
        scrollForward: NestedScrollMode.PARENT_FIRST,
        scrollBackward: NestedScrollMode.SELF_FIRST
      })
      .columnsTemplate(
        new BreakPointType({
          sm: '1fr 1fr',
          md: '1fr 1fr 1fr',
          lg: '1fr 1fr 1fr 1fr'
        }).getValue(this.breakPoint)
      )
      .columnsGap(10)
      .rowsGap(10)
      .padding({ left: this.inset ? 12 : 0, right: this.inset ? 12 : 0 })
      .onReachEnd(() => {
        void this.getGuess()
      })

      if (this.loadFailed) {
        Text('加载失败，点击重试')
          .fontSize(12)
          .fontColor($r("app.color.gray"))
          .padding(12)
          .onClick(() => {
            void this.getGuess()
          })
      }
    }
    .height("100%")
  }
}
