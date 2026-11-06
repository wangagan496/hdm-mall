import { cancelActions } from 'storage'
import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMUser, CancelActionIntent, OrderItem, OrderListParams, OrderPage, OrderSku, OrderRefund, formatBeijingTime } from 'models'
import { HDMEmpty, HDMNavBar } from 'ui_components'
import {
  remindShipmentAPI,
  getOrderListAPI,
  receiptOrderAPI
} from '../../data/api'
import { getPaymentDisplayLabel, getRefundDisplayLine, hasUnreadPaymentNotice, shouldShowPaymentCountdown, canOpenPayment,
  OrderState, readPhoneClockMillis, isOrderStateInTab, secondsLeftToPay } from '../utils/OrderPresentation'
import { OrderCountdown } from '../components'
import { loadOrderTabPage, mergeOrdersForTab, OrderTabAPI, OrderTabRequest } from '../utils/OrderTabLoader'
import { orderCancellation, CancellationStateChanged } from '../utils/OrderCancellation'

interface OrderTab {
  label: string
  state: number
}

@Builder
function OrderViewBuilder() {
  OrderView()
}

@Component
export struct OrderView {
  @StorageProp(GlobalVariable.APP_FOREGROUND_SEQUENCE) @Watch('refreshAfterForeground') foregroundSequence: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY)
  @Watch('onUserChanged')
  user: HDMUser = {
    avatar: '',
    token: '',
    nickname: '',
    account: ''
  }
  // 订单列表流程：进入页面／切换栏目／返回本页／操作订单后 → reloadOrders 从第 1 页重新取；
  // 滑到底部或点“加载更多” → loadMore 接着取下一页。分页、筛选和排序在 OrderTabLoader.ets。
  @State orders: OrderItem[] = []
  /** 当前选中的栏目，对应 OrderState，0 表示“全部” */
  @State selectedState: number = OrderState.ALL_TAB
  /** 正在加载；一次只允许一个加载请求在跑 */
  @State loading: boolean = false
  @State loadFailed: boolean = false
  @State busyOrderId: string = ''
  @State busyAction: string = ''
  @State pendingCancellations: string[] = []
  @State pendingCancelActions: string[] = []
  /** 服务端已经没有更多订单；为 true 时滑到底也不再请求 */
  @State isFinished: boolean = false
  @Consume stackPath: NavPathStack
  /** 拿到订单那一刻的时间，倒计时按它算已经过了多久 */
  private countdownBaseAt: number = 0

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  /** 下次“加载更多”从第几页开始 */
  private page: number = 1
  private readonly pageSize: number = 10
  /** 每次重新加载加一；请求返回时编号对不上，说明用户已切走，结果作废 */
  private requestGeneration: number = 0
  @State pageGeneration: number = 0
  @State pageActive: boolean = true
  @State sessionToken: string = ''
  private recoverySequence: number = 0
  @State loadedToken: string = ''
  @State loadedState: number = OrderState.ALL_TAB
  @State replaceOnNextLoad: boolean = false
  private hasShown: boolean = false
  private cancellationDialogSequence: number = 0
  private readonly tabs: OrderTab[] = [
    { label: '全部', state: OrderState.ALL_TAB },
    { label: '待付款', state: OrderState.AWAITING_PAYMENT },
    { label: '待发货', state: OrderState.AWAITING_SHIPMENT },
    { label: '待收货', state: OrderState.AWAITING_RECEIPT },
    { label: '待评价', state: OrderState.AWAITING_REVIEW }
  ]

  aboutToAppear(): void {
    this.pageActive = true
    const routeStates: number[] = this.stackPath.getParamByName(PAGE_PATH.ORDER_PAGE) as number[]
    const routeState: number | undefined = routeStates[routeStates.length - 1]
    if (routeState !== undefined && this.isSupportedOrderState(routeState)) {
      this.selectedState = routeState
    }
    this.reloadOrders()
  }

  private onUserChanged(): void {
    if ((this.user.token || '') !== this.sessionToken) {
      this.reloadOrders()
    }
  }

  private refreshAfterForeground(): void {
    if (this.pageActive) this.reloadOrders()
  }

  aboutToDisappear(): void {
    this.hideOrders()
  }

  private hideOrders(): void {
    this.pageActive = false
    this.pageGeneration++
    this.requestGeneration++
    this.recoverySequence++
    this.loading = false
    this.busyOrderId = ''
    this.busyAction = ''
  }

  private synchronizeOrderSession(): void {
    const token: string = this.user.token || ''
    if (token === this.sessionToken) return
    this.sessionToken = token
    this.pageGeneration++
    this.requestGeneration++
    this.recoverySequence++
    this.orders = []
    this.pendingCancellations = []
    this.pendingCancelActions = []
    this.busyOrderId = ''
    this.busyAction = ''
    this.loadedToken = ''
  }

  private isCurrentSession(generation: number, token: string): boolean {
    return this.pageActive && generation === this.pageGeneration && token.length > 0 &&
      token === this.sessionToken && token === (this.user.token || '')
  }

  private isOrderListReady(): boolean {
    return this.isCurrentSession(this.pageGeneration, this.sessionToken) && !this.replaceOnNextLoad &&
      !this.loadFailed && this.loadedToken === this.sessionToken && this.loadedState === this.selectedState
  }

  private canUseOrder(orderId: string, allowPending: boolean = false): boolean {
    return this.isOrderListReady() && !this.pendingCancelActions.includes(orderId) && (this.orders.some((order: OrderItem) => order.id === orderId) ||
      (allowPending && this.pendingCancellations.includes(orderId)))
  }

  /** 从详情、支付或评价页返回时，重新取一遍，显示服务端最新状态。首次显示已在 aboutToAppear 加载过。 */
  private refreshOnReturn(): void {
    const wasHidden: boolean = !this.pageActive
    this.pageActive = true
    if (!this.hasShown && !wasHidden) {
      this.hasShown = true
      return
    }
    this.hasShown = true
    this.reloadOrders()
  }

  private isSupportedOrderState(orderState: number): boolean {
    return this.tabs.some((tab: OrderTab) => tab.state === orderState)
  }

  private async recoverAllCancellations(): Promise<void> {
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const recovery: number = ++this.recoverySequence
    for (const orderId of this.pendingCancelActions.slice()) {
      if (recovery !== this.recoverySequence || !this.isCurrentSession(generation, token) || this.busyOrderId) return
      await this.runCancelAction(orderId, 'request', true)
    }
    if (this.isCurrentSession(generation, token) && recovery === this.recoverySequence) await this.recoverCancellations()
  }

  private async recoverCancellations(): Promise<void> {
    if (!this.isOrderListReady() || this.busyOrderId) return
    const recovery: number = ++this.recoverySequence
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    this.pendingCancellations = orderCancellation.pendingIds()
    for (const orderId of this.pendingCancellations.slice()) {
      if (recovery !== this.recoverySequence || !this.isCurrentSession(generation, token) ||
        !this.isOrderListReady() || this.busyOrderId) return
      await this.runOrderAction(orderId, 'cancel', () => orderCancellation.confirm(orderId, true), '订单已取消', true)
    }
  }

  /** 从第 1 页刷新；只保留同账号、同栏目已显示的订单，成功后替换。 */
  private async reloadOrders(): Promise<void> {
    this.synchronizeOrderSession()
    const token: string = this.sessionToken
    const generation: number = this.pageGeneration
    const accountChanged: boolean = token !== this.loadedToken
    const tabChanged: boolean = this.selectedState !== this.loadedState
    this.requestGeneration++
    this.page = 1
    // 换账号或栏目时清掉旧列表，避免在新栏目下展示其他状态的订单。
    if (accountChanged || tabChanged) {
      this.orders = []
    }
    this.replaceOnNextLoad = true
    this.isFinished = false
    this.loadFailed = false
    this.loading = false
    if (!this.isCurrentSession(generation, token)) return
    await this.loadMore()
  }

  /** 接着取下一屏订单，追加到列表后面。 */
  private async loadMore(): Promise<void> {
    const token: string = this.sessionToken
    const pageGeneration: number = this.pageGeneration
    const shouldSkip: boolean = this.loading || this.isFinished || !this.isCurrentSession(pageGeneration, token)
    if (shouldSkip) {
      return
    }
    const generation: number = this.requestGeneration
    const isLatestLoad = (): boolean => generation === this.requestGeneration &&
      this.isCurrentSession(pageGeneration, token)
    const replaceResult: boolean = this.replaceOnNextLoad
    const request: OrderTabRequest = {
      page: this.page,
      pageSize: this.pageSize,
      state: this.selectedState
    }
    const api: OrderTabAPI = {
      getPage: (params: OrderListParams): Promise<OrderPage> => getOrderListAPI(params, token),
      isCurrent: isLatestLoad
    }
    this.loading = true
    this.loadFailed = false
    try {
      const result = await loadOrderTabPage(request, api)
      if (!result || !isLatestLoad()) {
        return
      }
      this.rebaseCountdowns()
      this.orders = replaceResult ? result.items : mergeOrdersForTab(this.orders, result.items, request)
      this.pendingCancelActions = cancelActions.pending().filter(record => record.action === 'request' || record.action === 'withdraw').map(record => record.orderId)
      this.loadedToken = token
      this.loadedState = request.state
      if (replaceResult) {
        this.replaceOnNextLoad = false
      }
      this.page = result.nextPage
      this.isFinished = result.finished
    } catch {
      if (isLatestLoad()) {
        this.loadFailed = true
      }
    } finally {
      // 旧请求结束时不能关掉新请求的加载状态。
      if (isLatestLoad()) {
        this.loading = false
      }
    }
    // 包括失败后的“加载更多”重试；只在最新列表确认后恢复已有取消意图。
    if (isLatestLoad() && this.isOrderListReady() && !this.busyOrderId) this.recoverAllCancellations()
  }

  private hasEvaluation(order: OrderItem): boolean {
    return !!order.evaluation
  }

  private hasOrderActions(order: OrderItem): boolean {
    return order.orderState !== OrderState.CANCELLED
  }

  private rebaseCountdowns(): void {
    this.orders = this.orders.map((order: OrderItem) => {
      order.countdown = secondsLeftToPay(order.countdown, this.countdownBaseAt)
      return order
    })
    this.countdownBaseAt = readPhoneClockMillis()
  }

  private selectTab(orderState: number): void {
    if (this.selectedState === orderState) {
      return
    }
    this.selectedState = orderState
    this.reloadOrders()
  }

  private async runOrderAction(orderId: string, action: string, task: () => Promise<OrderItem>, successText: string,
    allowPending: boolean = false): Promise<void> {
    if (this.busyOrderId || !orderId || !this.canUseOrder(orderId, allowPending)) {
      return
    }
    this.busyOrderId = orderId
    this.busyAction = action
    const generation: number = this.requestGeneration
    const pageGeneration: number = this.pageGeneration
    const token: string = this.sessionToken
    try {
      const updated = await task()
      if (!this.isCurrentSession(pageGeneration, token)) {
        return
      }
      this.safeToast(successText)
      // 期间刷新或换栏目时重读当前列表；不能把旧快照当作当前栏目的完整结果。
      if (generation !== this.requestGeneration || !this.isOrderListReady() ||
        !updated || updated.id !== orderId || !updated.orderState || !updated.skus) {
        await this.reloadOrders()
        return
      }
      this.requestGeneration++
      this.loading = false
      const previousCount: number = this.orders.length
      this.rebaseCountdowns()
      this.orders = this.orders.map((order: OrderItem) => order.id === orderId ? updated : order)
        .filter((order: OrderItem) => isOrderStateInTab(order.orderState, this.selectedState))
      // 移出栏目后重复读取边界页并去重，避免 OFFSET 左移漏单。
      if (this.orders.length < previousCount) {
        this.page = Math.max(1, this.page - 1)
        this.isFinished = false
      }
    } catch (error) {
      if (this.isCurrentSession(pageGeneration, token)) {
        if (action === 'cancel' && generation === this.requestGeneration && !orderCancellation.pendingIds().includes(orderId)) {
          if ((error as CancellationStateChanged).orderState === OrderState.AWAITING_SHIPMENT && this.selectedState === OrderState.AWAITING_PAYMENT) {
            this.selectedState = OrderState.AWAITING_SHIPMENT
          }
          await this.reloadOrders()
          if (!this.isCurrentSession(pageGeneration, token)) return
          const current = this.orders.find((item: OrderItem) => item.id === orderId)
          if (current?.orderState === OrderState.AWAITING_SHIPMENT) {
            this.safeToast('付款已确认，请重新申请取消')
            return
          }
        }
        this.safeToast((error as Error).message || '操作失败，请稍后重试')
      }
    } finally {
      if (this.isCurrentSession(pageGeneration, token)) {
        this.pendingCancellations = orderCancellation.pendingIds()
        this.busyOrderId = ''
        this.busyAction = ''
      }
    }
  }

  private isBusy(orderId: string): boolean {
    return this.busyOrderId === orderId
  }

  private goPay(orderId: string): void {
    const order: OrderItem | undefined = this.orders.find((item: OrderItem) => item.id === orderId)
    if (this.busyOrderId || !order || !canOpenPayment(order) || !this.canUseOrder(orderId)) return
    this.stackPath.pushPath({ name: PAGE_PATH.PAY_PAGE, param: orderId })
  }

  private async runCancelAction(orderId: string, action: 'request' | 'withdraw', resume: boolean = false): Promise<void> {
    if (this.busyOrderId || !this.isOrderListReady()) return
    const order = this.orders.find((item: OrderItem) => item.id === orderId)
    if (!resume && (!order || this.pendingCancelActions.includes(orderId) ||
      (action === 'request' ? !order.canRequestCancel : !order.canWithdrawCancel))) return
    const generation: number = this.pageGeneration
    const query: number = this.requestGeneration
    const token: string = this.sessionToken
    this.busyOrderId = orderId
    this.busyAction = 'cancel-request'
    try {
      if (resume) await cancelActions.recover(orderId, token)
      else {
        const intent: CancelActionIntent = { orderId, cancelRequestId: action === 'withdraw' ? order?.cancelRequest?.id || '' : '', action, reason: '' }
        await cancelActions.confirm(intent, token)
      }
      if (query === this.requestGeneration && this.isCurrentSession(generation, token)) this.safeToast('取消操作已确认')
    } catch (error) {
      if (query === this.requestGeneration && this.isCurrentSession(generation, token)) this.safeToast((error as Error).message)
    } finally {
      if (this.isCurrentSession(generation, token)) {
        this.pendingCancelActions = cancelActions.pending().filter(record => record.action === 'request' || record.action === 'withdraw').map(record => record.orderId)
        if (query === this.requestGeneration) await this.reloadOrders()
        if (this.isCurrentSession(generation, token)) { this.busyOrderId = ''; this.busyAction = '' }
      }
    }
  }

  private requestPaidCancellation(order: OrderItem): void {
    const current = this.orders.find((item: OrderItem) => item.id === order.id)
    if (!current?.canRequestCancel || !current.cancelConfirmation || this.busyOrderId || !this.canUseOrder(order.id)) return
    const message: string = current.cancelConfirmation.message
    const requestId: string = current.cancelRequest?.id || ''
    const generation: number = this.pageGeneration
    const query: number = this.requestGeneration
    const token: string = this.sessionToken
    const dialog: number = ++this.cancellationDialogSequence
    this.getUIContext().showAlertDialog({
      title: '申请取消订单', message,
      primaryButton: { value: '再等等', action: () => { this.cancellationDialogSequence++ } },
      secondaryButton: { value: '确定申请', action: () => {
        const latest = this.orders.find((item: OrderItem) => item.id === order.id)
        if (dialog !== this.cancellationDialogSequence || query !== this.requestGeneration ||
          !this.isCurrentSession(generation, token) || !latest?.canRequestCancel ||
          latest.cancelConfirmation?.message !== message || (latest.cancelRequest?.id || '') !== requestId) return
        this.cancellationDialogSequence++
        this.runCancelAction(order.id, 'request')
      } }
    })
  }

  private requestCancelOrder(order: OrderItem): void {
    if (order.canRequestCancel && (order.serverManaged || !GlobalVariable.DEMO_ORDER_FLOW)) {
      this.requestPaidCancellation(order)
      return
    }
    const current: OrderItem | undefined = this.orders.find((item: OrderItem) => item.id === order.id)
    if (!current || current.orderState !== OrderState.AWAITING_PAYMENT || current.canCancel === false ||
      this.busyOrderId || !this.canUseOrder(order.id)) return
    if (current.paymentState !== 'confirming' && current.paymentState !== 'review') {
      this.runOrderAction(current.id, 'cancel', (): Promise<OrderItem> => orderCancellation.confirm(current.id), '订单已取消')
      return
    }
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const orderId: string = current.id
    const dialog: number = ++this.cancellationDialogSequence
    this.getUIContext().showAlertDialog({
      title: '确认取消订单',
      message: '付款可能已经成功。取消后，如已扣款，¥' + current.payMoney.toFixed(2) + '将原路退回付款账户。确定取消吗？',
      primaryButton: { value: '再等等', action: () => { this.cancellationDialogSequence++ } },
      secondaryButton: { value: '确认取消', action: () => {
        if (dialog !== this.cancellationDialogSequence || !this.isCurrentSession(generation, token)) return
        const latest: OrderItem | undefined = this.orders.find((item: OrderItem) => item.id === orderId)
        if (!latest || (latest.paymentState !== 'confirming' && latest.paymentState !== 'review') ||
          latest.canCancel === false || !this.canUseOrder(orderId)) return
        this.cancellationDialogSequence++
        this.runOrderAction(orderId, 'cancel', (): Promise<OrderItem> => orderCancellation.confirm(orderId), '订单已取消')
      } }
    })
  }

  // 打开订单详情页，并把用户点击的订单号带过去；这里只跳转，不查询详情。
  private openOrderDetail(selectedOrderId: string): void {
    if (this.busyOrderId || !this.canUseOrder(selectedOrderId)) return
    this.stackPath.pushPath({
      name: PAGE_PATH.ORDER_DETAIL_PAGE, // name 是框架字段：要打开哪个页面。
      param: selectedOrderId // param 是框架字段：带给详情页的订单号。
    })
  }

  private async runConsignment(orderId: string): Promise<OrderItem> {
    return await remindShipmentAPI(orderId, this.sessionToken)
  }

  private async runReceipt(orderId: string): Promise<OrderItem> {
    return await receiptOrderAPI(orderId, this.sessionToken)
  }

  private async runComment(orderId: string): Promise<void> {
    if (this.busyOrderId || !this.canUseOrder(orderId)) return
    this.stackPath.pushPath({ name: PAGE_PATH.EVALUATION_PAGE, param: orderId })
  }

  @Builder
  private OrderSkuRow(sku: OrderSku) {
    Row({ space: 10 }) {
      Image(sku.image)
        .width(72)
        .height(72)
        .sourceSize({ width: 216, height: 216 })
        .objectFit(ImageFit.Cover)
        .borderRadius(4)
        .backgroundColor($r('[ui_components].color.under'))
      Column({ space: 6 }) {
        Text(sku.name)
          .fontSize(13)
          .fontColor($r('[ui_components].color.black'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Row() {
          Text(sku.attrsText || '默认规格')
            .fontSize(11)
            .fontColor($r('[ui_components].color.gray'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
          Text('x' + sku.quantity.toString())
            .fontSize(12)
            .fontColor($r('[ui_components].color.gray'))
        }
        .width('100%')
        Row() {
          Text('¥' + sku.realPay.toFixed(2))
            .fontSize(14)
            .fontColor($r('[ui_components].color.black'))
          Blank()
          Text('¥' + sku.curPrice.toFixed(2))
            .fontSize(11)
            .fontColor($r('[ui_components].color.gray'))
            .decoration({ type: TextDecorationType.LineThrough })
        }
        .width('100%')
      }
      .layoutWeight(1)
      .height(72)
      .justifyContent(FlexAlign.SpaceBetween)
    }
    .width('100%')
    .padding({ top: 10, bottom: 10 })
  }

  @Builder
  private OrderActions(order: OrderItem) {
    if (order.orderState === OrderState.AWAITING_PAYMENT) {
      Row({ space: 8 }) {
        Blank()
        Button(this.isBusy(order.id) && this.busyAction === 'cancel' ? '正在确认取消结果' : '取消订单')
          .height(32)
          .fontSize(12)
          .fontColor($r('[ui_components].color.gray'))
          .backgroundColor($r('[ui_components].color.white'))
          .border({ width: 0.5, color: $r('[ui_components].color.border') })
          .enabled(!this.busyOrderId && this.canUseOrder(order.id) && order.canCancel !== false)
          .onClick(() => {
            this.requestCancelOrder(order)
          })
        if (canOpenPayment(order)) {
          Button('去支付')
            .enabled(!this.busyOrderId && this.canUseOrder(order.id))
            .height(32)
            .fontSize(12)
            .backgroundColor($r('[ui_components].color.red'))
            .onClick(() => this.goPay(order.id))
        }
      }
      .width('100%')
      .padding({ bottom: 10 })
    } else if (order.orderState === OrderState.AWAITING_SHIPMENT) {
      Row({ space: 8 }) {
        Blank()
        if (order.cancelRequest?.state === 'pending') {
          if (order.canWithdrawCancel) {
            Button('撤回申请').height(32).fontSize(12)
              .enabled(!this.busyOrderId && this.canUseOrder(order.id))
              .onClick(() => this.runCancelAction(order.id, 'withdraw'))
          }
        } else {
          if (order.canRequestCancel && (order.serverManaged || !GlobalVariable.DEMO_ORDER_FLOW)) {
            Button('取消订单').height(32).fontSize(12)
              .enabled(!this.busyOrderId && this.canUseOrder(order.id))
              .onClick(() => this.requestCancelOrder(order))
          }
          Button(this.isBusy(order.id) ? '处理中...' : '提醒发货')
            .height(32).fontSize(12)
            .fontColor($r('[ui_components].color.gray'))
            .backgroundColor($r('[ui_components].color.white'))
            .border({ width: 0.5, color: $r('[ui_components].color.border') })
            .enabled(!this.busyOrderId && this.canUseOrder(order.id))
            .onClick(() => this.runOrderAction(order.id, 'consignment', (): Promise<OrderItem> => this.runConsignment(order.id), '已提醒商家发货'))
        }
      }
      .width('100%')
      .padding({ bottom: 10 })
    } else if (order.orderState === OrderState.AWAITING_RECEIPT) {
      Row({ space: 8 }) {
        Blank()
        Button('查看物流')
          .height(32)
          .fontSize(12)
          .fontColor($r('[ui_components].color.gray'))
          .backgroundColor($r('[ui_components].color.white'))
          .border({ width: 0.5, color: $r('[ui_components].color.border') })
          .onClick(() => this.openOrderDetail(order.id))
        Button(this.isBusy(order.id) ? '确认中...' : '确认收货')
          .height(32)
          .fontSize(12)
          .backgroundColor($r('[ui_components].color.red'))
          .enabled(!this.busyOrderId && this.canUseOrder(order.id))
          .onClick(() => this.runOrderAction(order.id, 'receipt', (): Promise<OrderItem> => this.runReceipt(order.id), '已确认收货'))
      }
      .width('100%')
      .padding({ bottom: 10 })
    } else if (order.orderState === OrderState.AWAITING_REVIEW) {
      Row({ space: 8 }) {
        Blank()
        Button('去评价')
          .height(32)
          .fontSize(12)
          .fontColor($r('[ui_components].color.red'))
          .backgroundColor($r('[ui_components].color.white'))
          .border({ width: 0.5, color: $r('[ui_components].color.red') })
          .enabled(!this.busyOrderId && this.canUseOrder(order.id))
          .onClick(() => this.runComment(order.id))
      }
      .width('100%')
      .padding({ bottom: 10 })
    }
  }

  @Builder
  private OrderCard(order: OrderItem) {
    Column() {
      Column() {
        Row({ space: 6 }) {
          Text(formatBeijingTime(order.createTime))
            .fontSize(11)
            .fontColor($r('[ui_components].color.gray'))
          if (order.orderState === OrderState.AWAITING_PAYMENT) {
            if (shouldShowPaymentCountdown(order)) {
              OrderCountdown({ countdown: order.countdown, baseAt: this.countdownBaseAt })
            }
          }
          Blank()
          if (hasUnreadPaymentNotice(order)) {
            Text('●').fontSize(10).fontColor('#D93025')
          }
          Text(getPaymentDisplayLabel(order))
            .fontSize(13)
            .fontColor($r('[ui_components].color.red'))
        }
        .width('100%')
        .padding({ top: 12, bottom: 2 })
        if (order.cancelRequestNotice) {
          Text(order.cancelRequestNotice).fontSize(12).width('100%').padding(4)
        }
        if (order.cancelRequest?.state === 'pending') {
          Text('处理截止：' + formatBeijingTime(order.cancelRequest.deadlineAt))
            .fontSize(12).width('100%').padding(4)
        }
        if (order.paymentNotice) {
          Text(order.paymentNotice)
            .fontSize(12)
            .fontColor($r('[ui_components].color.gray'))
            .width('100%')
            .padding({ top: 4, bottom: 4 })
        }
        if (order.refunds && order.refunds.length > 0) {
          ForEach(order.refunds, (refund: OrderRefund) => {
            Text(getRefundDisplayLine(refund))
              .fontSize(12)
              .fontColor($r('[ui_components].color.gray'))
              .width('100%')
              .padding({ top: 2, bottom: 2 })
          }, (refund: OrderRefund) => refund.id)
        }
        ForEach(order.skus, (sku: OrderSku) => {
          this.OrderSkuRow(sku)
        }, (sku: OrderSku) => sku.id)
        Row() {
          Text('共 ' + order.totalNum.toString() + ' 件商品')
            .fontSize(12)
            .fontColor($r('[ui_components].color.gray'))
          Blank()
          Text('实付款 ¥' + order.payMoney.toFixed(2))
            .fontSize(14)
            .fontColor($r('[ui_components].color.black'))
        }
        .width('100%')
        .padding({ top: 8, bottom: 12 })
      }
      .width('100%')
      .onClick(() => this.openOrderDetail(order.id))
      if (this.hasOrderActions(order)) {
        this.OrderActions(order)
      }
    }
    .width('100%')
    .padding({ left: 12, right: 12 })
    .backgroundColor($r('[ui_components].color.white'))
    .borderRadius(8)
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: '我的订单',
          onLeftClick: () => this.stackPath.pop()
        })
        if (this.pendingCancelActions.length > 0) {
          Text('操作结果待确认，请重新查询').fontSize(12).padding(6)
          Button('重新查询').enabled(!this.busyOrderId && this.isOrderListReady())
            .onClick(() => this.recoverAllCancellations())
        }
        if (this.pendingCancellations.length > 0) {
          Text('取消结果待确认，请稍后查询').fontSize(12).padding(6)
          Button(this.busyAction === 'cancel' ? '正在确认取消结果' : '重新查询')
            .enabled(!this.busyOrderId && this.isOrderListReady())
            .onClick(() => this.recoverCancellations())
        }
        Row() {
          ForEach(this.tabs, (tab: OrderTab) => {
            Text(tab.label)
              .fontSize(13)
              .fontWeight(this.selectedState === tab.state ? FontWeight.Medium : FontWeight.Regular)
              .fontColor(this.selectedState === tab.state ? $r('[ui_components].color.red') : $r('[ui_components].color.gray'))
              .padding({ top: 12, bottom: 12 })
              .layoutWeight(1)
              .textAlign(TextAlign.Center)
              .onClick(() => this.selectTab(tab.state))
          }, (tab: OrderTab) => tab.state.toString())
        }
        .width('100%')
        .backgroundColor($r('[ui_components].color.white'))
        .border({ width: { bottom: 0.5 }, color: $r('[ui_components].color.border') })
        if (!this.loading && this.orders.length === 0) {
          Column() {
            HDMEmpty({
              tip: this.loadFailed ? '订单加载失败，请稍后重试' : '暂时没有相关订单',
              buttonText: this.loadFailed ? '重新加载' : '返回个人中心',
              onBtnClick: () => {
                if (this.loadFailed) {
                  this.reloadOrders()
                } else {
                  this.stackPath.pop()
                }
              }
            })
          }
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else {
          List({ space: 8 }) {
            ForEach(this.orders, (order: OrderItem) => {
              ListItem() {
                this.OrderCard(order)
              }
            }, (order: OrderItem) => `${order.id}:${order.orderState}:${JSON.stringify(order)}:${this.countdownBaseAt}`)
            ListItem() {
              if (this.loading) {
                LoadingProgress().width(32).height(32)
              } else if (this.loadFailed) {
                Button('加载失败，点击重试').onClick(() => this.loadMore())
              } else if (!this.isFinished) {
                Button('加载更多').onClick(() => this.loadMore())
              }
            }
          }
          .layoutWeight(1)
          .scrollBar(BarState.Off)
          .cachedCount(4)
          .padding(8)
          .onReachEnd(() => this.loadMore())
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('[ui_components].color.under'))
    }
    .hideTitleBar(true)
    .padding({ top: this.topHeight })
    .onShown(() => {
      this.refreshOnReturn()
    })
    .onHidden(() => {
      this.hideOrders()
    })
  }
}
