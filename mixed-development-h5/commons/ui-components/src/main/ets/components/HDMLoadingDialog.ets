import { HDMProgressLoading } from './HDMProgressLoading'

@CustomDialog
@Component
export struct HDMLoadingDialog {
  controller: CustomDialogController
  title: string = "加载中..."

  build() {
    Column({ space: 10 }) {
      HDMProgressLoading({
        loadingColor: $r("app.color.white")
      })
        .width(30)
      Text(this.title)
        .fontColor($r("app.color.white"))
    }
    .width(100)
    .aspectRatio(1)
    .borderRadius(10)
    .backgroundColor("rgba(0,0,0, 0.5)")
    .justifyContent(FlexAlign.Center)
  }
}
