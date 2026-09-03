import { BusinessVariable, GlobalVariable, PAGE_PATH } from 'constants'
import { CategoryItem, CategoryItemChild } from 'models'
import { HDMNavBar } from 'ui_components'
import { getCategoryTopAPI, getStorageBagPictureAPI } from '../../data/api'
import {
  addStorageBagCategory,
  findCategoryIndexById,
  isStorageBagKeywordCategory,
  renameSunHatCategory,
  updateStorageBagCategoryPicture
} from '../../data/api/categoryPresentation'
import { CategorySideBar, CategoryContent } from '../components'
import { SearchRouterParam } from '../../domain/models'

@Component
export struct CategoryView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) topHeight: number = 0
  @Prop @Watch('onActiveChange') isActive: boolean = false
  @StorageLink(BusinessVariable.CATEGORY_TARGET_ID) requestedCategoryId: string = ''
  @State categories: CategoryItem[] = []
  @State activeIndex: number = 0
  @State loading: boolean = false
  @Consume stackPath: NavPathStack
  private storageBagPictureLoading: boolean = false
  private storageBagPictureLoaded: boolean = false

  aboutToAppear(): void {
    this.loadCategories()
  }

  onActiveChange(): void {
    if (this.isActive) {
      this.applyRequestedCategory()
      this.loadStorageBagPicture()
    }
  }

  applyRequestedCategory(): void {
    if (!this.requestedCategoryId || this.categories.length === 0) {
      return
    }
    const targetIndex: number = findCategoryIndexById(this.categories, this.requestedCategoryId)
    if (targetIndex >= 0) {
      this.activeIndex = targetIndex
    }
    this.requestedCategoryId = ''
  }

  async loadCategories() {
    this.loading = true
    try {
      const categories: CategoryItem[] = await getCategoryTopAPI()
      this.categories = addStorageBagCategory(
        renameSunHatCategory(categories),
        $r('app.media.category_storage_bag')
      )
      this.applyRequestedCategory()
      if (this.isActive) {
        this.loadStorageBagPicture()
      }
    } finally {
      this.loading = false
    }
  }

  async loadStorageBagPicture() {
    if (this.categories.length === 0 ||
      this.storageBagPictureLoading ||
      this.storageBagPictureLoaded) {
      return
    }
    this.storageBagPictureLoading = true
    try {
      const picture: ResourceStr = await getStorageBagPictureAPI()
      if (picture) {
        this.categories = updateStorageBagCategoryPicture(this.categories, picture)
        this.storageBagPictureLoaded = true
      }
    } catch {
      // 分类与点击查询仍可用；下次进入分类页时重新尝试加载真实商品封面。
    } finally {
      this.storageBagPictureLoading = false
    }
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
              const routeParam: SearchRouterParam = { keyword: sub.name }
              if (!isStorageBagKeywordCategory(sub.id)) {
                routeParam.categoryId = sub.id
              }
              this.stackPath.pushPathByName(
                PAGE_PATH.SEARCH_RESULT_PAGE,
                routeParam
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
