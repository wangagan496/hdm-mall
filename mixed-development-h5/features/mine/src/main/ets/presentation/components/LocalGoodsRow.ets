import { PAGE_PATH } from 'constants'
import { HDMGoodsItem, LocalGoodsItem } from 'models'

@Component
export struct LocalGoodsRow {
  item: LocalGoodsItem = {} as LocalGoodsItem
  actionText: string = '移除'
  onAction: (goodsId: string) => void = () => {
  }
  @Consume
  stackPath: NavPathStack

  private openGoods(): void {
    const goods: HDMGoodsItem = {
      id: this.item.id,
      name: this.item.name,
      desc: this.item.desc,
      price: this.item.price,
      picture: this.item.picture || $r('[ui_components].media.ic_public_empty'),
      orderNum: this.item.orderNum,
      originalPrice: this.item.originalPrice
    }
    this.stackPath.pushPath({
      name: PAGE_PATH.GOODS_PAGE,
      param: goods
    })
  }

  build() {
    Row({ space: 12 }) {
      Row({ space: 12 }) {
        Image(this.item.picture || $r('[ui_components].media.ic_public_empty'))
          .width(88)
          .height(88)
          .objectFit(ImageFit.Contain)
          .backgroundColor($r('[ui_components].color.under'))
          .borderRadius(8)
        Column({ space: 8 }) {
          Text(this.item.name)
            .fontSize(14)
            .fontColor($r('[ui_components].color.black'))
            .fontWeight(500)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
          Text(this.item.desc)
            .fontSize(12)
            .fontColor($r('[ui_components].color.gray'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
          Text('¥' + this.item.price)
            .fontSize(16)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('[ui_components].color.red'))
            .width('100%')
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .layoutWeight(1)
      .onClick(() => this.openGoods())

      Button(this.actionText)
        .fontSize(12)
        .fontColor($r('[ui_components].color.text'))
        .height(30)
        .padding({ left: 12, right: 12 })
        .backgroundColor($r('[ui_components].color.white'))
        .border({ width: 0.5, color: $r('[ui_components].color.border') })
        .onClick(() => this.onAction(this.item.id))
    }
    .width('100%')
    .padding(12)
    .backgroundColor($r('[ui_components].color.white'))
  }
}
