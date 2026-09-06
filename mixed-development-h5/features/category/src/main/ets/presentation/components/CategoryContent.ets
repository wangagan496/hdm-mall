import { CategoryItem, CategoryItemChild } from 'models'

@Component
export struct CategoryContent {
  @Prop category: CategoryItem = {} as CategoryItem
  onSubClick: (sub: CategoryItemChild) => void = () => {}

  build() {
    Scroll() {
      Column() {
        Image(this.category.picture || "")
          .width('100%')
          .height(136)
          .objectFit(ImageFit.Contain)
          .backgroundColor('#f6f6f6')
          .borderRadius(8)
          .margin({ bottom: 8 })

        GridRow({ columns: { sm: 2, md: 3, lg: 4 }, gutter: 8 }) {
          ForEach(
            this.category.children || [],
            (sub: CategoryItemChild) => {
              GridCol() {
                Column() {
                  Image(sub.picture)
                    .width(64)
                    .aspectRatio(1)
                  Text(sub.name)
                    .fontSize(14)
                    .fontColor($r('[ui_components].color.text'))
                    .margin({ top: 8 })
                }
                .height('100%')
                .justifyContent(FlexAlign.Center)
              }
              .aspectRatio(1)
              .backgroundColor('#f6f6f6')
              .borderRadius(8)
              .onClick(() => this.onSubClick(sub))
            }
          )
        }
      }
      .padding(8)
    }
    .layoutWeight(1)
    .scrollBar(BarState.Off)
    .edgeEffect(EdgeEffect.Spring)
  }
}
