import { CategoryItem } from 'models'

@Component
export struct CategorySideBar {
  @Prop categories: CategoryItem[] = []
  @Link activeIndex: number
  onSelect: (index: number) => void = () => {}

  build() {
    List() {
      ForEach(this.categories, (item: CategoryItem, i: number) => {
        ListItem() {
          Text(item.name)
            .backgroundColor(this.activeIndex === i ? $r('[ui_components].color.black') : $r('[ui_components].color.white'))
            .fontSize(14)
            .fontColor(this.activeIndex === i ? $r('[ui_components].color.white') : $r('[ui_components].color.black'))
            .textAlign(TextAlign.Center)
            .width('100%')
            .height(56)
            .onClick(() => this.onSelect(i))
        }
      })
    }
    .width(88)
    .scrollBar(BarState.Off)
    .border({ width: { right: 0.5 }, color: $r('[ui_components].color.under') })
  }
}
