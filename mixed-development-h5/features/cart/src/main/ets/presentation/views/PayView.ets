import { GlobalVariable, PAGE_PATH } from 'constants'
import { OrderItem, PayResultParams } from 'models'
import { HDMNavBar } from 'ui_components'
import { demoOrderStore } from 'storage'
import { getOrderDetailAPI } from '../../data/api'
import { formatOrderCountdown, mergeOrderState } from '../utils/OrderPresentation'
import { webview } from '@kit.ArkWeb'
import http from '@ohos.net.http'

const EXTERNAL_SCHEME_PATTERN = /^(alipays|alipay|aliwapa|itms-apps|tel|mailto|sms):/i

@Component
struct PayView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @State order: OrderItem | null = null
  @State loading: boolean = true
  @State loadFailed: boolean = false
  @State selectedChannel: number = 1
  @State paying: boolean = false
  @State countdownTick: number = 0
  @State gatewayConfigured: boolean = false
  @State gatewayChecked: boolean = false
  @State showWebPay: boolean = false
  @State webLoading: boolean = true
  @State webLoadFailed: boolean = false
  @State webErrorDetail: string = ''
  webController: webview.WebviewController = new webview.WebviewController()
  @Consume stackPath: NavPathStack
  private orderId: string = ''
  private countdownTimer: number = -1
  private countdownBaseAt: number = 0

  aboutToAppear(): void {
    const params = this.stackPath.getParamByName(PAGE_PATH.PAY_PAGE) as string[]
    this.orderId = params && params.length ? params[params.length - 1] : ''
    this.countdownTimer = setInterval(() => {
      this.countdownTick++
    }, 1000)
    this.load()
    this.checkGateway()
  }

  aboutToDisappear(): void {
    clearInterval(this.countdownTimer)
  }

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  private remainingCountdown(): number {
    if (!this.order || this.countdownTick < 0) {
      return 0
    }
    const elapsed: number = Math.floor((Date.now() - this.countdownBaseAt) / 1000)
    return this.order.countdown - elapsed
  }

  private mergedState(): number {
    if (!this.order) {
      return 1
    }
    return mergeOrderState(this.order, demoOrderStore.getOverlay(this.order.id), demoOrderStore.getEvaluation(this.order.id))
  }

  private async load(): Promise<void> {
    if (!this.orderId) {
      this.loading = false
      this.loadFailed = true
      return
    }
    this.loading = true
    this.loadFailed = false
    try {
      this.order = await getOrderDetailAPI(this.orderId)
      this.countdownBaseAt = Date.now()
      if (this.mergedState() !== 1) {
        this.stackPath.replacePath({
          name: PAGE_PATH.PAY_RESULT_PAGE,
          param: { payResult: true, orderId: this.orderId } as PayResultParams
        })
      }
    } catch {
      this.loadFailed = true
    } finally {
      this.loading = false
    }
  }

  // 探测本地 mock-pay-gateway 是否就绪，决定是否展示“支付宝沙箱支付”入口
  private async checkGateway(): Promise<void> {
    try {
      const req = http.createHttp()
      const resp: boolean = await new Promise<boolean>((resolve) => {
        req.request(GlobalVariable.PAY_GATEWAY_URL + '/health', { connectTimeout: 2500, readTimeout: 2500 }, (err, data) => {
          if (err) {
            resolve(false)
            return
          }
          try {
            const body = typeof data.result === 'string' ? JSON.parse(data.result) : data.result
            resolve(!!body.alipayConfigured)
          } catch {
            resolve(false)
          }
          req.destroy()
        })
      })
      this.gatewayConfigured = resp
    } catch {
      this.gatewayConfigured = false
    } finally {
      this.gatewayChecked = true
    }
  }

  // 本地 Mock 支付：直接置 overlay 2，体感与真支付一致
  private async handleMockPay(): Promise<void> {
    if (!this.order || this.paying) {
      return
    }
    if (this.mergedState() !== 1) {
      this.safeToast('订单已支付')
      this.stackPath.replacePath({
        name: PAGE_PATH.PAY_RESULT_PAGE,
        param: { payResult: true, orderId: this.orderId } as PayResultParams
      })
      return
    }
    if (this.remainingCountdown() <= 0 && this.order.countdown > 0) {
      this.safeToast('订单已超时，请重新下单')
      return
    }
    this.paying = true
    try {
      await demoOrderStore.setOverlay(this.order.id, 2)
      this.stackPath.replacePath({
        name: PAGE_PATH.PAY_RESULT_PAGE,
        param: { payResult: true, orderId: this.orderId } as PayResultParams
      })
    } catch {
      this.safeToast('支付失败，请重试')
    } finally {
      this.paying = false
    }
  }

  private getWebPayUrl(): string {
    if (!this.order) {
      return GlobalVariable.PAY_GATEWAY_URL + '/pay/wap/aliPay?orderId=' + encodeURIComponent(this.orderId)
    }
    return GlobalVariable.PAY_GATEWAY_URL + '/pay/wap/aliPay?orderId=' + encodeURIComponent(this.orderId) + '&amount=' + encodeURIComponent(this.order.payMoney.toFixed(2))
  }

  private openWebPay(): void {
    this.webLoadFailed = false
    this.webLoading = true
    this.webErrorDetail = ''
    this.showWebPay = true
  }

  private handleWebReturn(url: string): void {
    if (url.includes('/pay/return')) {
      const payResult: boolean = url.includes('payResult=true') || url.includes('trade_status=TRADE_SUCCESS') || url.includes('trade_status=TRADE_FINISHED')
      if (payResult) {
        demoOrderStore.setOverlay(this.orderId, 2).then(() => {
          this.stackPath.replacePath({
            name: PAGE_PATH.PAY_RESULT_PAGE,
            param: { payResult: true, orderId: this.orderId } as PayResultParams
          })
        })
      } else {
        this.showWebPay = false
        this.safeToast('支付已取消')
      }
    }
  }

  @Builder
  private ChannelRow(iconText: string, iconBg: string, title: string, desc: string, channel: number, enabled: boolean = true) {
    Row({ space: 12 }) {
      Text(iconText)
        .width(28)
        .height(28)
        .fontSize(13)
        .fontWeight(600)
        .fontColor(Color.White)
        .textAlign(TextAlign.Center)
        .backgroundColor(iconBg)
        .borderRadius(6)
        .opacity(enabled ? 1 : 0.5)
      Column({ space: 2 }) {
        Text(title)
          .fontSize(14)
          .fontColor(enabled ? $r('[ui_components].color.black') : $r('[ui_components].color.gray'))
        Text(desc)
          .fontSize(11)
          .fontColor($r('[ui_components].color.gray'))
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      if (this.selectedChannel === channel) {
        Image($r('[ui_components].media.ic_public_check_filled'))
          .width(20)
          .height(20)
          .fillColor($r('[ui_components].color.red'))
      } else {
        Stack() {}
          .width(20)
          .height(20)
          .border({ width: 1.5, color: $r('[ui_components].color.border') })
          .borderRadius(10)
      }
    }
    .width('100%')
    .padding({ top: 12, bottom: 12 })
    .opacity(enabled ? 1 : 0.9)
    .onClick(() => {
      if (enabled) {
        this.selectedChannel = channel
      }
    })
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: this.showWebPay ? '支付宝支付' : '确认付款',
          onLeftClick: () => {
            if (this.showWebPay) {
              this.showWebPay = false
            } else {
              this.stackPath.pop()
            }
          }
        })
        // WebView 真支付宝沙箱层：仅在 gatewayConfigured 时可进入，失败自动回退 Mock
        if (this.showWebPay) {
          Stack({ alignContent: Alignment.Top }) {
            if (this.webLoadFailed) {
              Column({ space: 12 }) {
                Text('沙箱支付页面加载失败')
                  .fontSize(14)
                  .fontColor($r('[ui_components].color.black'))
                if (this.webErrorDetail) {
                  Text(this.webErrorDetail)
                    .fontSize(11)
                    .fontColor($r('[ui_components].color.gray'))
                    .padding({ left: 24, right: 24 })
                    .textAlign(TextAlign.Center)
                }
                Text('请确认本地网关已启动：mock-pay-gateway / npm run dev')
                  .fontSize(11)
                  .fontColor($r('[ui_components].color.gray'))
                Button('返回模拟支付')
                  .onClick(() => { this.showWebPay = false })
                Button('重试')
                  .backgroundColor($r('[ui_components].color.white'))
                  .fontColor($r('[ui_components].color.black'))
                  .border({ width: 0.5, color: $r('[ui_components].color.border') })
                  .onClick(() => {
                    this.webLoadFailed = false
                    this.webLoading = true
                    this.webController.loadUrl(this.getWebPayUrl())
                  })
              }
              .layoutWeight(1)
              .justifyContent(FlexAlign.Center)
              .width('100%')
            } else {
              if (this.webLoading) {
                Progress({ type: ProgressType.Linear, value: 0, total: 100 })
                  .color($r('[ui_components].color.red'))
                  .zIndex(1)
              }
              Web({ src: this.getWebPayUrl(), controller: this.webController })
                .onPageBegin((event) => {
                  this.webLoading = true
                  if (event.url.includes('/pay/return') || event.url.includes('payResult')) {
                    this.handleWebReturn(event.url)
                  }
                })
                .onLoadIntercept((event) => {
                  const url: string = event.data.getRequestUrl()
                  if (EXTERNAL_SCHEME_PATTERN.test(url)) {
                    try {
                      const ctx = this.getUIContext().getHostContext() as Parameters<typeof http.createHttp>[0]
                    } catch {}
                    // 交由系统处理 alipays:// 调起支付宝
                    return false
                  }
                  if (url.includes('/pay/return')) {
                    this.handleWebReturn(url)
                  }
                  return false
                })
                .onPageEnd(() => { this.webLoading = false })
                .onErrorReceive((event) => {
                  if (event.request.isMainFrame()) {
                    this.webErrorDetail = event.error.getErrorInfo().toString()
                    this.webLoadFailed = true
                    this.webLoading = false
                  }
                })
                .onHttpErrorReceive((event) => {
                  if (event.request.isMainFrame() && event.response.getResponseCode() >= 400) {
                    this.webErrorDetail = 'HTTP ' + event.response.getResponseCode()
                    this.webLoadFailed = true
                  }
                })
                .domStorageAccess(true)
                .javaScriptAccess(true)
                .mixedMode(MixedMode.All)
                .width('100%')
                .layoutWeight(1)
            }
          }
          .width('100%')
          .layoutWeight(1)
        } else if (this.loading) {
          Column() {
            LoadingProgress().width(40).height(40).color($r('[ui_components].color.red'))
            Text('正在加载订单...').fontSize(12).fontColor($r('[ui_components].color.gray')).margin({ top: 12 })
          }
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else if (this.loadFailed || !this.order) {
          Column({ space: 12 }) {
            Text('订单加载失败').fontSize(14).fontColor($r('[ui_components].color.black'))
            Text('请检查网络后重试').fontSize(12).fontColor($r('[ui_components].color.gray'))
            Button('重新加载').onClick(() => this.load())
            Button('返回订单')
              .backgroundColor($r('[ui_components].color.white'))
              .fontColor($r('[ui_components].color.black'))
              .border({ width: 0.5, color: $r('[ui_components].color.border') })
              .onClick(() => this.stackPath.pop())
          }
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else {
          Scroll() {
            Column({ space: 12 }) {
              Column({ space: 8 }) {
                Row() {
                  Text('需付款')
                    .fontSize(13)
                    .fontColor($r('[ui_components].color.gray'))
                  Blank()
                  if (this.remainingCountdown() > 0) {
                    Text(formatOrderCountdown(this.remainingCountdown()))
                      .fontSize(12)
                      .fontColor($r('[ui_components].color.red'))
                  } else if (this.order.countdown > 0) {
                    Text('已超时')
                      .fontSize(12)
                      .fontColor($r('[ui_components].color.gray'))
                  }
                }
                .width('100%')
                Text('¥' + this.order.payMoney.toFixed(2))
                  .fontSize(32)
                  .fontWeight(600)
                  .fontColor($r('[ui_components].color.black'))
                Text('订单号 ' + this.order.id)
                  .fontSize(11)
                  .fontColor($r('[ui_components].color.gray'))
                Row({ space: 6 }) {
                  Text(this.order.totalNum.toString() + ' 件商品')
                    .fontSize(11)
                    .fontColor($r('[ui_components].color.gray'))
                  Text('|')
                    .fontSize(11)
                    .fontColor($r('[ui_components].color.border'))
                  Text(this.order.createTime + ' 下单')
                    .fontSize(11)
                    .fontColor($r('[ui_components].color.gray'))
                }
              }
              .width('100%')
              .padding(16)
              .backgroundColor($r('[ui_components].color.white'))
              .borderRadius(12)

              Column({ space: 0 }) {
                Text('选择支付方式')
                  .fontSize(13)
                  .fontWeight(500)
                  .width('100%')
                  .padding({ bottom: 4 })
                Divider().strokeWidth(0.5).color($r('[ui_components].color.border'))
                this.ChannelRow('支', '#1677FF', '支付宝', '推荐已安装支付宝的用户使用', 1, true)
                Divider().strokeWidth(0.5).color($r('[ui_components].color.border'))
                this.ChannelRow('微', '#07C160', '微信支付', '微信安全支付', 2, true)
                Divider().strokeWidth(0.5).color($r('[ui_components].color.border'))
                this.ChannelRow('余', '#FF8F1F', '余额支付', '可用余额 ¥ 999.00', 3, false)
              }
              .width('100%')
              .padding(16)
              .backgroundColor($r('[ui_components].color.white'))
              .borderRadius(12)

              Column({ space: 6 }) {
                Row({ space: 6 }) {
                  Image($r('[ui_components].media.ic_public_check_filled')).width(14).height(14).fillColor('#07C160')
                  Text('支付安全由银行级加密保障')
                    .fontSize(11)
                    .fontColor($r('[ui_components].color.gray'))
                }
                if (this.gatewayChecked && this.gatewayConfigured) {
                  Text('已连接支付宝沙箱网关，可体验真实 WebView 支付流程（沙箱不产生真实扣款）')
                    .fontSize(11)
                    .fontColor($r('[ui_components].color.gray'))
                } else if (this.gatewayChecked && !this.gatewayConfigured) {
                  Text('未检测到本地支付网关，将使用模拟支付完成演示（不产生真实扣款）')
                    .fontSize(11)
                    .fontColor($r('[ui_components].color.gray'))
                }
                Text('未完成支付的订单可在「我的订单-待付款」继续支付')
                  .fontSize(11)
                  .fontColor($r('[ui_components].color.gray'))
              }
              .width('100%')
              .padding({ left: 4, right: 4 })
              .alignItems(HorizontalAlign.Start)
            }
            .padding(12)
          }
          .layoutWeight(1)
          .scrollBar(BarState.Off)

          Column({ space: 8 }) {
            Divider().strokeWidth(0.5).color($r('[ui_components].color.border'))
            Row({ space: 12 }) {
              Column({ space: 2 }) {
                Text('实付金额')
                  .fontSize(11)
                  .fontColor($r('[ui_components].color.gray'))
                Text('¥' + this.order.payMoney.toFixed(2))
                  .fontSize(18)
                  .fontWeight(600)
                  .fontColor($r('[ui_components].color.red'))
              }
              .layoutWeight(1)
              Button(this.paying ? '支付中...' : '确认支付 ¥' + this.order.payMoney.toFixed(2))
                .height(44)
                .fontSize(14)
                .fontWeight(500)
                .layoutWeight(1)
                .backgroundColor($r('[ui_components].color.red'))
                .enabled(!this.paying)
                .onClick(() => this.handleMockPay())
            }
            .width('100%')
            if (this.gatewayConfigured) {
              Button('使用支付宝沙箱支付')
                .width('100%')
                .height(40)
                .fontSize(13)
                .fontColor($r('[ui_components].color.black'))
                .backgroundColor($r('[ui_components].color.white'))
                .border({ width: 0.5, color: $r('[ui_components].color.border') })
                .onClick(() => this.openWebPay())
            }
            .padding({ left: 16, right: 16, top: 0, bottom: 12 })
            .backgroundColor($r('[ui_components].color.white'))
          }
          .width('100%')
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('[ui_components].color.under'))
    }
    .hideTitleBar(true)
    .padding({ top: this.topHeight })
  }
}

@Builder
function PayViewBuilder() {
  PayView()
}
