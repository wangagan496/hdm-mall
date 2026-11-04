import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMGuess, HDMNavBar } from 'ui_components'
import { HDMUser, OrderItem, PayResultParams } from 'models'
import { demoOrderStore } from 'storage'
import { getGuessLikeAPI, getOrderDetailAPI } from '../../data/api'
import { getOrderStateText, isPaidOrderState, mergeOrderState, OrderState } from '../utils/OrderPresentation'

@Builder
function PayResultViewBuilder() {
  PayResultView()
}

@Component
export struct PayResultView {
  // 阅读顺序：取得订单号 → 向服务器查询订单 → 判断是否已付款 → 展示结果。
  // 本页只确认支付结果，不创建订单、不发起扣款。
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('reloadForCurrentAccount') user: HDMUser = {} as HDMUser
  @StorageProp(GlobalVariable.APP_FOREGROUND_SEQUENCE) @Watch('refreshAfterForeground') foregroundSequence: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  // 服务端管理的订单必须查询确认，不能直接把导航参数当作付款凭证。
  @State paymentSucceeded: boolean = false
  // 要查询哪笔订单就用哪个订单号，与接收查询结果的变量名无关。
  @State orderId: string = ''
  @State isCheckingPayment: boolean = true
  // 查询失败表示“结果未确认”，不能据此认定付款失败。
  @State paymentResultUnconfirmed: boolean = false
  @State displayedOrderState: number = 0
  @State canContinuePayment: boolean = false
  private pageActive: boolean = false
  private pageGeneration: number = 0
  private querySequence: number = 0
  private sessionToken: string = ''
  private navigationPayResult: boolean = false
  @Consume
  stackPath: NavPathStack

  aboutToAppear(): void {
    if (this.pageActive) return
    this.pageActive = true
    this.pageGeneration++
    this.confirmPaymentResult()
  }

  aboutToDisappear(): void {
    this.pageActive = false
    this.pageGeneration++
    this.querySequence++
    this.resetPaymentDisplay()
  }

  private readPaymentNavigation(): PayResultParams | undefined {
    // 第一步：取出这次打开页面时携带的订单号和初步支付结果。
    const navigationEntries = this.stackPath.getParamByName(PAGE_PATH.PAY_RESULT_PAGE) as PayResultParams[]
    if (!navigationEntries || navigationEntries.length === 0 || !navigationEntries[navigationEntries.length - 1]) {
      return undefined
    }
    return navigationEntries[navigationEntries.length - 1]
  }

  private resetPaymentDisplay(): void {
    this.paymentSucceeded = false
    this.displayedOrderState = 0
    this.canContinuePayment = false
    this.isCheckingPayment = false
    this.paymentResultUnconfirmed = true
  }

  private synchronizePaymentContext(): void {
    const navigation: PayResultParams | undefined = this.readPaymentNavigation()
    const token: string = this.user.token || ''
    const orderId: string = navigation?.orderId || ''
    this.navigationPayResult = navigation?.payResult === true
    if (token === this.sessionToken && orderId === this.orderId) return
    this.sessionToken = token
    this.orderId = orderId
    this.pageGeneration++
    this.querySequence++
    this.resetPaymentDisplay()
  }

  private reloadForCurrentAccount(): void {
    if ((this.user.token || '') === this.sessionToken) return
    this.synchronizePaymentContext()
    if (this.pageActive) this.confirmPaymentResult()
  }

  private refreshAfterForeground(): void {
    if (this.pageActive) this.confirmPaymentResult()
  }

  private isCurrentPaymentContext(generation: number, token: string, orderId: string): boolean {
    return this.pageActive && generation === this.pageGeneration && token.length > 0 &&
      token === this.sessionToken && token === (this.user.token || '') && orderId.length > 0 &&
      orderId === this.orderId && orderId === this.readPaymentNavigation()?.orderId
  }

