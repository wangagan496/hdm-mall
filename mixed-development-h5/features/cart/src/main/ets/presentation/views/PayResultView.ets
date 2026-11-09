import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMGuess, HDMNavBar } from 'ui_components'
import { HDMUser, OrderItem, PayResultParams } from 'models'
import { demoOrderStore } from 'storage'
import { getGuessLikeAPI, getOrderDetailAPI, refreshPaymentAPI } from '../../data/api'
import { getOrderStateText, isPaidOrderState, mergeOrderState, OrderState } from '../utils/OrderPresentation'
import { orderCancellation } from '../utils/OrderCancellation'

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
  @State paymentState: string = 'none'
  @State paymentNotice: string = ''
  @State canCancelOrder: boolean = false
  @State automaticRefreshExpired: boolean = false
  @State refreshingPayment: boolean = false
  @State paymentAmount: number = 0
  @State cancelling: boolean = false
  @State pageActive: boolean = false
  private pageGeneration: number = 0
  private querySequence: number = 0
  @State sessionToken: string = ''
  private navigationPayResult: boolean = false
  private paymentRefreshTimer: number = -1
  private paymentRefreshElapsed: number = 0
  private paymentRefreshSequence: number = 0
  private cancellationDialogSequence: number = 0
  @Consume
  stackPath: NavPathStack

  aboutToAppear(): void {
    if (this.pageActive) {
      if (this.readPaymentNavigation()?.orderId !== this.orderId || (this.user.token || '') !== this.sessionToken) {
        this.confirmPaymentResult()
      }
      return
    }
    this.pageActive = true
    this.pageGeneration++
    this.confirmPaymentResult()
  }

  aboutToDisappear(): void {
    this.pageActive = false
    this.pageGeneration++
    this.querySequence++
    this.stopPaymentRefresh(true)
    this.cancellationDialogSequence++
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
    this.paymentState = 'none'
    this.paymentNotice = ''
    this.canCancelOrder = false
    this.paymentAmount = 0
    this.automaticRefreshExpired = this.paymentRefreshElapsed >= 30000
    this.refreshingPayment = false
    this.cancelling = false
  }

  private stopPaymentRefresh(resetElapsed: boolean = false): void {
    if (this.paymentRefreshTimer >= 0) {
      clearInterval(this.paymentRefreshTimer)
      this.paymentRefreshTimer = -1
    }
    this.paymentRefreshSequence++
    this.refreshingPayment = false
    if (resetElapsed) {
      this.paymentRefreshElapsed = 0
      this.automaticRefreshExpired = false
    }
  }

  private synchronizePaymentContext(): void {
    const navigation: PayResultParams | undefined = this.readPaymentNavigation()
    const token: string = this.user.token || ''
    const orderId: string = navigation?.orderId || ''
    this.navigationPayResult = navigation?.payResult === true
    if (token === this.sessionToken && orderId === this.orderId) return
    this.stopPaymentRefresh(true)
    this.cancellationDialogSequence++
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
    if (this.pageActive) {
      if (this.paymentState === 'confirming' || this.paymentState === 'review' || this.paymentResultUnconfirmed) {
        this.refreshPaymentStatus(false)
      } else {
        this.confirmPaymentResult()
      }
    }
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
    this.stopPaymentRefresh()
    this.resetPaymentDisplay()
    if (!this.isCurrentPaymentContext(generation, token, orderId)) {
      return
    }
    this.isCheckingPayment = true
    this.paymentResultUnconfirmed = false
    this.startPaymentRefresh()
    try {
      // this.orderId 指定查哪笔订单；await 等查询结束；latestOrder 保存查回的订单信息。
      const latestOrder: OrderItem = await getOrderDetailAPI(orderId, token)
      if (sequence !== this.querySequence || !this.isCurrentPaymentContext(generation, token, orderId)) return
      if (latestOrder.id !== orderId) {
        this.paymentResultUnconfirmed = true
        this.startPaymentRefresh()
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
      this.startPaymentRefresh()
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
    this.paymentState = latestOrder.paymentState || 'none'
    this.paymentNotice = latestOrder.paymentNotice || ''
    this.canCancelOrder = latestOrder.canCancel === true
    this.paymentAmount = latestOrder.payMoney || 0
    if (this.paymentState === 'confirming' || this.paymentState === 'review') {
      this.paymentSucceeded = false
      this.paymentResultUnconfirmed = true
      this.startPaymentRefresh()
    } else {
      this.stopPaymentRefresh()
      this.paymentResultUnconfirmed = false
    }
  }

  private startPaymentRefresh(): void {
    if (GlobalVariable.DEMO_ORDER_FLOW) return
    if (this.paymentRefreshTimer >= 0 || this.automaticRefreshExpired || !this.pageActive ||
      !this.isCurrentPaymentContext(this.pageGeneration, this.sessionToken, this.orderId)) return
    this.paymentRefreshTimer = setInterval(() => {
      if (!this.pageActive || !this.isCurrentPaymentContext(this.pageGeneration, this.sessionToken, this.orderId)) {
        this.stopPaymentRefresh()
        return
      }
      this.paymentRefreshElapsed += 2000
      if (this.paymentRefreshElapsed >= 30000) {
        clearInterval(this.paymentRefreshTimer)
        this.paymentRefreshTimer = -1
        this.automaticRefreshExpired = true
      }
      this.refreshPaymentStatus(false)
    }, 2000)
  }

  private async refreshPaymentStatus(manual: boolean): Promise<void> {
    if (!this.pageActive || (this.refreshingPayment && !manual) ||
      !this.isCurrentPaymentContext(this.pageGeneration, this.sessionToken, this.orderId)) return
    if (this.isCheckingPayment) {
      this.querySequence++
      this.isCheckingPayment = false
      this.paymentResultUnconfirmed = true
    }
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const orderId: string = this.orderId
    const sequence: number = ++this.paymentRefreshSequence
    this.refreshingPayment = true
    try {
      const fields = await refreshPaymentAPI(orderId, token)
      if (sequence !== this.paymentRefreshSequence || !this.isCurrentPaymentContext(generation, token, orderId)) return
      if (fields.paymentState) this.paymentState = fields.paymentState
      if (fields.paymentNotice !== undefined) this.paymentNotice = fields.paymentNotice
      if (fields.canCancel !== undefined) this.canCancelOrder = fields.canCancel
      if (fields.paymentState === 'confirming' || fields.paymentState === 'review') {
        this.paymentResultUnconfirmed = true
        this.paymentSucceeded = false
        if (this.paymentAmount > 0) return
      }
      const latestOrder: OrderItem = await getOrderDetailAPI(orderId, token)
      if (sequence !== this.paymentRefreshSequence || !this.isCurrentPaymentContext(generation, token, orderId)) return
      if (latestOrder.id !== orderId) throw new Error('订单结果不匹配')
      this.updatePaymentDisplayFromOrder(latestOrder)
    } catch {
      if (sequence === this.paymentRefreshSequence && this.isCurrentPaymentContext(generation, token, orderId)) {
        this.paymentResultUnconfirmed = true
        this.paymentSucceeded = false
        this.startPaymentRefresh()
      }
    } finally {
      if (sequence === this.paymentRefreshSequence && this.isCurrentPaymentContext(generation, token, orderId)) {
        this.refreshingPayment = false
      }
    }
  }

  private safeToast(message: string): void {
    try { this.getUIContext().getPromptAction().showToast({ message }) } catch {}
  }

  private cancellationMessage(): string {
    return '付款可能已经成功。取消后，如已扣款，¥' + this.paymentAmount.toFixed(2) + '将原路退回付款账户。确定取消吗？'
  }

  private requestCancelOrder(): void {
    if (this.cancelling || this.paymentAmount <= 0 || !this.canCancelOrder || !this.canOpenResultDestination() ||
      (this.paymentState !== 'confirming' && this.paymentState !== 'review')) return
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const orderId: string = this.orderId
    const sequence: number = ++this.cancellationDialogSequence
    this.getUIContext().showAlertDialog({
      title: '确认取消订单',
      message: this.cancellationMessage(),
      primaryButton: { value: '再等等', action: () => { this.cancellationDialogSequence++ } },
      secondaryButton: { value: '确认取消', action: () => {
        if (sequence !== this.cancellationDialogSequence || this.cancelling || !this.canCancelOrder ||
          !this.isCurrentPaymentContext(generation, token, orderId)) return
        this.cancellationDialogSequence++
        this.cancelling = true
        orderCancellation.confirm(orderId).then(() => {
          if (this.isCurrentPaymentContext(generation, token, orderId)) this.confirmPaymentResult()
        }).catch((error: Error) => {
          if (this.isCurrentPaymentContext(generation, token, orderId)) this.safeToast('取消结果待确认，请稍后查询')
        }).finally(() => {
          if (this.isCurrentPaymentContext(generation, token, orderId)) this.cancelling = false
        })
      } }
    })
  }

  private getPaymentResultHint(): string {
    if (GlobalVariable.DEMO_ORDER_FLOW) {
      if (this.isCheckingPayment) return '正在确认支付结果…'
      if (this.paymentResultUnconfirmed) return '网络开小差了，请稍后在订单列表查看状态'
      return this.getOrderProgressHint()
    }
    if (this.isCheckingPayment) return '正在确认付款结果，请勿重复付款'
    if (this.displayedOrderState === OrderState.CANCELLED) return this.paymentNotice || this.getOrderProgressHint()
    if (this.paymentState === 'review') return this.paymentNotice || '我们正在核实这笔付款。如已扣款，核实后会原路退回或完成订单。'
    if (this.paymentState === 'confirming' || this.paymentResultUnconfirmed) {
      if (this.automaticRefreshExpired) return '付款结果仍在确认中，可能需要几分钟。不会重复扣款，确认后订单会自动更新。'
      return '正在确认付款结果，请勿重复付款'
    }
    return this.paymentNotice || this.getOrderProgressHint()
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
    if (this.displayedOrderState === OrderState.CANCELLED) return '订单已取消'
    if (this.isCheckingPayment || this.paymentResultUnconfirmed) {
      return '确认支付结果'
    }
    return this.getPaymentResultTitle()
  }

  private getPaymentResultTitle(): string {
    if (this.displayedOrderState === OrderState.CANCELLED) return '订单已取消'
    if (this.paymentResultUnconfirmed) {
      return '支付结果待确认'
    }
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
      this.stackPath.pushPath({ name: PAGE_PATH.ORDER_DETAIL_PAGE, param: this.orderId })
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
                Text(this.getPaymentResultHint())
                  .fontSize(13)
                  .fontColor($r('[ui_components].color.gray'))
              } else if (this.paymentResultUnconfirmed) {
                Text(this.getPaymentResultHint())
                  .fontSize(13)
                  .fontColor($r('[ui_components].color.gray'))
                if (GlobalVariable.DEMO_ORDER_FLOW) {
                  Button('重新查询').fontSize(13).height(32).onClick(() => this.confirmPaymentResult())
                } else if (this.automaticRefreshExpired) {
                  Button(this.refreshingPayment ? '正在刷新' : '手动刷新')
                    .fontSize(13)
                    .height(32)
                    .enabled(!this.cancelling)
                    .onClick(() => this.refreshPaymentStatus(true))
                }
              } else {
                Text(this.getPaymentResultHint())
                  .fontSize(13)
                  .fontColor($r('[ui_components].color.gray'))
              }
              Row({ space: 12 }) {
                Button('全部订单')
                  .backgroundColor($r('[ui_components].color.black'))
                  .fontSize(14)
                  .height(36)
                  .onClick(() => {
                    this.stackPath.pushPath({ name: PAGE_PATH.ORDER_PAGE, param: 0 })
                  })
                Button(this.shouldOpenCashier() ? '去支付' : '查看本单')
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
              if (this.automaticRefreshExpired && this.canCancelOrder &&
                (this.paymentState === 'confirming' || this.paymentState === 'review')) {
                Button('取消订单')
                  .fontSize(13)
                  .height(36)
                  .enabled(!this.cancelling && this.paymentAmount > 0)
                  .onClick(() => this.requestCancelOrder())
              }
              if (this.paymentState === 'review' || this.paymentNotice.includes('人工')) {
                Button('帮助与客服').onClick(() => this.stackPath.pushPath({ name: PAGE_PATH.CUSTOMER_SERVICE_PAGE }))
              }
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
