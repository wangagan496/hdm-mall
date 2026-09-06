import { CartGoodsModel } from 'models'

@Component
export struct CartItem {
  @ObjectLink
  cart: CartGoodsModel
  onChangeSelected: (selected: boolean) => void = () => {

  }
  onChangeCount: (count: number) => void = () => {

  }
  onDelete: () => void = () => {

  }

  build() {
    Row({ space: 12 }) {
      Checkbox()
        .selectedColor($r('[ui_components].color.red'))
        .size({ width: 18, height: 18 })
        .select(this.cart.selected)
        .accessibilityText(this.cart.selected ? '取消选择商品' : '选择商品')
        .onClick(() => {
          this.cart.selected = !this.cart.selected
          // 取消勾选或者勾选
          this.onChangeSelected(this.cart.selected)
        })
      Image(this.cart.picture)
        .width(84)
        .height(84)
        .objectFit(ImageFit.Contain)
        .borderRadius(8)
        .backgroundColor($r('[ui_components].color.under'))
        .syncLoad(true) // 解决图片闪烁
      Column({ space: 6 }) {
        Row({ space: 8 }) {
          Text(this.cart.name)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .maxLines(1)
            .fontSize(14)
            .fontColor($r('[ui_components].color.black'))
            .layoutWeight(1)
          Image($r('app.media.ic_cart_delete'))
            .width(28)
            .height(28)
            .padding(6)
            .fillColor($r('[ui_components].color.red'))
            .accessibilityText('删除商品')
            .onClick(() => {
              this.onDelete()
            })
        }
        .width('100%')
        Row() {
          Text(this.cart.attrsText)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .maxLines(1)
            .fontSize(12)
            .fontColor($r('[ui_components].color.text'))
            .layoutWeight(1)
          Image($r('sys.media.ohos_ic_public_arrow_down'))
            .fillColor($r('[ui_components].color.gray'))
            .width(16)
            .height(16)
        }
        .padding({ left: 6, right: 4 })
        .constraintSize({ maxWidth: 140 })
        .height(24)
        .backgroundColor($r('[ui_components].color.under'))
        .borderRadius(4)

        Row() {
          Text(`¥${this.cart.price}`)
            .fontSize(14)
            .fontWeight(500)
          Counter() {
            Text(this.cart.count.toString())
          }
          .height(28)
          .enableDec(this.cart.count > 1)
          .onInc(async () => {

            // await this.onChangeCount(this.cart.count) // 子传父 服务器先更新
            // this.cart.count++ // 再更新客户端
            this.cart.count++
            this.onChangeCount(this.cart.count)
          })
          .onDec(() => {
            this.cart.count--
            this.onChangeCount(this.cart.count) // 子传父
          })
        }
        .width('100%')
        .justifyContent(FlexAlign.SpaceBetween)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height(112)
    .padding(12)
    .borderRadius(12)
    .clip(true)
    .backgroundColor($r('[ui_components].color.white'))
  }
}