  // 第二步：根据订单号确认支付结果；首次进入和点击“重新查询”都走这里。
  private async confirmPaymentResult(): Promise<void> {
    this.synchronizePaymentContext()
    const sequence: number = ++this.querySequence
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const orderId: string = this.orderId
    this.resetPaymentDisplay()
    if (!this.isCurrentPaymentContext(generation, token, orderId)) {
      return
    }
    this.isCheckingPayment = true
    this.paymentResultUnconfirmed = false
    try {
      // this.orderId 指定查哪笔订单；await 等查询结束；latestOrder 保存查回的订单信息。
      const latestOrder: OrderItem = await getOrderDetailAPI(orderId, token)
      if (sequence !== this.querySequence || !this.isCurrentPaymentContext(generation, token, orderId)) return
      if (latestOrder.id !== orderId) {
        this.paymentResultUnconfirmed = true
        return
      }
      this.updatePaymentDisplayFromOrder(latestOrder)
    } catch {
      if (sequence !== this.querySequence || !this.isCurrentPaymentContext(generation, token, orderId)) return
      // 保留旧演示模式的本地结果兜底；不代表真实扣款确认。
      if (this.tryShowSavedDemoPayment()) {
        return
      }
      this.paymentResultUnconfirmed = true
      this.paymentSucceeded = false
    } finally {
      // 查到结果或查询失败，都结束“正在确认”的等待画面。
      if (sequence === this.querySequence && this.isCurrentPaymentContext(generation, token, orderId)) {
        this.isCheckingPayment = false
      }
    }
  }

  // 第三步：把订单状态转换为页面结果，区分服务端订单和旧演示订单。
  private updatePaymentDisplayFromOrder(latestOrder: OrderItem): void {
    const savedDemoProgress = demoOrderStore.getOverlay(this.orderId)
    const savedDemoEvaluation = demoOrderStore.getEvaluation(this.orderId)
    // mergeOrderState 对服务端管理的订单直接采用服务端状态，不叠加本地演示进度。
    this.displayedOrderState = mergeOrderState(latestOrder, savedDemoProgress, savedDemoEvaluation)
    // 已进入待发货、待收货、待评价或已完成的订单，都算已付款。
    const orderHasBeenPaid: boolean = isPaidOrderState(this.displayedOrderState)
    if (latestOrder.serverManaged || !GlobalVariable.DEMO_ORDER_FLOW) {
      this.paymentSucceeded = orderHasBeenPaid
    } else {
      // 旧演示订单保留原有兼容规则，也接受上一页传来的成功结果。
      this.paymentSucceeded = this.displayedOrderState !== OrderState.CANCELLED &&
        (orderHasBeenPaid || this.navigationPayResult)
    }
    this.canContinuePayment = latestOrder.serverManaged ? latestOrder.canPay === true : GlobalVariable.DEMO_ORDER_FLOW
  }

  private tryShowSavedDemoPayment(): boolean {
    if (!GlobalVariable.DEMO_ORDER_FLOW) return false
    const savedDemoProgress = demoOrderStore.getOverlay(this.orderId)
    if (savedDemoProgress && isPaidOrderState(savedDemoProgress.advancedState)) {
      this.displayedOrderState = savedDemoProgress.advancedState
      this.paymentSucceeded = true
      return true
    }
    return false
  }

  // 第四步：先区分“查询中／未确认”，再显示已确认的支付结果。
  private getPageTitle(): string {
    if (this.isCheckingPayment || this.paymentResultUnconfirmed) {
      return '确认支付结果'
    }
    return this.getPaymentResultTitle()
  }

  private getPaymentResultTitle(): string {
    if (this.paymentResultUnconfirmed) {
      return '支付结果待确认'
    }
    if (this.displayedOrderState === OrderState.CANCELLED) return '订单已取消'
    return this.paymentSucceeded ? '支付成功' : '未付款'
  }

  private getOrderProgressHint(): string {
    if (this.paymentSucceeded) {
      if (this.displayedOrderState === OrderState.AWAITING_SHIPMENT) {
        return '支付成功，商家将尽快为你发货'
      }
      if (this.displayedOrderState === OrderState.AWAITING_RECEIPT) {
        return '商家已发货，请留意物流信息'
      }
      if (this.displayedOrderState === OrderState.AWAITING_REVIEW) {
        return '快去评价，分享你的使用体验'
      }
      if (this.displayedOrderState === OrderState.COMPLETED) {
        return '订单已完成，感谢你的支持'
      }
      return '支付成功'
    }
    if (this.displayedOrderState === OrderState.AWAITING_PAYMENT) {
      return '订单尚未支付，可在订单页继续支付'
    }
    if (this.displayedOrderState === OrderState.CANCELLED) {
      return '订单已取消'
    }
    return getOrderStateText(this.displayedOrderState)
  }

