import { GlobalVariable } from 'constants'
import { LocalGoodsItem } from 'models'
import { localGoodsStore } from 'storage'
import { HDMConfirm, HDMEmpty, HDMNavBar } from 'ui_components'
import { LocalGoodsRow } from '../components/LocalGoodsRow'

@Builder
function HistoryViewBuilder() {
  HistoryView()
}

@Component
export struct HistoryView {
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
  clearDialog: CustomDialogController = new CustomDialogController({
    builder: HDMConfirm({
      message: '确定清空全部浏览足迹吗？',
      onConfirm: async () => {
        try {
          await localGoodsStore.clearHistory()
          this.loadHistory()
        } catch {
          this.safeToast('清空失败，请稍后重试')
        }
      }
    }),
    customStyle: true,
    alignment: DialogAlignment.Center
  })

  aboutToAppear(): void {
    this.loadHistory()
  }

  private loadHistory(): void {
    this.goods = localGoodsStore.getHistory()
  }

  private async removeHistory(goodsId: string): Promise<void> {
    try {
      await localGoodsStore.removeHistory(goodsId)
      this.loadHistory()
    } catch {
      this.safeToast('删除失败，请稍后重试')
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
          title: '我的足迹',
          onLeftClick: () => this.stackPath.pop()
        })
        if (this.goods.length === 0) {
          Column() {
            HDMEmpty({
              tip: '还没有浏览足迹',
              buttonText: '去逛逛',
              onBtnClick: () => this.goHome()
            })
          }
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else {
          Row() {
            Text('最近浏览')
              .fontSize(13)
              .fontColor($r('[ui_components].color.gray'))
            Blank()
            Text('清空')
              .fontSize(13)
              .fontColor($r('[ui_components].color.red'))
              .padding({ left: 12, top: 8, right: 4, bottom: 8 })
              .onClick(() => this.clearDialog.open())
          }
          .width('100%')
          .padding({ left: 12, right: 12 })

          List({ space: 1 }) {
            ForEach(this.goods, (item: LocalGoodsItem) => {
              ListItem() {
                LocalGoodsRow({
                  item: item,
                  actionText: '删除',
                  onAction: (goodsId: string) => this.removeHistory(goodsId)
                })
              }
            }, (item: LocalGoodsItem) => item.id)
          }
          .layoutWeight(1)
          .scrollBar(BarState.Off)
          .padding({ bottom: 8 })
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
