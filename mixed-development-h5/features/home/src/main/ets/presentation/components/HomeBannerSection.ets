import { BreakPointEnum, BreakPointType } from 'models'
import { Banner } from '../../domain/models'

@Component
export struct HomeBannerSection {
  @Prop banners: Banner[] = []
  onBannerClick: (banner: Banner) => void = () => {}
  @StorageProp('break_point') breakPoint: string = ""

  private getAccessibilityText(banner: Banner): string {
    if (banner.id === '48') {
      return '查看女神新包商品'
    }
    if (banner.id === '42') {
      return '查看暖冬上新季商品'
    }
    return '查看活动商品'
  }

  build() {
    if (this.banners.length > 0) {
      Swiper() {
        ForEach(this.banners, (item: Banner) => {
          Image(item.imgUrl)
            .width('100%')
            .height('100%')
            .objectFit(ImageFit.Cover)
            .focusable(true)
            .accessibilityText(this.getAccessibilityText(item))
            .onClick((): void => this.onBannerClick(item))
        })
      }
      .aspectRatio(1.5)
      .displayCount(
        new BreakPointType({ sm: 1, md: 2, lg: 3 }).getValue(this.breakPoint)
      )
      .itemSpace(
        new BreakPointType({ sm: 0, md: 10, lg: 20 }).getValue(this.breakPoint)
      )
      .indicator(
        this.breakPoint === BreakPointEnum.sm ?
          DotIndicator.dot()
            .itemWidth(8).itemHeight(4).color('#33191919')
            .selectedItemWidth(24).selectedItemHeight(4).selectedColor('#191919') : false
      )
    } else {
      Column({ space: 8 }) {
        Text('品质好物  每日上新')
          .fontSize(28)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('[ui_components].color.white'))
        Text('惠多美商城 · 精选放心购')
          .fontSize(15)
          .fontColor('#E6FFFFFF')
      }
      .width('100%')
      .aspectRatio(1.5)
      .padding({ left: 24, top: 72 })
      .alignItems(HorizontalAlign.Start)
      .linearGradient({
        angle: 135,
        colors: [['#FF2737', 0.0], ['#FF773C', 1.0]]
      })
    }
  }
}
