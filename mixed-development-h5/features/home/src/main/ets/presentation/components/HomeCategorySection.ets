import { BusinessVariable } from 'constants'
import { BreakPointType, CategoryItem } from 'models'

@Component
export struct HomeCategorySection {
  @Prop categories: CategoryItem[] = []
  @StorageProp('break_point') breakPoint: string = ""

  build() {
    List({
      space: new BreakPointType({ sm: 14, md: 36, lg: 72 }).getValue(this.breakPoint)
    }) {
      ForEach(this.categories, (item: CategoryItem) => {
        ListItem() {
          Column() {
            Image(item.picture)
              .width(56)
              .aspectRatio(1)
            Text(item.name)
              .fontSize(10)
              .fontColor('#CC191919')
          }
          .width(60).height(80).borderRadius(30).clip(true)
          .backgroundImage(item.picture)
          .backgroundImageSize(ImageSize.Contain)
          .backgroundImagePosition(Alignment.Center)
          .backgroundBlurStyle(BlurStyle.BACKGROUND_ULTRA_THICK, { scale: 0.25 })
        }
        .onClick(() => {
          AppStorage.setOrCreate(BusinessVariable.CATEGORY_TARGET_ID, item.id)
          AppStorage.setOrCreate('currentTabIndex', 1)
        })
      })
    }
    .width('100%').height(92).scrollBar(BarState.Off)
    .listDirection(Axis.Horizontal).alignListItem(ListItemAlign.Center)
  }
}
