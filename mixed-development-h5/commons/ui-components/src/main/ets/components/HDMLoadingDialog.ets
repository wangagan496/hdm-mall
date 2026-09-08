import { HDMProgressLoading } from './HDMProgressLoading'

// 通用加载弹层：配合 bindContentCover 使用，不再依赖 CustomDialogController。
@Component
export struct HDMLoadingDialog {
  title: string = "加载中..."

  build() {
    Column() {
      Column({ space: 10 }) {
        HDMProgressLoading({
          loadingColor: $r("app.color.loading_foreground")
        })
          .width(30)
        Text(this.title)
          .fontColor($r("app.color.loading_foreground"))
      }
      .width(100)
      .aspectRatio(1)
      .borderRadius(10)
      .backgroundColor("rgba(0,0,0, 0.5)")
      .justifyContent(FlexAlign.Center)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}
