import { PAGE_PATH } from 'constants'
import { HDMGoodsItem } from 'models'
import { HDMDiscountGoods } from './HDMDiscountGoods'
import { DiscountType } from '../../domain/models'

export interface DiscountSectionParams {
  title: string
  subTitle: string
  bg: ResourceStr
  list: HDMGoodsItem[]
}

@Component
export struct HomeDiscountSection {
  @Prop params: DiscountSectionParams = {
    title: '',
    subTitle: '',
    bg: '',
    list: []
  }
  @Consume stackPath: NavPathStack

  build() {
    Column() {
      Row({ space: 10 }) {
        Text(this.params.title)
          .fontColor($r('[ui_components].color.black'))
          .fontSize(14)
        Text(this.params.subTitle)
          .fontColor($r('[ui_components].color.text'))
          .fontSize(11)
      }
      .width('100%')
      .margin({ bottom: 10 })

      List({ space: 10 }) {
        ForEach(this.params.list, (item: HDMGoodsItem) => {
          ListItem() {
            HDMDiscountGoods({ type: DiscountType.DISCOUNT, goods: item })
          }
          .onClick(() => {
            this.stackPath.pushPath({
              name: PAGE_PATH.GOODS_PAGE,
              param: item
            })
          })
        })
      }
      .width('100%')
      .height(116)
      .scrollBar(BarState.Off)
      .listDirection(Axis.Horizontal)
    }
    .height(160)
    .layoutWeight(1)
    .padding(10)
    .backgroundColor(this.params.bg)
    .borderRadius(8)
  }
}
