import { PAGE_PATH } from 'constants'
import { BreakPointType, HDMGoodsItem } from 'models'
import { HDMDiscountGoods } from './HDMDiscountGoods'

@Component
export struct HomeSaleGoodsSection {
  @Prop saleGoods: HDMGoodsItem[] = []
  @StorageProp('break_point') breakPoint: string = ""
  @Consume stackPath: NavPathStack

  build() {
    Column({ space: 10 }) {
      Image($r('app.media.home_cmd_title'))
        .width(150).height(20)
      Row() {
        Image($r('app.media.home_cmd_inner'))
          .width(86).height(116)
        List({
          space: new BreakPointType({ sm: 14, md: 36, lg: 72 }).getValue(this.breakPoint)
        }) {
          ForEach(this.saleGoods, (item: HDMGoodsItem) => {
            ListItem() {
              HDMDiscountGoods({ goods: item })
            }
            .onClick(() => {
              this.stackPath.pushPath({ name: PAGE_PATH.GOODS_PAGE, param: item })
            })
          })
        }
        .layoutWeight(1).width('100%').height(116)
        .backgroundColor($r('[ui_components].color.white'))
        .borderRadius({ topRight: 8, bottomRight: 8 })
        .padding({ right: 10, left: 10 })
        .scrollBar(BarState.Off).listDirection(Axis.Horizontal)
      }
    }
    .width('100%').height(166)
    .backgroundImage($r('app.media.home_cmd_sm'))
    .backgroundImageSize(ImageSize.Cover)
    .borderRadius(8).padding(10)
    .alignItems(HorizontalAlign.Start)
  }
}
