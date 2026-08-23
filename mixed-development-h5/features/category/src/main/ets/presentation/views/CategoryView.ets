import { GlobalVariable, PAGE_PATH } from 'constants'
import { CategoryItem, CategoryItemChild } from 'models'
import { HDMNavBar } from 'ui_components'
import { getCategoryTopAPI } from '../../data/api'
import { CategorySideBar, CategoryContent } from '../components'
import { SearchRouterParam } from '../../domain/models'

@Component
export struct CategoryView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) topHeight: number = 0
  @State categories: CategoryItem[] = []
  @State activeIndex: number = 0
  @State loading: boolean = false
  @Consume stackPath: NavPathStack

  aboutToAppear(): void {
    this.loadCategories()
  }

  async loadCategories() {
    this.loading = true
    try {
      this.categories = await getCategoryTopAPI()
    } finally {
      this.loading = false
    }
  }

  build() {
    Column() {
      HDMNavBar({
        title: '分类',
        showLeftIcon: false,
        showRightIcon: true,
        rightIcon: $r('[ui_components].media.ic_public_search'),
        onRightClick: () => this.stackPath.pushPathByName(PAGE_PATH.SEARCH_PAGE, null)
      })

      if (this.loading) {
        LoadingProgress()
          .width(48)
          .color($r('[ui_components].color.red'))
          .layoutWeight(1)
      } else {
        Row() {
          CategorySideBar({
            categories: this.categories,
            activeIndex: $activeIndex,
            onSelect: (i: number) => { this.activeIndex = i }
          })
          CategoryContent({
            category: this.categories[this.activeIndex] || {} as CategoryItem,
            onSubClick: (sub: CategoryItemChild) => {
              this.stackPath.pushPathByName(
                PAGE_PATH.SEARCH_RESULT_PAGE,
                { keyword: sub.name, categoryId: sub.id } as SearchRouterParam
              )
            }
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
