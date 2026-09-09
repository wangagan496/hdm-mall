// 通用确认弹窗：配合 bindContentCover 使用，不再依赖 CustomDialogController。
// 取消/确定只回调事件，由调用方负责关闭覆盖层。
@Preview
@Component
export struct HDMConfirm {
  message: string = ""
  onConfirm: () => void = () => {
  }
  onCancel: () => void = () => {
  }

  build() {
    Column() {
      RelativeContainer() {
        Text(this.message)
          .alignRules({
            middle: {
              anchor: '__container__',
              align: HorizontalAlign.Center
            },
            bottom: {
              anchor: 'cancel',
              align: VerticalAlign.Top
            }
          })
          .margin({
            bottom: 50
          })

        Text("取消")
          .textAlign(TextAlign.Center)
          .height(50)
          .fontColor($r("app.color.gray"))
          .alignRules({
            left: {
              anchor: '__container__',
              align: HorizontalAlign.Start
            },
            right: {
              anchor: '__container__',
              align: HorizontalAlign.Center
            },
            bottom: {
              anchor: '__container__',
              align: VerticalAlign.Bottom
            }
          })
          .id("cancel")
          .border({
            color: $r("app.color.gray"),
            width: {
              right: 0.5,
              top: 0.5
            }
          })
          .onClick(() => {
            this.onCancel()
          })
        Text("确定")
          .height(50)
          .textAlign(TextAlign.Center)
          .fontColor($r("app.color.red"))
          .border({
            color: $r("app.color.gray"),
            width: {
              top: 0.5
            }
          })
          .alignRules({
            right: {
              anchor: '__container__',
              align: HorizontalAlign.End
            },
            left: {
              anchor: '__container__',
              align: HorizontalAlign.Center
            },
            bottom: {
              anchor: '__container__',
              align: VerticalAlign.Bottom
            }
          })
          .onClick(() => {
            this.onConfirm()
          })
      }
      .height(160)
      .width(280)
      .backgroundColor($r("app.color.white"))
      .borderRadius(10)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}