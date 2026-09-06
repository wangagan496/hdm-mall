import { GlobalVariable } from 'constants'
import { LocalGoodsItem } from 'models'
import { localGoodsStore } from 'storage'
import { HDMEmpty, HDMNavBar } from 'ui_components'
import { LocalGoodsRow } from '../components/LocalGoodsRow'

@Builder
function FavoritesViewBuilder() {
  FavoritesView()
}

@Component
export struct FavoritesView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @State
  goods: LocalGoodsItem[] = []
  @Consume
  stackPath: NavPathStack

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  aboutToAppear(): void {
    this.loadFavorites()
  }

  private loadFavorites(): void {
    this.goods = localGoodsStore.getFavorites()
  }

  private async removeFavorite(goodsId: string): Promise<void> {
    try {
      await localGoodsStore.removeFavorite(goodsId)
      this.loadFavorites()
      this.safeToast('已取消收藏')
    } catch {
      this.safeToast('操作失败，请稍后重试')
    }
  }

  private goHome(): void {
    this.stackPath.clear()
    AppStorage.setOrCreate<number>('currentTabIndex', 0)
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: '我的收藏',
          onLeftClick: () => this.stackPath.pop()
        })
        if (this.goods.length === 0) {
          Column() {
            HDMEmpty({
              tip: '还没有收藏商品',
              buttonText: '去逛逛',
              onBtnClick: () => this.goHome()
            })
          }
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else {
          List({ space: 1 }) {
            ForEach(this.goods, (item: LocalGoodsItem) => {
              ListItem() {
                LocalGoodsRow({
                  item: item,
                  actionText: '取消收藏',
                  onAction: (goodsId: string) => this.removeFavorite(goodsId)
                })
              }
            }, (item: LocalGoodsItem) => item.id)
          }
          .layoutWeight(1)
          .scrollBar(BarState.Off)
          .padding({ top: 8, bottom: 8 })
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('[ui_components].color.under'))
    }
    .hideTitleBar(true)
    .padding({ top: this.topHeight })
  }
}