  private canOpenResultDestination(): boolean {
    return !this.isCheckingPayment && this.isCurrentPaymentContext(this.pageGeneration, this.sessionToken, this.orderId)
  }

  private shouldOpenCashier(): boolean {
    return this.canOpenResultDestination() && !this.paymentResultUnconfirmed && !this.paymentSucceeded &&
      this.displayedOrderState === OrderState.AWAITING_PAYMENT && this.canContinuePayment
  }

  // 只有已确认待付款且有支付权限时返回收银台，其余结果查看订单。
  private openOrderListOrCashier(): void {
    if (!this.canOpenResultDestination()) return
    if (this.shouldOpenCashier()) {
      this.stackPath.replacePath({ name: PAGE_PATH.PAY_PAGE, param: this.orderId })
    } else {
      this.stackPath.pushPath({ name: PAGE_PATH.ORDER_PAGE, param: 0 })
    }
  }

  // 以下为页面展示：等待画面、结果文案、重查入口和导航按钮。
  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: this.getPageTitle()
        })
        List() {
          ListItem() {
            Column({ space: 20 }) {
              if (this.isCheckingPayment) {
                LoadingProgress()
                  .width(60)
                  .height(60)
                  .color($r('[ui_components].color.red'))
              } else {
                Image(this.paymentSucceeded ? $r('[ui_components].media.ic_public_check_filled') :
                $r('[ui_components].media.ic_public_close_filled'))
                  .width(60)
                  .height(60)
                  .fillColor(this.paymentSucceeded ? '#07C160' : '#B0171F')
                Text(this.getPaymentResultTitle())
                  .fontSize(20)
                  .fontWeight(600)
              }
              if (this.isCheckingPayment) {
                Text('正在确认支付结果…')
                  .fontSize(13)
                  .fontColor($r('[ui_components].color.gray'))
              } else if (this.paymentResultUnconfirmed) {
                Text('网络开小差了，请稍后在订单列表查看状态')
                  .fontSize(13)
                  .fontColor($r('[ui_components].color.gray'))
                Button('重新查询')
                  .fontSize(13)
                  .height(32)
                  .onClick(() => this.confirmPaymentResult())
              } else {
                Text(this.getOrderProgressHint())
                  .fontSize(13)
                  .fontColor($r('[ui_components].color.gray'))
              }
              Row({ space: 12 }) {
                Button('返回首页')
                  .backgroundColor($r('[ui_components].color.black'))
                  .fontSize(14)
                  .height(36)
                  .onClick(() => {
                    this.stackPath.popToIndex(-1)
                    this.stackPath.clear()
                  })
                Button(this.shouldOpenCashier() ? '去支付' : '查看订单')
                  .enabled(this.canOpenResultDestination())
                  .fontSize(14)
                  .height(36)
                  .backgroundColor(this.shouldOpenCashier() ? $r('[ui_components].color.red') : $r('[ui_components].color.white'))
                  .fontColor(this.shouldOpenCashier() ? Color.White : $r('[ui_components].color.black'))
                  .border({ width: this.shouldOpenCashier() ? 0 : 0.5, color: $r('[ui_components].color.border') })
                  .onClick(() => {
                    this.openOrderListOrCashier()
                  })
              }
              .width('100%')
              .justifyContent(FlexAlign.Center)
            }
            .padding(40)
            .backgroundColor($r('[ui_components].color.under'))
          }

          ListItem() {
            HDMGuess({ loader: getGuessLikeAPI })
              .height('100%')
          }
        }
        .layoutWeight(1)
        .height('100%')
        .width('100%')
        .scrollBar(BarState.Off)
      }
    }
    .hideTitleBar(true)
    .onShown(() => this.aboutToAppear())
    .onHidden(() => this.aboutToDisappear())
    .padding({
      top: this.topHeight
    })
  }
}
