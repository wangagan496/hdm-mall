import { GlobalVariable, PAGE_PATH } from 'constants'
import { BreakPointType, HDMGoodsItem, ListDataSource } from 'models'
import { HDMEmpty, HDMGoods } from 'ui_components'
import { normalizeSearchGoodsPicturesAPI, searchGoodsAPI } from '../../data/api'
import { filterSearchGoods } from '../../data/api/searchPresentation'
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
  @State loadFailed: boolean = false
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
  private queryGeneration: number = 0
  private loadedGoodsIds: Set<string> = new Set<string>()

  private submitSearch(value: string): void {
    const keyword: string = value.trim()
    if (!keyword) {
      return
    }
    this.params.keyword = keyword
    this.params.categoryId = undefined
    this.refreshQuery()
  }

  aboutToAppear(): void {
    const routeParams = this.stackPath.getParamByName(PAGE_PATH.SEARCH_RESULT_PAGE) as SearchRouterParam[]
    const routeParam = routeParams[routeParams.length - 1]
    this.params.keyword = routeParam.keyword
    this.params.categoryId = routeParam.categoryId
    this.queryGeneration++
    this.queryGoodsData()
  }

  async queryGoodsData() {
    const generation: number = this.queryGeneration
    this.loading = true
    this.loadFailed = false
    try {
      let relevantItems: HDMGoodsItem[] = []
      do {
        const result = await searchGoodsAPI(this.params)
        if (generation !== this.queryGeneration) {
          return
        }
        const filteredItems: HDMGoodsItem[] = filterSearchGoods(
          result.pageData.items,
          this.params.keyword,
          this.params.categoryId
        )
        relevantItems = filteredItems.filter((item: HDMGoodsItem): boolean => {
          if (this.loadedGoodsIds.has(item.id)) {
            return false
          }
          this.loadedGoodsIds.add(item.id)
          return true
        })
        if (relevantItems.length > 0) {
          const startIndex: number = this.lazyDataSource.totalCount()
          this.lazyDataSource.addArr(relevantItems)
          this.resultCount = this.lazyDataSource.totalCount()
          this.normalizeSearchPictures(relevantItems, startIndex, generation)
        }
        this.params.page++
        this.isFinished = result.pageData.pages < this.params.page
        // 若当前页全是被排除的错误类型，继续取下一页，避免提前展示“暂无商品”。
      } while (relevantItems.length === 0 && !this.isFinished)
      this.resultCount = this.lazyDataSource.totalCount()
    } catch {
      if (generation === this.queryGeneration) {
        this.loadFailed = true
      }
    } finally {
      if (generation === this.queryGeneration) {
        this.loading = false
      }
    }
  }

  private async normalizeSearchPictures(
    items: HDMGoodsItem[],
    startIndex: number,
    generation: number
  ): Promise<void> {
    const normalizedItems: HDMGoodsItem[] = await normalizeSearchGoodsPicturesAPI(items)
    if (generation !== this.queryGeneration) {
      return
    }
    this.lazyDataSource.replaceArr(startIndex, normalizedItems)
  }

  // 重新查询逻辑
  refreshQuery() {
    this.queryGeneration++
    this.params.page = 1 // 再次搜索回到第一页
    this.isFinished = false // 是否加载完成回到最开始状态
    this.resultCount = 0
    this.loadedGoodsIds.clear()
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
            .focusable(true)
            .accessibilityText('返回')
            .onClick(() => {
              this.stackPath.pop()
            })
          Search({ placeholder: '商品关键字...', value: this.params.keyword })
            .searchIcon({ src: $r('[ui_components].media.ic_public_search'), color: $r('[ui_components].color.gray') })
            .placeholderColor($r('[ui_components].color.gray'))
            .placeholderFont({ size: 14 })
            .searchButton('搜索', { fontSize: 14, fontColor: $r('[ui_components].color.red') })
            .backgroundColor($r('[ui_components].color.white'))
            .textFont({ size: 14 })
            .layoutWeight(1)
            .padding(0)
            .margin(0)
            .height(36)
            .caretStyle({ color: $r('[ui_components].color.red') })
            .onChange((value: string) => {
              this.params.keyword = value
            })
            .onSubmit((value: string) => this.submitSearch(value))
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
            tip: this.loadFailed ? '商品加载失败，请稍后重试' : `暂无“${this.params.keyword}”相关商品`,
            buttonText: this.loadFailed ? '重新加载' : '返回分类',
            onBtnClick: () => {
              if (this.loadFailed) {
                this.refreshQuery()
              } else {
                this.stackPath.pop()
              }
            }
          })
            .layoutWeight(1)
        } else {
          Grid(this.scroller) {
            LazyForEach(this.lazyDataSource, (item: HDMGoodsItem) => {
              GridItem() {
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
          .columnsGap(1)
          .rowsGap(1)
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
