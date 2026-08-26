import { BreakPointEnum, BreakPointType } from 'models'
import { Banner } from '../../domain/models'

@Component
export struct HomeBannerSection {
  @Prop banners: Banner[] = []
  @StorageProp('break_point') breakPoint: string = ""

  build() {
    Swiper() {
      ForEach(this.banners, (item: Banner) => {
        Image(item.imgUrl)
      })
    }
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
  }
}
