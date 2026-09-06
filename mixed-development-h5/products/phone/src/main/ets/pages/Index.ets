@Entry
@Component
struct Index {
  @StorageProp('safe_area_bottom') bottomHeight: number = 0

  build() {
    Column({ space: 16 }) {
      Text('HDM Mall Framework')
        .fontSize(28)
        .fontWeight(FontWeight.Bold)
      Text('功能分支的共享 HarmonyOS 启动框架')
        .fontSize(16)
        .fontColor('#666666')
      Text('从 home、category、cart、mine 等功能分支进入具体演示')
        .fontSize(14)
        .fontColor('#888888')
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .padding({ bottom: this.bottomHeight, left: 24, right: 24 })
  }
}
