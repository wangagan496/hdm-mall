import { TabItem, BreakPointType } from 'models'
import { GlobalVariable, BusinessVariable, PAGE_PATH } from 'constants'
import { authCart } from 'storage'
import { CartView } from 'cart'
import { CategoryView } from 'category'
import { HomeView } from 'home'
import { MineView } from 'mine'
import { emitter } from '@kit.BasicServicesKit'
import { common } from '@kit.AbilityKit'
// 导入抽离的常量和枚举
import { TAB_LIST, TabIndex } from '../constants/TabConstants'

@Entry
@Component
struct Index {
  @StorageProp(GlobalVariable.BREAK_POINT_KEY) breakPoint: string = ""
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) bottomHeight: number = 0
  @StorageProp(BusinessVariable.CART_COUNT) cartCount: number = 0

  @StorageLink('currentTabIndex') activeIndex: number = TabIndex.HOME
  @Provide stackPath: NavPathStack = new NavPathStack()

  @Builder
  TabItemContent(item: TabItem, index: number) {
    Column({ space: 4 }) {
      Image(this.activeIndex === index ? item.active : item.normal)
        .width(24)
        .aspectRatio(1)
      Text(item.text)
        .fontColor($r('[ui_components].color.black'))
        .fontSize(12)
    }
  }

  @Builder
  getTabItemBuilder(item: TabItem, index: number) {
    Column() {
      if (index === TabIndex.CART) {
        Badge({ count: this.cartCount, style: {} }) {
          this.TabItemContent(item, index)
        }
      } else {
        this.TabItemContent(item, index)
      }
    }
    .justifyContent(FlexAlign.SpaceEvenly)
    .height(50)
  }

  aboutToAppear(): void {
    this.registerListener()
    authCart.updateCartCount()
  }

  registerListener() {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext
    context.eventHub.on(GlobalVariable.SWITCH_TAB, (index: number) => {
      this.activeIndex = index
    })
    emitter.on(BusinessVariable.TO_SEARCH, () => {
      this.stackPath.pushPath({ name: PAGE_PATH.SEARCH_PAGE })
    })
  }

  build() {
    Navigation(this.stackPath) {
      Tabs({
        barPosition: new BreakPointType({ xs: BarPosition.End, sm: BarPosition.End, md: BarPosition.End, lg: BarPosition.Start }).getValue(this.breakPoint),
        index: $$this.activeIndex
      }) {
        // 直接使用引入的 TAB_LIST 变量
        ForEach(TAB_LIST, (item: TabItem, index: number) => {
          TabContent() {
            if (index === TabIndex.HOME) { HomeView() }
            else if (index === TabIndex.CATEGORY) { CategoryView() }
            else if (index === TabIndex.CART) { CartView() }
            else if (index === TabIndex.MINE) { MineView() }
          }
          .tabBar(this.getTabItemBuilder(item, index))
        })
      }
      .barHeight(new BreakPointType({ xs: 50, sm: 50, md: 50, lg: 220 }).getValue(this.breakPoint))
      .vertical(new BreakPointType({ xs: false, sm: false, md: false, lg: true }).getValue(this.breakPoint))
      .scrollable(false)
      .padding({ bottom: this.bottomHeight })
      .animationDuration(new BreakPointType({ xs: 100, sm: 100, md: 100, lg: 0 }).getValue(this.breakPoint))
    }
    .mode(NavigationMode.Stack)
    .titleMode(NavigationTitleMode.Mini)
    .hideTitleBar(true)
  }
}
