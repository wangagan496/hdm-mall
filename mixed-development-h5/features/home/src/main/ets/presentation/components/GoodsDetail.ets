import { Goods } from '../../domain/models'

@Component
export struct GoodsDetail {
  @Prop goods: Goods = {} as Goods

  getDetailPictures(): string[] {
    if (!this.goods || !this.goods.details || !this.goods.details.pictures) {
      return []
    }
    return this.goods.details.pictures
  }

  build() {
    Column() {
      Row() {
        Text('商品详情')
          .fontSize(13)
          .fontWeight(700)
          .fontColor($r('[ui_components].color.black'))
          .margin({ left: 16 })
      }
      .width('100%')
      .height(50)

      ForEach(this.getDetailPictures(), (src: string) => {
        Image(src)
          .width('100%')
      })
    }
    .backgroundColor($r('[ui_components].color.white'))
    .margin({ bottom: 8 })
  }
}
