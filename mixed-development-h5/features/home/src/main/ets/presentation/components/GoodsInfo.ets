import { HDMPreviewImage } from 'ui_components'
import { Goods } from "../../domain/models"
import { excludeFailedPicture } from '../../data/api/goodsPresentation'

@Component
export struct GoodsInfo {
  @Prop
  @Watch("updateGoods")
  goods: Goods = {} as Goods
  @Link
  showSheet: boolean
  @State displayPictures: string[] = []
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
    return this.displayPictures
  }

  getGoods(): Goods {
    return this.goods || {} as Goods
  }

  getDisplayPrice(): string {
    const price: string | number = this.getGoods().price
    return price ? Number(price).toString() : ''
  }

  aboutToAppear(): void {
    this.updateGoods()
  }

  updateGoods() {
    if (!this.goods) {
      this.displayPictures = []
      return
    }

    const candidates: string[] = []
    if (this.goods.mainPictures && this.goods.mainPictures.length > 0) {
      this.goods.mainPictures.forEach((picture: string): void => {
        if (picture && !candidates.includes(picture)) {
          candidates.push(picture)
        }
      })
    } else if (typeof this.goods.picture === 'string' && this.goods.picture) {
      candidates.push(this.goods.picture)
    }
    this.displayPictures = candidates
  }

  removeFailedPicture(src: string): void {
    this.displayPictures = excludeFailedPicture(this.displayPictures, src)
  }

  build() {
    Column() {
      if (this.displayPictures.length > 0) {
        Swiper() {
          ForEach(this.displayPictures, (src: string, index: number) => {
            Image(src)
              .alt($r('[ui_components].media.ic_public_empty'))
              .objectFit(ImageFit.Contain)
              .accessibilityText(`商品图片${index + 1}`)
              .onError(() => {
                this.removeFailedPicture(src)
              })
              .onClick(() => {
                this.openPreview(this.displayPictures, index)
              })
          }, (src: string): string => src)
        }
        .cachedCount(5)
        .indicator(Indicator.digit()
          .right(10)
          .bottom(6))
        .width('100%')
        .aspectRatio(1)
      } else {
        Image($r('[ui_components].media.ic_public_empty'))
          .objectFit(ImageFit.Contain)
          .accessibilityText('商品图片加载失败')
          .width('100%')
          .aspectRatio(1)
      }

      Column() {
        // 与列表卡片共用数值格式，同时避免异步刷新后价格 Span 丢失。
        Text('¥ ' + this.getDisplayPrice())
          .fontSize(24)
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
