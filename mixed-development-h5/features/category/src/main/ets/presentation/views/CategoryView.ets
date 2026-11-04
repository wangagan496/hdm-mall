import { BusinessVariable, GlobalVariable, PAGE_PATH } from 'constants'
import { CategoryItem, CategoryItemChild } from 'models'
import { HDMNavBar, HDMEmpty } from 'ui_components'
import { getCategoryTopAPI } from '../../data/api'
import { findCategoryIndexById } from '../../data/api/categoryPresentation'
import { CategorySideBar, CategoryContent } from '../components'
import { SearchRouterParam } from '../../domain/models'

@Component
export struct CategoryView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) topHeight: number = 0
  @Prop @Watch('onActiveChange') isActive: boolean = false
  @StorageLink(BusinessVariable.CATEGORY_TARGET_ID) requestedCategoryId: string = ''
  @State categories: CategoryItem[] = []
  // 左栏选中的是列表位置；分类的业务编号保存在 category.id。
  @State selectedCategoryIndex: number = 0
  @State loading: boolean = false
  @State loadFailed: boolean = false
  @Consume stackPath: NavPathStack

  aboutToAppear(): void {
    this.loadCategories()
  }

  onActiveChange(): void {
    if (this.isActive) {
      this.selectRequestedCategory()
    }
  }

  selectRequestedCategory(): void {
    if (!this.requestedCategoryId || this.categories.length === 0) {
      return
    }
    const requestedCategoryIndex: number = findCategoryIndexById(this.categories, this.requestedCategoryId)
    if (requestedCategoryIndex >= 0) {
      this.selectedCategoryIndex = requestedCategoryIndex
    }
    this.requestedCategoryId = ''
  }

  async loadCategories(): Promise<void> {
    this.loading = true
    this.loadFailed = false
    try {
      const categories: CategoryItem[] = await getCategoryTopAPI()
      this.categories = categories
      this.selectRequestedCategory()
    } catch {
      this.loadFailed = true
    } finally {
      this.loading = false
    }
  }

  private openCategoryGoods(subcategory: CategoryItemChild): void {
    const searchCriteria: SearchRouterParam = { keyword: '', categoryId: subcategory.id }
    this.stackPath.pushPathByName(PAGE_PATH.SEARCH_RESULT_PAGE, searchCriteria)
  }

  build() {
    Column() {
      HDMNavBar({
        title: '分类',
        showLeftIcon: false,
        showRightIcon: true,
        rightIcon: $r('[ui_components].media.ic_public_search'),
        rightAccessibilityText: '搜索商品',
        onRightClick: () => this.stackPath.pushPathByName(PAGE_PATH.SEARCH_PAGE, null)
      })

      if (this.loading) {
        LoadingProgress()
          .width(48)
          .color($r('[ui_components].color.red'))
          .layoutWeight(1)
      } else if (this.loadFailed) {
        HDMEmpty({ tip: '分类加载失败', buttonText: '重新加载', onBtnClick: (): void => { this.loadCategories() } })
          .layoutWeight(1)
      } else {
        Row() {
          CategorySideBar({
            categories: this.categories,
            activeIndex: $selectedCategoryIndex,
            onSelect: (categoryIndex: number) => {
              this.selectedCategoryIndex = categoryIndex
            }
          })
          CategoryContent({
            category: this.categories[this.selectedCategoryIndex] || {} as CategoryItem,
            onSubClick: (subcategory: CategoryItemChild) => this.openCategoryGoods(subcategory)
          })
        }
        .layoutWeight(1)
        .alignItems(VerticalAlign.Top)
      }
    }
    .width('100%')
    .height('100%')
    .padding({ top: this.topHeight })
  }
}
