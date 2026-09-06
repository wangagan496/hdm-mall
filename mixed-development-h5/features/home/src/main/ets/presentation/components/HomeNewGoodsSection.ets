import { PAGE_PATH } from 'constants'
import { BreakPointType, HDMGoodsItem } from 'models'
import { HDMDiscountGoods } from './HDMDiscountGoods'
import { DiscountType } from '../../domain/models'

@Component
export struct HomeNewGoodsSection {
  @Prop newGoods: HDMGoodsItem[] = []
  @StorageProp('break_point') breakPoint: string = ""
  @Consume stackPath: NavPathStack

  build() {
    Column({ space: 10 }) {
      Image($r('app.media.home_new'))
        .width(146).height(19)
      List({
        space: new BreakPointType({ sm: 14, md: 36, lg: 72 }).getValue(this.breakPoint)
      }) {
        ForEach(this.newGoods, (item: HDMGoodsItem) => {
          ListItem() {
            HDMDiscountGoods({ type: DiscountType.NEW, goods: item })
          }
          .onClick(() => {
            this.stackPath.pushPath({ name: PAGE_PATH.GOODS_PAGE, param: item })
          })
        })
      }
      .width('100%').height(116).scrollBar(BarState.Off).listDirection(Axis.Horizontal)
    }
    .width('100%').height(156).padding(10)
    .backgroundColor('#F7EFF5').borderRadius(8)
    .alignItems(HorizontalAlign.Start)
  }
}
