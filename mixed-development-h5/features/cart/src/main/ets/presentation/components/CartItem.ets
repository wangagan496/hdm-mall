import { CartGoodsModel, returnPolicyLabel } from 'models'

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

  private changeCount(delta: number): void {
    if (!this.cart.available || this.cart.count + delta < 1) return
    this.onChangeCount(this.cart.count + delta)
  }

  build() {
    Row({ space: 12 }) {
      Checkbox()
        .selectedColor($r('[ui_components].color.red'))
        .size({ width: 18, height: 18 })
        .select(this.cart.selected)
        .enabled(this.cart.available)
        .accessibilityText(this.cart.selected ? '取消选择商品' : '选择商品')
        .onClick(() => {
          // 父组件立即显示目标值并串行保存，失败时只回滚当前行。
          this.onChangeSelected(!this.cart.selected)
        })
      Image(this.cart.picture)
        .width(84)
        .height(84)
        .sourceSize({ width: 252, height: 252 })
        .objectFit(ImageFit.Contain)
        .borderRadius(8)
        .backgroundColor($r('[ui_components].color.under'))
      Column({ space: 6 }) {
        Row({ space: 8 }) {
          Text(this.cart.name)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .maxLines(1)
            .fontSize(14)
            .fontColor($r('[ui_components].color.black'))
            .layoutWeight(1)
          Image($r('app.media.ic_cart_delete'))
            .id('cart-delete-' + this.cart.skuId)
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
        Text(returnPolicyLabel(this.cart)).id('cart-return-policy-' + this.cart.skuId)
          .fontSize(12).fontColor($r('[ui_components].color.text')).width('100%')
        Row() {
          Text(this.cart.available ? this.cart.attrsText : this.cart.unavailableReason || '暂不可购买')
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .maxLines(1)
            .fontSize(12)
            .fontColor($r('[ui_components].color.text'))
            .layoutWeight(1)
          if (this.cart.available) {
            Image($r('sys.media.ohos_ic_public_arrow_down'))
              .id('cart-specification-arrow-' + this.cart.skuId)
              .fillColor($r('[ui_components].color.gray'))
              .width(16)
              .height(16)
          }
        }
        .id('cart-specification-' + this.cart.skuId)
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
          .id('cart-quantity-' + this.cart.skuId)
          .enableDec(this.cart.available && this.cart.count > 1)
          .enableInc(this.cart.available)
          .onInc(() => {
            this.changeCount(1)
          })
          .onDec(() => {
            this.changeCount(-1)
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
