@Preview
@Component
export struct HDMLoadingText {
  title: string = '惠多美商城'

  build() {
    Column({ space: 12 }) {
      LoadingProgress()
        .width(36)
        .height(36)
        .color($r('app.color.red'))
      Text(this.title)
        .fontSize(18)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.black'))
      Text('正在为你准备精选好物')
        .fontSize(12)
        .fontColor($r('app.color.gray'))
    }
    .justifyContent(FlexAlign.Center)
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.under'))
    .accessibilityText(`${this.title}，正在加载`)
  }
}
