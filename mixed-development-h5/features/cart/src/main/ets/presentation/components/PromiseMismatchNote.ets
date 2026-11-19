import { PromiseEntry } from 'models'

@Component
export struct PromiseMismatchNote {
  @Prop promise: PromiseEntry

  build() {
    Column({ space: 8 }) {
      Text('与下单时的承诺不符：' + this.promise.label).fontSize(16).fontColor($r('[ui_components].color.text')).width('100%')
      Text('商品资料原文：' + (this.promise.quote || '')).id('after-sale-promise-quote')
        .fontSize(14).fontColor($r('[ui_components].color.text')).width('100%')
    }.width('100%').padding(12).alignItems(HorizontalAlign.Start)
      .backgroundColor($r('[ui_components].color.white')).borderRadius(8)
  }
}
