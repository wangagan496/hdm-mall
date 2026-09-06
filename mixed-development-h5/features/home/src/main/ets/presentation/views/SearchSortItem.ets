import { SortField, SortMethod } from '../../domain/models'

@Component
export struct SearchSortItem {
  // 筛选字段
  field: SortField = 'publishTime'
  // 显示的文本
  label: string = ''
  // 状态变量，接收父组件的状态属性
  // 父组件的筛选字段
  @Prop sortField: SortField = 'publishTime'
  // 父组件的排序方法
  @Prop sortMethod: SortMethod = 'desc'
  onSortChange: (field: SortField, method: SortMethod) => void = () => {
  }

  private nextSortMethod(): SortMethod {
    if (this.sortField !== this.field) {
      return 'desc'
    }
    return this.sortMethod === 'desc' ? 'asc' : 'desc'
  }

  build() {
    Row() {
      Text(this.label)
        .fontWeight(500)
        .fontSize(14)
        .fontColor(this.sortField === this.field ? $r('[ui_components].color.black') : $r('[ui_components].color.gray'))
      Column() {
        Image($r('[ui_components].media.ic_public_up'))
          .width(15)
          .height(6)
          .fillColor(this.sortField === this.field && this.sortMethod === 'asc' ? $r('[ui_components].color.black') :
          $r('[ui_components].color.gray'))
        Image($r('[ui_components].media.ic_public_down'))
          .width(15)
          .height(6)
          .fillColor(this.sortField === this.field && this.sortMethod === 'desc' ? $r('[ui_components].color.black') :
          $r('[ui_components].color.gray'))
      }
      .justifyContent(FlexAlign.Center)
    }
    .onClick(() => {
      this.onSortChange(this.field, this.nextSortMethod())
    })
  }
}
