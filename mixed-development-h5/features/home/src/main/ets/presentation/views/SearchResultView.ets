import { GlobalVariable, PAGE_PATH } from 'constants'
import { BreakPointType, HDMGoodsItem, ListDataSource } from 'models'
import { HDMEmpty, HDMGoods } from 'ui_components'
import { searchGoodsAPI } from '../../data/api'
import { SearchParams, SearchRouterParam, SortCompAttr, SortField, SortMethod } from '../../domain/models'
import { SearchSortItem } from './SearchSortItem'


@Component
export struct SearchResultView {
  @Consume
  stackPath: NavPathStack
  // 顶部安全区域
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  safeTop: number = 0
  @StorageProp(GlobalVariable.BREAK_POINT_KEY)
  breakPoint: string = ""
  // mock 数据
  @State data: HDMGoodsItem[] = []
  lazyDataSource: ListDataSource<HDMGoodsItem> = new ListDataSource<HDMGoodsItem>()
  @State loading: boolean = false // 是否正在加载
  @State isFinished: boolean = false // 是否已经完成了所有的加载
  @State resultCount: number = 0
  // 查询参数
  @State
  params: SearchParams =
    {
      keyword: '',
      sortField: 'publishTime',
      sortMethod: 'desc',
      page: 1,
      pageSize: 10
    }
  // 筛选条件
  sortList: SortCompAttr[] = [
    { label: '时间', field: 'publishTime' },
    { label: '销量', field: 'orderNum' },
    { label: '价格', field: 'price' }
  ]
  // 控制器
  scroller = new Scroller()

  aboutToAppear(): void {
    const routeParams = this.stackPath.getParamByName(PAGE_PATH.SEARCH_RESULT_PAGE) as SearchRouterParam[]
    const routeParam = routeParams[routeParams.length - 1]
    this.params.keyword = routeParam.keyword
    this.params.categoryId = routeParam.categoryId
    this.queryGoodsData()
  }

  async queryGoodsData() {
    this.loading = true
    try {
      const result = await searchGoodsAPI(this.params)
      this.resultCount = result.pageData.counts
      this.lazyDataSource.addArr(result.pageData.items)
      this.params.page++
      if (result.pageData.pages < this.params.page) {
        this.isFinished = true
      }
    } finally {
      this.loading = false
    }
  }

  // 重新查询逻辑
  refreshQuery() {
    this.params.page = 1 // 再次搜索回到第一页
    this.isFinished = false // 是否加载完成回到最开始状态
    this.resultCount = 0
    this.lazyDataSource.loadData([]) // 回到空数据 再去添加的
    this.queryGoodsData()
  }

  build() {
    NavDestination() {
      Column() {
        // 搜索区域
        Row() {
          Image($r('[ui_components].media.ic_public_left'))
            .width(24)
            .aspectRatio(1)
            .fillColor($r('[ui_components].color.white'))
            .margin(13)
            .onClick(() => {
              this.stackPath.pop()
            })
          Search({ placeholder: '商品关键字...', value: this.params.keyword })
            .searchIcon({ src: $r('[ui_components].media.ic_public_search'), color: $r('[ui_components].color.gray') })
            .placeholderColor($r('[ui_components].color.gray'))
            .placeholderFont({ size: 14 })
            .backgroundColor($r('[ui_components].color.white'))
            .textFont({ size: 14 })
            .layoutWeight(1)
            .padding(0)
            .margin(0)
            .height(36)
            .caretStyle({ color: $r('[ui_components].color.red') })
            .onSubmit((value) => {
              this.params.keyword = value
              this.params.categoryId = undefined
              this.refreshQuery()
            })
        }
        .padding({ top: this.safeTop, right: 16 })
        .linearGradient({
          angle: 135,
          colors: [[$r('[ui_components].color.linear_begin'), 0], [$r('[ui_components].color.linear_end'), 1]]
        })

        // list
        Row() {
          ForEach(this.sortList, (item: SortCompAttr) => {
            // 筛选组件
            SearchSortItem({
              label: item.label, // 当前自己的显示名称
              field: item.field, // 当前自己的字段
              sortField: this.params.sortField, // 搜索以谁为准
              sortMethod: this.params.sortMethod,
              onSortChange: (field: SortField, method: SortMethod) => {
                this.params.sortField = field
                this.params.sortMethod = method
                // 必须要重查
                this.refreshQuery()
              }
            })
          })
          Text('筛选')
            .fontSize(14)
            .fontColor($r('[ui_components].color.gray'))
        }
        .padding({ left: 16, right: 16 })
        .height(50)
        .width('100%')
        .justifyContent(FlexAlign.SpaceBetween)
        .border({ width: { bottom: 0.5 }, color: $r('[ui_components].color.border') })

        if (!this.loading && this.resultCount === 0) {
          HDMEmpty({
            tip: `暂无“${this.params.keyword}”相关商品`,
            buttonText: '返回分类',
            onBtnClick: () => this.stackPath.pop()
          })
            .layoutWeight(1)
        } else {
          WaterFlow({ scroller: this.scroller }) {
            LazyForEach(this.lazyDataSource, (item: HDMGoodsItem) => {
              FlowItem() {
                HDMGoods({ goods: item, smallImage: true })
              }
            })
          }
          .columnsTemplate(
            new BreakPointType({
              sm: '1fr 1fr',
              md: '1fr 1fr 1fr',
              lg: '1fr 1fr 1fr 1fr'
            })
              .getValue(this.breakPoint)

          )
          .columnsGap(0.5)
          .rowsGap(0.5)
          .layoutWeight(1)
          .onReachEnd(async () => {
            if (!this.loading && !this.isFinished) {
              await this.queryGoodsData()
            }
          })
        }
      }
    }
    .hideTitleBar(true)
  }
}

@Builder
export function SearchResultViewBuilder() {
  SearchResultView()
}
