import { SortField, SortMethod } from '../viewmodel'

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
  // TODO 点击筛选条件，回传  sortField 和 sortMethod 给父组件（回调函数）
  onSortChange: (field: SortField, method: SortMethod) => void = () => {
  }

  build() {
    Row() {
      Text(this.label)
        .fontWeight(500)
        .fontSize(14)
        .fontColor(this.sortField === this.field ? $r('[basic].color.black') : $r('[basic].color.gray'))
      Column() {
        Image($r('[basic].media.ic_public_up'))
          .width(15)
          .height(6)
          .fillColor(this.sortField === this.field && this.sortMethod === 'asc' ? $r('[basic].color.black') :
          $r('[basic].color.gray'))
        Image($r('[basic].media.ic_public_down'))
          .width(15)
          .height(6)
          .fillColor(this.sortField === this.field && this.sortMethod === 'desc' ? $r('[basic].color.black') :
          $r('[basic].color.gray'))
      }
      .justifyContent(FlexAlign.Center)
    }
    .onClick(() => {
      //
      this.onSortChange(this.field, this.sortMethod === "desc" ? 'asc' : 'desc')
    })
  }
}