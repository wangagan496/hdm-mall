import { Goods } from "../../domain/models"
import { returnPolicyLabel } from 'models'
import { excludeFailedPicture } from '../../data/api/goodsPresentation'

@Component
export struct GoodsInfo {
  @Prop
  @Watch("updateGoods")
  goods: Goods = {} as Goods
  @Link
  showSheet: boolean
  @State displayPictures: string[] = []
  onPreview: (urls: string[], activeIndex: number) => void = () => {
  }

  openPreview(activeIndex: number) {
    this.onPreview(this.displayPictures, activeIndex)
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

  canSelectSpecification(): boolean {
    return this.goods?.status !== 'off' && this.goods?.available !== false
  }

  specificationLabel(): string { return this.canSelectSpecification() ? '请选择' : '暂不可选' }

  openSpecifications(): void {
    if (this.canSelectSpecification()) this.showSheet = true
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
                this.openPreview(index)
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

        Text(returnPolicyLabel(this.getGoods()) + (this.getGoods().returnPolicy === 'confirm-required' ? '，下单时需确认' : ''))
          .id('goods-return-policy').fontSize(14).width('100%').fontColor($r('[ui_components].color.text')).margin({ bottom: 8 })
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
            Text(this.specificationLabel())
              .fontSize(13)
              .fontColor($r('[ui_components].color.gray'))
            Blank()
            if (this.canSelectSpecification()) {
              Image($r('[ui_components].media.ic_public_right'))
                .id('goods-specification-arrow')
                .width(20)
                .aspectRatio(1)
                .fillColor($r('[ui_components].color.gray'))
            }
          }
          .width('100%')
          .height(40)
          .id('goods-specification')
          .enabled(this.canSelectSpecification())
          .onClick(() => this.openSpecifications())

          Row() {
            Text('售后按下单规则处理 · 退款原路退回')
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
