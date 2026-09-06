import { GlobalVariable, PAGE_PATH } from 'constants'
import { PayResultParams } from 'models'
import { HDMNavBar } from 'ui_components'
import { webview } from '@kit.ArkWeb'

@Component
struct PayView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  controller: webview.WebviewController = new webview.WebviewController()
  @State
  orderId: string = ""
  @State
  loading: boolean = true
  @State
  loadFailed: boolean = false
  @Consume
  stackPath: NavPathStack

  aboutToAppear(): void {
    const params = this.stackPath.getParamByName(PAGE_PATH.PAY_PAGE) as string[]
    this.orderId = params[params.length - 1]
  }

  private reloadPayment(): void {
    this.loadFailed = false
    this.loading = true
    try {
      this.controller.refresh()
    } catch {
      this.loading = false
      this.loadFailed = true
    }
  }

  build() {
    NavDestination() {
      HDMNavBar({
        title: '支付',
        onLeftClick: () => this.stackPath.pop()
      })
      if (this.loadFailed) {
        Column({ space: 12 }) {
          Text('支付页面加载失败，请检查网络后重试')
            .fontSize(14)
            .fontColor($r('[ui_components].color.gray'))
          Button('重新加载')
            .onClick(() => this.reloadPayment())
        }
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        Stack({ alignContent: Alignment.Top }) {
          if (this.loading) {
            Progress({ type: ProgressType.Linear, value: 0, total: 100 })
              .color($r('[ui_components].color.red'))
              .zIndex(1)
          }
          Web({
            src: GlobalVariable.BASE_URL + `/pay/wap/aliPay?orderId=${this.orderId}`,
            controller: this.controller
          })
            .onPageBegin((event) => {
              this.loading = true
              if (event.url.includes(`${GlobalVariable.BASE_URL}/pay/redirect`)) {
            // 支付结果
            let arr = event.url.split("?")
            if (arr.length > 1) {
              let params = arr[1].split("&")
              // payResult
              // orderId
              let objArr = params[0].split("=") // [id=1, age=2]
              // let key = objArr[0] // key payResult
              let value = objArr[1] // value true/false
              this.stackPath.replacePath({
                name: PAGE_PATH.PAY_RESULT_PAGE,
                param: {
                  payResult: value === "true",
                  orderId: this.orderId
                } as PayResultParams
              })
            }
              }
            })
            .onPageEnd(() => {
              this.loading = false
            })
            .onErrorReceive(() => {
              this.loading = false
              this.loadFailed = true
            })
            .width("100%")
            .layoutWeight(1)
        }
        .width('100%')
        .layoutWeight(1)
      }
    }
    .hideTitleBar(true)
    .padding({
      top: this.topHeight
    })
  }
}

@Builder
function PayViewBuilder() {
  PayView()
}
