import { GlobalVariable, PAGE_PATH } from 'constants'
import { PayResultParams } from 'models'
import { HDMNavBar } from 'ui_components'
import { webview } from '@kit.ArkWeb'
import { common } from '@kit.AbilityKit'
import { BusinessError } from '@kit.BasicServicesKit'
import { parsePaymentResultValue } from '../utils/PaymentPresentation'

const EXTERNAL_SCHEME_PATTERN = /^(alipays|alipay|aliwapa|itms-apps|tel|mailto|sms):/i

@Component
struct PayView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  controller: webview.WebviewController = new webview.WebviewController()
  @State orderId: string = ''
  @State loading: boolean = true
  @State loadFailed: boolean = false
  @State errorDetail: string = ''
  @Consume stackPath: NavPathStack

  aboutToAppear(): void {
    const params = this.stackPath.getParamByName(PAGE_PATH.PAY_PAGE) as string[]
    this.orderId = params && params.length ? params[params.length - 1] : ''
    if (!this.orderId) {
      this.showError('缺少订单信息，请返回重试')
    }
  }

  private getUIContextSafe(): common.UIAbilityContext | undefined {
    try {
      return this.getUIContext().getHostContext() as common.UIAbilityContext
    } catch {
      return undefined
    }
  }

  private handleExternalScheme(url: string): boolean {
    if (!EXTERNAL_SCHEME_PATTERN.test(url)) {
      return false
    }
    const context = this.getUIContextSafe()
    if (context) {
      context.openLink(url, { appLinkingOnly: false }).catch((error: BusinessError) => {
        this.showError(`未找到可处理该支付链接的应用(${error.code})`)
      })
    }
    return true
  }

  private showError(detail: string): void {
    this.errorDetail = detail
    this.loading = false
    this.loadFailed = true
  }

  private loadPayPage(): void {
    this.loadFailed = false
    this.loading = true
    try {
      this.controller.loadUrl(GlobalVariable.BASE_URL + `/pay/wap/aliPay?orderId=${this.orderId}`)
    } catch {
      this.showError('支付页面加载失败，请检查网络后重试')
    }
  }

  private parsePayResult(url: string): void {
    const payResult: boolean | undefined = parsePaymentResultValue(url)
    if (payResult === undefined) {
      return
    }
    this.stackPath.replacePath({
      name: PAGE_PATH.PAY_RESULT_PAGE,
      param: {
        payResult,
        orderId: this.orderId
      } as PayResultParams
    })
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
          if (this.errorDetail) {
            Text(this.errorDetail)
              .fontSize(12)
              .fontColor($r('[ui_components].color.gray'))
              .textAlign(TextAlign.Center)
              .padding({ left: 24, right: 24 })
          }
          Button('重新加载')
            .onClick(() => this.loadPayPage())
          Button('我已完成支付，去查看结果')
            .fontSize(13)
            .backgroundColor($r('[ui_components].color.white'))
            .fontColor($r('[ui_components].color.black'))
            .border({ width: 0.5, color: $r('[ui_components].color.border') })
            .onClick(() => {
              this.stackPath.replacePath({
                name: PAGE_PATH.PAY_RESULT_PAGE,
                param: { payResult: false, orderId: this.orderId } as PayResultParams
              })
            })
          Button('返回订单（未付款）')
            .fontSize(13)
            .backgroundColor($r('[ui_components].color.white'))
            .fontColor($r('[ui_components].color.gray'))
            .border({ width: 0.5, color: $r('[ui_components].color.border') })
            .onClick(() => {
              this.stackPath.pushPath({ name: PAGE_PATH.ORDER_PAGE, param: 1 })
            })
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
            .onControllerAttached(() => {})
            .onPageBegin((event) => {
              this.loading = true
              this.loadFailed = false
              if (event.url.includes(`${GlobalVariable.BASE_URL}/pay/redirect`)) {
                this.parsePayResult(event.url)
              }
            })
            .onLoadIntercept((event) => {
              if (EXTERNAL_SCHEME_PATTERN.test(event.data.getRequestUrl())) {
                this.handleExternalScheme(event.data.getRequestUrl())
                return true
              }
              return false
            })
            .onPageEnd(() => {
              this.loading = false
            })
            .onErrorReceive((event) => {
              if (event.request.isMainFrame()) {
                this.showError(`加载出错(${event.error.getErrorInfo()})`)
              }
            })
            .onHttpErrorReceive((event) => {
              if (event.request.isMainFrame() && event.response.getResponseCode() >= 400) {
                const code: number = event.response.getResponseCode()
                const hint: string = code === 404
                  ? '支付网关不可用(沙箱未配置)，可点下方“我已完成支付”去服务端查单，或在订单页使用沙箱降级支付'
                  : `支付服务返回错误(HTTP ${code})`
                this.showError(hint)
              }
            })
            .domStorageAccess(true)
            .javaScriptAccess(true)
            .mixedMode(MixedMode.All)
            .width('100%')
            .layoutWeight(1)
        }
        .width('100%')
        .layoutWeight(1)
      }
    }
    .hideTitleBar(true)
    .padding({ top: this.topHeight })
  }
}

@Builder
function PayViewBuilder() {
  PayView()
}
