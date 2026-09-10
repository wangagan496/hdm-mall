import { GlobalVariable, PAGE_PATH } from 'constants'
import { PayResultParams } from 'models'
import { HDMNavBar } from 'ui_components'
import { webview } from '@kit.ArkWeb'
import { common } from '@kit.AbilityKit'
import { BusinessError } from '@kit.BasicServicesKit'
import { isDemoPaymentOrder, parsePaymentResultValue } from '../utils/PaymentPresentation'
import { DemoPaymentGateway, PaymentGateway, PaymentResultRouteParams, PaymentStatus } from '../utils/DemoPaymentGateway'

// H5 收银台可能跳转的非 http(s) 协议（支付宝/支付宝钱包唤起链接），交给系统处理
const EXTERNAL_SCHEME_PATTERN = /^(alipays|alipay|aliwapa|itms-apps|tel|mailto|sms):/i

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
  @State
  errorDetail: string = ''
  @State
  demoMode: boolean = false
  @State
  demoSubmitting: boolean = false
  private pageActive: boolean = false
  @Consume
  stackPath: NavPathStack

  aboutToAppear(): void {
    this.pageActive = true
    const params = this.stackPath.getParamByName(PAGE_PATH.PAY_PAGE) as string[]
    this.orderId = params && params.length ? params[params.length - 1] : ''
    this.demoMode = isDemoPaymentOrder(this.orderId)
    if (!this.orderId) {
      this.showError('缺少订单信息，请返回重试')
    }
  }

  aboutToDisappear(): void {
    this.pageActive = false
  }

  private async finishDemoPayment(status: PaymentStatus): Promise<void> {
    if (this.demoSubmitting || !this.demoMode) {
      return
    }
    this.demoSubmitting = true
    this.errorDetail = ''
    try {
      const gateway: PaymentGateway = new DemoPaymentGateway(status)
      const result = await gateway.requestPayment(this.orderId)
      if (!this.pageActive) {
        return
      }
      const params: PaymentResultRouteParams = {
        payResult: result.status === PaymentStatus.SUCCESS,
        orderId: this.orderId,
        demoStatus: result.status
      }
      this.stackPath.replacePath({ name: PAGE_PATH.PAY_RESULT_PAGE, param: params })
    } catch {
      this.errorDetail = '演示回调失败，请重试'
    } finally {
      this.demoSubmitting = false
    }
  }

  @Builder
  DemoPaymentBuilder() {
    Scroll() {
    Column({ space: 18 }) {
      Text('支付回调演示')
        .fontSize(22)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('[ui_components].color.black'))
      Text('本地模拟，未调用支付宝 SDK。不会创建服务端订单、打开支付宝或产生扣款。')
        .fontSize(14)
        .fontColor($r('[ui_components].color.gray'))
        .textAlign(TextAlign.Center)
        .padding({ left: 28, right: 28 })
      Text(this.demoSubmitting ? '正在处理演示回调…' : '选择要验证的支付结果')
        .fontSize(14)
        .fontColor($r('[ui_components].color.text'))
      Button('模拟支付成功')
        .id('payment-demo-success')
        .width('82%')
        .height(44)
        .backgroundColor($r('[ui_components].color.red'))
        .enabled(!this.demoSubmitting)
        .onClick(() => this.finishDemoPayment(PaymentStatus.SUCCESS))
      Button('模拟支付失败')
        .id('payment-demo-failed')
        .width('82%')
        .height(44)
        .backgroundColor($r('[ui_components].color.black'))
        .enabled(!this.demoSubmitting)
        .onClick(() => this.finishDemoPayment(PaymentStatus.FAILED))
      Button('模拟取消支付')
        .id('payment-demo-cancelled')
        .width('82%')
        .height(44)
        .backgroundColor($r('[ui_components].color.white'))
        .fontColor($r('[ui_components].color.black'))
        .border({ width: 0.5, color: $r('[ui_components].color.border') })
        .enabled(!this.demoSubmitting)
        .onClick(() => this.finishDemoPayment(PaymentStatus.CANCELLED))
      Button('模拟支付待确认')
        .id('payment-demo-pending')
        .width('82%')
        .height(44)
        .backgroundColor($r('[ui_components].color.white'))
        .fontColor($r('[ui_components].color.black'))
        .border({ width: 0.5, color: $r('[ui_components].color.border') })
        .enabled(!this.demoSubmitting)
        .onClick(() => this.finishDemoPayment(PaymentStatus.PENDING))
      if (this.errorDetail) {
        Text(this.errorDetail)
          .fontSize(14)
          .fontColor($r('[ui_components].color.red'))
      }
    }
    .width('100%')
    .padding({ top: 24, bottom: 32 })
    .justifyContent(FlexAlign.Center)
    }
    .width('100%')
    .layoutWeight(1)
    .scrollBar(BarState.Off)
  }

  private getUIContextSafe(): common.UIAbilityContext | undefined {
    try {
      return this.getUIContext().getHostContext() as common.UIAbilityContext
    } catch {
      return undefined
    }
  }

  // 拦截支付 H5 发出的外部协议跳转（如唤起支付宝），用系统 OpenLink 处理
  private handleExternalScheme(url: string): boolean {
    if (!EXTERNAL_SCHEME_PATTERN.test(url)) {
      return false
    }
    const context = this.getUIContextSafe()
    if (context) {
      context.openLink(url, { appLinkingOnly: false }).catch((error: BusinessError) => {
        // 设备未装支付宝等目标应用时兜底提示，避免无响应
        this.showError(`未找到可处理该支付链接的应用（${error.code}）`)
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
      // 首次进入或失败后主动加载收银台；controller.refresh() 仅对已加载页面有效
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
        title: this.demoMode ? '支付演示（不扣款）' : '支付',
        onLeftClick: () => this.stackPath.pop()
      })
      if (this.demoMode) {
        this.DemoPaymentBuilder()
      } else if (this.loadFailed) {
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
            .onControllerAttached(() => {
              // 首次创建时加载，失败重试时 loadUrl 已在按钮回调中处理
            })
            .onPageBegin((event) => {
              this.loading = true
              this.loadFailed = false
              if (event.url.includes(`${GlobalVariable.BASE_URL}/pay/redirect`)) {
                this.parsePayResult(event.url)
              }
            })
            .onLoadIntercept((event) => {
              // 支付 H5 内部跳出的 alipays:/ 等外部协议交给系统，不放进 Web
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
              // 仅拦截主文档错误；子资源（图片等）失败不阻断支付流程
              if (event.request.isMainFrame()) {
                this.showError(`加载出错（${event.error.getErrorInfo()}）`)
              }
            })
            .onHttpErrorReceive((event) => {
              // 网关返回 404/500 等时页面本身能"加载成功"，需按状态码接管为友好提示
              if (event.request.isMainFrame() && event.response.getResponseCode() >= 400) {
                const code: number = event.response.getResponseCode()
                const hint: string = code === 404
                  ? '支付网关不可用（服务端沙箱配置问题，请反馈老师更新支付宝沙箱网关）'
                  : `支付服务返回错误（HTTP ${code}）`
                this.showError(hint)
              }
            })
            .domStorageAccess(true)
            .javaScriptAccess(true)
            .mixedMode(MixedMode.All)
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
