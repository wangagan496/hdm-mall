import { GlobalVariable, PAGE_PATH } from 'constants'
import { BreakPointType, HDMGoodsItem, ListDataSource } from 'models'
import { HDMGoods } from 'ui_components'
import { normalizeSearchGoodsPicturesAPI, searchGoodsAPI } from '../../data/api'
import { compareGoodsIds, searchFailureMessage } from '../../data/api/searchPresentation'
import { SearchParams, SearchRouterParam, SortCompAttr, SortField, SortMethod } from '../../domain/models'
import { SearchSortItem } from './SearchSortItem'


@Component
export struct SearchResultView {
  @Consume
  stackPath: NavPathStack
  // 顶部安全区域
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.BREAK_POINT_KEY)
  breakPoint: string = ""
  // 页面实际显示的商品；每次翻页追加，重新搜索时清空。
  lazyDataSource: ListDataSource<HDMGoodsItem> = new ListDataSource<HDMGoodsItem>()
  @State loading: boolean = false // 是否正在加载
  @State isFinished: boolean = false // 是否已经完成了所有的加载
  @State resultCount: number = 0
  @State loadFailed: boolean = false
  @State failureMessage: string = ''
  @State searchInput: string = ''
  @State temporarySort: boolean = false
  @State fromCategory: boolean = false
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
  // 换关键词或排序就换一个编号；旧请求回来时，编号不同就丢弃。翻页沿用同一编号。
  private queryGeneration: number = 0
  // 已显示的商品编号，防止相邻两页返回同一件商品。
  private loadedGoodsIds: Set<string> = new Set<string>()

  private submitSearch(value: string): void {
    const keyword: string = value.trim()
    if (!keyword) {
      return
    }
    this.params.keyword = keyword
    this.params.categoryId = undefined
    this.restartSearch()
  }

  aboutToAppear(): void {
    const routeParams = this.stackPath.getParamByName(PAGE_PATH.SEARCH_RESULT_PAGE) as SearchRouterParam[]
    const routeParam = routeParams[routeParams.length - 1]
    this.fromCategory=!!routeParam?.categoryId
    this.params.keyword = routeParam?.keyword || ''
    this.searchInput = this.params.keyword
    this.params.categoryId = routeParam?.categoryId
    this.queryGeneration++
    this.loadNextSearchPage()
  }

  // 取一页 → 筛选并去重 → 追加显示；整页都被筛掉时继续取下一页。
  private backLabel():string {return this.fromCategory?'返回分类':'返回搜索'}
  private emptyActionLabel():string {return this.params.categoryId?'清除筛选':'修改关键词'}
  private emptyResultTip():string {return this.params.categoryId?'这个分类下暂时没有商品':'没有找到相关商品，换个关键词试试'}
  private resolveEmpty():void {
    if(this.params.categoryId){this.params.categoryId=undefined;this.restartSearch()}
    else {this.searchInput='';try{this.getUIContext().getFocusController().requestFocus('search-keyword')}catch{}}
  }
  private async loadNextSearchPage(): Promise<void> {
    if (this.loading || this.isFinished) {
      return
    }
    const generation: number = this.queryGeneration
    const query: SearchParams = {
      keyword: this.params.keyword,
      categoryId: this.params.categoryId,
      sortField: this.params.sortField,
      sortMethod: this.params.sortMethod,
      page: this.params.page,
      pageSize: this.params.pageSize
    }
    this.loading = true
    this.loadFailed = false
    try {
      let relevantItems: HDMGoodsItem[] = []
      do {
        const result = await searchGoodsAPI(query)
        if (generation !== this.queryGeneration) {
          return
        }
        if (this.temporarySort) {
          this.lazyDataSource.loadData([])
          this.temporarySort = false
        }
        relevantItems = this.selectNewMatchingGoods(result.pageData.items, query)
        if (relevantItems.length > 0) {
          const startIndex: number = this.lazyDataSource.totalCount()
          this.lazyDataSource.addArr(relevantItems)
          this.resultCount = this.lazyDataSource.totalCount()
          this.normalizeSearchPictures(relevantItems, startIndex, generation)
        }
        query.page++
        this.params.page = query.page
        this.isFinished = result.pageData.pages < query.page
        // 若当前页全是被排除的错误类型，继续取下一页，避免提前展示“暂无商品”。
      } while (relevantItems.length === 0 && !this.isFinished)
      this.resultCount = this.lazyDataSource.totalCount()
    } catch (error) {
      if (generation === this.queryGeneration) {
        this.loadFailed = true
        this.failureMessage = searchFailureMessage(error as Error)
      }
    } finally {
      // 旧请求结束时，不能把新一轮搜索的加载状态关掉。
      if (generation === this.queryGeneration) {
        this.loading = false
      }
    }
  }

  // 先排除不符合搜索条件的商品，再按商品编号去重；名称相同不代表同一件商品。
  private selectNewMatchingGoods(items: HDMGoodsItem[], query: SearchParams): HDMGoodsItem[] {
    // 分类和关键词已由服务端在分页前处理；这里只按稳定编号去重。
    return items.filter((goods: HDMGoodsItem): boolean => {
      if (this.loadedGoodsIds.has(goods.id)) {
        return false
      }
      this.loadedGoodsIds.add(goods.id)
      return true
    })
  }

  // 商品先显示，图片随后校正；只替换本轮搜索对应位置的商品。
  private async normalizeSearchPictures(
    items: HDMGoodsItem[],
    startIndex: number,
    generation: number
  ): Promise<void> {
    let normalizedItems: HDMGoodsItem[]
    try {
      normalizedItems = await normalizeSearchGoodsPicturesAPI(items)
    } catch {
      return
    }
    if (generation !== this.queryGeneration) {
      return
    }
    this.lazyDataSource.replaceArr(startIndex, normalizedItems)
  }

  // 换关键词、改排序或重试：让旧请求失效，清空已有商品，从第 1 页重新取。
  private restartSearch(keepTemporaryResults: boolean = false): void {
    this.queryGeneration++
    this.params.page = 1 // 再次搜索回到第一页
    this.isFinished = false // 新查询还没有取完，允许继续加载
    this.loading = false
    this.temporarySort = keepTemporaryResults && this.resultCount > 0
    this.loadedGoodsIds.clear()
    if (!this.temporarySort) {
      this.resultCount = 0
      this.lazyDataSource.loadData([])
    }
    this.loadNextSearchPage()
  }

  aboutToDisappear(): void {
    this.queryGeneration++
  }

  private changeSort(field: SortField, method: SortMethod): void {
    this.params.sortField = field
    this.params.sortMethod = method
    const loaded: HDMGoodsItem[] = []
    for (let index: number = 0; index < this.lazyDataSource.totalCount(); index++) {
      loaded.push(this.lazyDataSource.getData(index))
    }
    loaded.sort((left: HDMGoodsItem, right: HDMGoodsItem): number => {
      const difference: number = field === 'price' ? Number(left.price) - Number(right.price) :
        field === 'orderNum' ? Number(left.orderNum || 0) - Number(right.orderNum || 0) : compareGoodsIds(left.id, right.id)
      return (method === 'asc' ? difference : -difference) || compareGoodsIds(left.id, right.id)
    })
    this.lazyDataSource.loadData(loaded)
    this.restartSearch(true)
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
          Search({ placeholder: '商品关键字...', value: this.searchInput })
            .id('search-keyword')
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
              this.searchInput = value
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
                this.changeSort(field, method)
              }
            })
          })
        }
        .padding({ left: 16, right: 16 })
        .height(50)
        .width('100%')
        .justifyContent(FlexAlign.SpaceBetween)
        .border({ width: { bottom: 0.5 }, color: $r('[ui_components].color.border') })

        if (this.temporarySort || (this.loadFailed && this.resultCount > 0)) {
          Text(this.loadFailed ? this.failureMessage + '；完整结果未更新，点击重试' : '仅已加载商品已重排，完整排序更新中')
            .fontSize(12)
            .padding(10)
            .onClick(() => {
              if (this.loadFailed) {
                this.restartSearch(true)
              }
            })
        }
        if (!this.loading && this.resultCount === 0) {
          Column({ space: 16 }) {
            Image($r('[ui_components].media.ic_public_empty')).width(120).aspectRatio(1)
            Text(this.loadFailed ? this.failureMessage : this.emptyResultTip())
              .fontSize(12).fontColor($r('[ui_components].color.text'))
            Row({ space: 12 }) {
              if (this.loadFailed) {
                Button('重新加载').backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary'))
                  .onClick(() => this.restartSearch())
              } else {
                Button(this.emptyActionLabel()).id('empty-action')
                  .backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary'))
                  .onClick(() => this.resolveEmpty())
              }
              Button(this.backLabel()).id('empty-back')
                .backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.red'))
                .border({ width: 1, color: $r('[ui_components].color.red') })
                .onClick(() => this.stackPath.pop())
            }
          }
            .layoutWeight(1)
            .width('100%')
            .justifyContent(FlexAlign.Center)
            .alignItems(HorizontalAlign.Center)
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
          .cachedCount(4)
          .layoutWeight(1)
          .onReachEnd(async () => {
            if (!this.loading && !this.isFinished) {
              await this.loadNextSearchPage()
            }
          })
        }
      }
    }
    .padding({ bottom: this.safeBottom })
    .hideTitleBar(true)
  }
}

@Builder
export function SearchResultViewBuilder() {
  SearchResultView()
}
