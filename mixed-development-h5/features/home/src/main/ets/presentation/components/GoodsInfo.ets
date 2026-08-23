import { HDMPreviewImage } from 'ui_components'
import { Goods } from "../../domain/models"

@Component
export struct GoodsInfo {
  @Prop
  @Watch("updateGoods")
  goods: Goods = {} as Goods
  @Link
  showSheet: boolean
  urls: string[] = [] // 要提前声明
  activeIndex: number = 0
  previewDialog: CustomDialogController | null = null

  openPreview(urls: string[], activeIndex: number) {
    this.urls = urls
    this.activeIndex = activeIndex
    // 每次打开前重建，确保传入最新的 urls 和 activeIndex
    this.previewDialog = new CustomDialogController({
      builder: HDMPreviewImage({
        urls: this.urls,
        activeIndex: this.activeIndex
      }),
      customStyle: true,
      autoCancel: false
    })
    this.previewDialog.open()
  }

  getMainPictures(): string[] {
    if (!this.goods) {
      return []
    }
    if (this.goods.mainPictures && this.goods.mainPictures.length > 0) {
      return this.goods.mainPictures
    }
    if (this.goods.picture) {
      return [this.goods.picture as string]
    }
    return []
  }

  getGoods(): Goods {
    return this.goods || {} as Goods
  }

  aboutToAppear(): void {
    this.updateGoods()
  }

  updateGoods() {
    // 不考虑第二次
    //
    if (!this.goods) {
      return
    }
    if (this.goods.picture && !this.goods.mainPictures?.length) {
      this.goods.mainPictures = [this.goods.picture as string] // 直接就一个图片数组赋值
      // this.goods.mainPictures.push(this.goods.picture as string)
    }
    // ["xxx/1.png"]
    // ["xxx/1.png", ....]
  }

  build() {
    Column() {
      // 有 多张图片显示轮播图
      // if (this.goods.mainPictures && this.goods.mainPictures.length) {
      Swiper() {
        ForEach(this.getMainPictures(), (src: string, index: number) => {
          Image(src)
            .onClick(() => {
              this.openPreview(this.getMainPictures(), index)
            })
        }) // 默认key index_JSON.stringify(item) 0_xxx
      }
      .cachedCount(5)
      .indicator(Indicator.digit()
        .right(10)
        .bottom(6))
      .width('100%')
      .aspectRatio(1)

      // }

      Column() {
        Text() {
          Span('¥ ')
          Span(this.getGoods().price)
            .fontSize(24)
        }
        .width('100%')
        .fontWeight(500)
        .fontColor($r('[ui_components].color.black'))
        .margin({ bottom: 8, top: 8 })

        Text(this.getGoods().name)
          .width('100%')
          .fontColor($r('[ui_components].color.text'))
          .margin({ bottom: 8 })
        Text(this.getGoods().desc)
          .fontSize(13)
          .width('100%')
          .fontColor($r('[ui_components].color.gray'))
          .margin({ bottom: 8 })

        Column() {
          Row({ space: 8 }) {
            Text('商品规格')
              .fontSize(13)
              .fontWeight(500)
              .fontColor($r('[ui_components].color.black'))
            Text('请选择')
              .fontSize(13)
              .fontColor($r('[ui_components].color.gray'))
            Blank()
            Image($r('[ui_components].media.ic_public_right'))
              .width(20)
              .aspectRatio(1)
              .fillColor($r('[ui_components].color.gray'))
          }
          .width('100%')
          .height(40)
          .onClick(() => this.showSheet = true)

          Row() {
            Text('无忧退货 · 快速退款 · 免费包邮')
              .fontColor($r('[ui_components].color.text'))
              .fontSize(13)
            Blank()
            Image($r('[ui_components].media.ic_public_right'))
              .width(20)
              .aspectRatio(1)
              .fillColor($r('[ui_components].color.gray'))
          }
          .width('100%')
          .height(40)
          .border({
            width: { top: 0.5 },
            color: $r('[ui_components].color.under')
          })
        }
      }
      .backgroundColor($r('[ui_components].color.white'))
      .borderRadius(8)
      .margin(8)
      .padding(8)
    }
  }
}
