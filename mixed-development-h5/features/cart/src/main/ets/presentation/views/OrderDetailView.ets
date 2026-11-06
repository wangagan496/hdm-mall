import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMNavBar } from 'ui_components'
import { HDMUser, CancelActionIntent, LocalEvaluationItem, OrderItem, OrderSku, OrderRefund, formatBeijingTime } from 'models'
import { demoOrderStore, cancelActions } from 'storage'
import {
  remindShipmentAPI,
  getOrderDetailAPI,
  receiptOrderAPI
} from '../../data/api'
import { getPaymentDisplayLabel, getDisplayOrderStateText, getRefundDisplayLine, shouldShowPaymentCountdown, canOpenPayment,
  mergeOrderState, OrderState, readPhoneClockMillis } from '../utils/OrderPresentation'
import { getScoreLabel } from '../utils/EvaluationPresentation'
import { advanceOrderState } from '../utils/DemoOrderFlow'
import { OrderCountdown } from '../components'
import { orderCancellation } from '../utils/OrderCancellation'

@Builder
function OrderDetailViewBuilder() {
  OrderDetailView()
}

@Component
export struct OrderDetailView {
  @StorageProp(GlobalVariable.APP_FOREGROUND_SEQUENCE) @Watch('refreshAfterForeground') foregroundSequence: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('reloadForCurrentAccount') user: HDMUser = {} as HDMUser
  private querySequence: number = 0
  @State pageGeneration: number = 0
  @State pageActive: boolean = true
  @State detailToken: string = ''
  @State detailOrderId: string = ''
  private cancellationDialogSequence: number = 0

  private refreshAfterForeground(): void {
    this.loadOrderDetail()
  }

  aboutToDisappear(): void {
    this.hideOrderDetail()
  }

  private hideOrderDetail(): void {
    this.pageActive = false
    this.pageGeneration++
    this.querySequence++
    this.busy = ''
    this.loading = false
  }

  private showOrderDetail(): void {
    this.pageActive = true
    if (!this.loading) {
      this.loadOrderDetail()
    }
  }

  private reloadForCurrentAccount(): void {
    if ((this.user.token || '') !== this.detailToken) {
      this.loadOrderDetail()
    }
  }

  private synchronizeDetailContext(): void {
    const token: string = this.user.token || ''
    if (token === this.detailToken && this.orderId === this.detailOrderId) {
      return
    }
    this.detailToken = token
    this.detailOrderId = this.orderId
    this.pageGeneration++
    this.querySequence++
    this.order = null
    this.evaluation = null
    this.displayedOrderState = 0
    this.countdownBaseAt = 0
    this.cancellationPending = false
    this.cancelActionPending = false
    this.busy = ''
    this.loadFailed = false
  }

  private isCurrentDetail(generation: number, token: string, orderId: string): boolean {
    return this.pageActive && generation === this.pageGeneration && token.length > 0 &&
      token === this.detailToken && token === (this.user.token || '') &&
      orderId.length > 0 && orderId === this.orderId && orderId === this.detailOrderId
  }

  private canOperateOrder(): boolean {
    return this.isCurrentDetail(this.pageGeneration, this.detailToken, this.orderId) &&
      !this.loading && !this.loadFailed && this.order !== null && this.order.id === this.orderId
  }
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM)
  bottomHeight: number = 0
  @State order: OrderItem | null = null
  @State displayedOrderState: number = 0 // 页面当前显示的订单状态。
  @State evaluation: LocalEvaluationItem | null = null
  @State loading: boolean = true
  @State loadFailed: boolean = false
  @State busy: string = ''
  @State cancellationPending: boolean = false
  @State cancelActionPending: boolean = false
  @Consume stackPath: NavPathStack

  @State orderId: string = ''
  private countdownBaseAt: number = 0

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  // 用收到的订单号向服务端查询；查回的完整订单保存在 this.order，供页面显示。
  private async loadOrderDetail(): Promise<void> {
    this.synchronizeDetailContext()
    const token: string = this.detailToken
    const orderId: string = this.orderId
    const generation: number = this.pageGeneration
    const sequence: number = ++this.querySequence
    if (!this.isCurrentDetail(generation, token, orderId)) {
      this.loading = false
      this.loadFailed = !token || !orderId
      return
    }
    this.loading = true
    this.loadFailed = false
    try {
      const order: OrderItem = await getOrderDetailAPI(orderId, token)
      if (sequence !== this.querySequence || !this.isCurrentDetail(generation, token, orderId)) {
        return
      }
      this.order = order
      this.countdownBaseAt = readPhoneClockMillis()
      this.updateOrderStatusAndEvaluation()
      this.cancellationPending = orderCancellation.pendingIds().includes(this.orderId)
      this.cancelActionPending = cancelActions.pending().some(record => record.orderId === this.orderId)
    } catch {
      if (sequence === this.querySequence && this.isCurrentDetail(generation, token, orderId)) {
        this.loadFailed = true
        this.safeToast('订单加载失败，请稍后重试')
      }
    } finally {
      if (sequence === this.querySequence && this.isCurrentDetail(generation, token, orderId)) {
        this.loading = false
      }
    }
    if (sequence === this.querySequence && this.canOperateOrder() && this.cancelActionPending && !this.busy) {
      this.runCancelAction('request', true)
      return
    }
    // 查询完成后才恢复已有取消意图，普通详情查询不会创建取消操作。
    if (sequence === this.querySequence && this.canOperateOrder() && this.cancellationPending && !this.busy) {
      this.run('cancel', (): Promise<void> => this.runCancelWithFallback(true), '订单已取消')
    }
  }

  private async run(action: string, task: () => Promise<void>, successText: string): Promise<void> {
    if (this.busy || this.cancelActionPending || !this.canOperateOrder()) {
      return
    }
    this.busy = action
    const sequence: number = this.querySequence
    const generation: number = this.pageGeneration
    const token: string = this.detailToken
    const orderId: string = this.orderId
    try {
      await task()
      if (!this.isCurrentDetail(generation, token, orderId)) return
      this.safeToast(successText)
      this.updateOrderStatusAndEvaluation()
      await this.loadOrderDetail()
    } catch (error) {
      if (this.isCurrentDetail(generation, token, orderId)) {
        if (action === 'cancel' && sequence === this.querySequence && !orderCancellation.pendingIds().includes(orderId)) {
          await this.loadOrderDetail()
          if (!this.isCurrentDetail(generation, token, orderId)) return
          if (this.order?.orderState === OrderState.AWAITING_SHIPMENT) {
            this.safeToast('付款已确认，请重新申请取消')
            return
          }
        }
        this.safeToast((error as Error).message || '操作失败，请稍后重试')
      }
    } finally {
      if (this.isCurrentDetail(generation, token, orderId)) {
        this.cancellationPending = orderCancellation.pendingIds().includes(orderId)
        this.busy = ''
      }
    }
  }

  private async runCancelWithFallback(resume: boolean = false): Promise<void> {
    if (!this.order || !this.canOperateOrder()) {
      return
    }
    await orderCancellation.confirm(this.order.id, resume)
  }

  private async runCancelAction(action: 'request' | 'withdraw', resume: boolean = false): Promise<void> {
    if (this.busy || !this.canOperateOrder() || !this.order) return
    if (!resume && (this.cancelActionPending || (action === 'request' ? !this.order.canRequestCancel : !this.order.canWithdrawCancel))) return
    const generation: number = this.pageGeneration
    const token: string = this.detailToken
    const orderId: string = this.orderId
    const sequence: number = this.querySequence
    this.busy = 'cancel-request'
    try {
      if (resume) await cancelActions.recover(orderId, token)
      else {
        const intent: CancelActionIntent = { orderId, cancelRequestId: action === 'withdraw' ? this.order.cancelRequest?.id || '' : '', action, reason: '' }
        await cancelActions.confirm(intent, token)
      }
      if (sequence === this.querySequence && this.isCurrentDetail(generation, token, orderId)) this.safeToast('取消操作已确认')
    } catch (error) {
      if (sequence === this.querySequence && this.isCurrentDetail(generation, token, orderId)) this.safeToast((error as Error).message)
    } finally {
      if (this.isCurrentDetail(generation, token, orderId)) {
        this.cancelActionPending = cancelActions.pending().some(record => record.orderId === orderId)
        if (sequence === this.querySequence) await this.loadOrderDetail()
        if (this.isCurrentDetail(generation, token, orderId)) this.busy = ''
      }
    }
  }

  private requestPaidCancellation(): void {
    if (!this.order?.canRequestCancel || !this.order.cancelConfirmation || this.cancelActionPending || this.busy || !this.canOperateOrder()) return
    const message: string = this.order.cancelConfirmation.message
    const requestId: string = this.order.cancelRequest?.id || ''
    const generation: number = this.pageGeneration
    const token: string = this.detailToken
    const orderId: string = this.orderId
    const sequence: number = this.querySequence
    const dialog: number = ++this.cancellationDialogSequence
    this.getUIContext().showAlertDialog({ title: '申请取消订单', message,
      primaryButton: { value: '再等等', action: () => { this.cancellationDialogSequence++ } },
      secondaryButton: { value: '确定申请', action: () => {
        if (dialog !== this.cancellationDialogSequence || sequence !== this.querySequence ||
          !this.isCurrentDetail(generation, token, orderId) || !this.order?.canRequestCancel ||
          this.order.cancelConfirmation?.message !== message || (this.order.cancelRequest?.id || '') !== requestId) return
        this.cancellationDialogSequence++
        this.runCancelAction('request')
      } }
    })
  }

  private requestCancelOrder(): void {
    if (this.order?.canRequestCancel && (this.order.serverManaged || !GlobalVariable.DEMO_ORDER_FLOW)) {
      this.requestPaidCancellation()
      return
    }
    if (!this.order || this.order.canCancel === false || this.busy || !this.canOperateOrder()) return
    if (this.order.paymentState !== 'confirming' && this.order.paymentState !== 'review') {
      this.run('cancel', (): Promise<void> => this.runCancelWithFallback(), '订单已取消')
      return
    }
    const generation: number = this.pageGeneration
    const token: string = this.detailToken
    const orderId: string = this.orderId
    const amount: number = this.order.payMoney
    const dialog: number = ++this.cancellationDialogSequence
    this.getUIContext().showAlertDialog({
      title: '确认取消订单',
      message: '付款可能已经成功。取消后，如已扣款，¥' + amount.toFixed(2) + '将原路退回付款账户。确定取消吗？',
      primaryButton: { value: '再等等', action: () => { this.cancellationDialogSequence++ } },
      secondaryButton: { value: '确认取消', action: () => {
        if (dialog !== this.cancellationDialogSequence || !this.isCurrentDetail(generation, token, orderId) ||
          !this.order || (this.order.paymentState !== 'confirming' && this.order.paymentState !== 'review') ||
          this.order.canCancel === false) return
        this.cancellationDialogSequence++
        this.run('cancel', (): Promise<void> => this.runCancelWithFallback(), '订单已取消')
      } }
    })
  }

  private async runConsignment(): Promise<void> {
    if (!this.order || !this.canOperateOrder()) {
      return
    }
    const orderId: string = this.order.id
    const token: string = this.detailToken
    const generation: number = this.pageGeneration
    await advanceOrderState(orderId, OrderState.AWAITING_RECEIPT, async (): Promise<void> => {
      await remindShipmentAPI(orderId, token)
    }, (): boolean => this.isCurrentDetail(generation, token, orderId))
  }

  private async runReceipt(): Promise<void> {
    if (!this.order || !this.canOperateOrder()) {
      return
    }
    const orderId: string = this.order.id
    const token: string = this.detailToken
    const generation: number = this.pageGeneration
    await advanceOrderState(orderId, OrderState.AWAITING_REVIEW, async (): Promise<void> => {
      await receiptOrderAPI(orderId, token)
    }, (): boolean => this.isCurrentDetail(generation, token, orderId))
  }

  private async runComment(): Promise<void> {
    if (!this.order || this.busy || this.cancelActionPending || !this.canOperateOrder()) {
      return
    }
    this.stackPath.pushPath({ name: PAGE_PATH.EVALUATION_PAGE, param: this.order.id })
  }

  private openPayment(): void {
    if (!this.order || this.busy || this.cancelActionPending || !this.canOperateOrder() || !canOpenPayment(this.order)) {
      return
    }
    this.stackPath.pushPath({ name: PAGE_PATH.PAY_PAGE, param: this.order.id })
  }

  // 真实订单与演示订单分别读取各自的状态和评价，不互相补充。
  private updateOrderStatusAndEvaluation(): void {
    if (!this.order) {
      this.displayedOrderState = 0
      this.evaluation = null
      return
    }
    if (this.order.serverManaged || !GlobalVariable.DEMO_ORDER_FLOW) {
      // 真实订单：状态和评价都使用服务端查询结果。
      const newOrderState = this.order.orderState // 本次查回来的订单状态。
      this.displayedOrderState = newOrderState // 用新状态替换页面原来显示的状态。
      this.evaluation = this.order.evaluation ?? null
      return
    }

    // 旧演示订单：读取本地模拟操作记录，计算演示状态。
    const demoStateChanges = demoOrderStore.getOverlay(this.order.id)
    this.evaluation = demoOrderStore.getEvaluation(this.order.id)
    this.displayedOrderState = mergeOrderState(this.order, demoStateChanges, this.evaluation)
  }

  private hasEvaluation(): boolean {
    return this.evaluation !== null
  }

  private evaluationScore(): number {
    return this.evaluation ? this.evaluation.score : 0
  }

  private evaluationContent(): string {
    return this.evaluation ? this.evaluation.content : ''
  }

  private displayStateText(): string {
    if (this.order && (this.order.serverManaged || !GlobalVariable.DEMO_ORDER_FLOW)) return getPaymentDisplayLabel(this.order)
    return getDisplayOrderStateText(this.displayedOrderState, this.hasEvaluation())
  }

  @Builder
  private DetailActions() {
    Column() {
      if (this.order) {
        if (this.displayedOrderState === OrderState.AWAITING_PAYMENT) { // 待付款：取消订单、去支付。
          Row({ space: 8 }) {
            Button(this.busy === 'cancel' ? '正在确认取消结果' : '取消订单')
              .height(36)
              .fontSize(13)
              .fontColor($r('[ui_components].color.gray'))
              .backgroundColor($r('[ui_components].color.white'))
              .border({ width: 0.5, color: $r('[ui_components].color.border') })
              .enabled(!this.busy && !this.cancelActionPending && this.canOperateOrder() && this.order.canCancel !== false)
              .onClick(() => this.requestCancelOrder())
            if (canOpenPayment(this.order)) {
              Button('去支付')
              .height(36)
              .fontSize(13)
              .backgroundColor($r('[ui_components].color.red'))
              .enabled(!this.busy && !this.cancelActionPending && this.canOperateOrder() && canOpenPayment(this.order))
              .onClick(() => this.openPayment())
            }
          }
          .width('100%')
        } else if (this.displayedOrderState === OrderState.AWAITING_SHIPMENT) { // 待发货：提醒发货。
          Row({ space: 8 }) {
            Blank()
            if (this.order.cancelRequest?.state === 'pending') {
              if (this.order.canWithdrawCancel) {
                Button('撤回申请').height(36).fontSize(13)
                  .enabled(!this.busy && !this.cancelActionPending && this.canOperateOrder())
                  .onClick(() => this.runCancelAction('withdraw'))
              }
            } else {
              if (this.order.canRequestCancel && (this.order.serverManaged || !GlobalVariable.DEMO_ORDER_FLOW)) {
                Button('取消订单').height(36).fontSize(13)
                  .enabled(!this.busy && !this.cancelActionPending && this.canOperateOrder())
                  .onClick(() => this.requestCancelOrder())
              }
              Button(this.busy === 'consignment' ? '处理中...' : '提醒发货')
                .height(36).fontSize(13)
                .fontColor($r('[ui_components].color.gray'))
                .backgroundColor($r('[ui_components].color.white'))
                .border({ width: 0.5, color: $r('[ui_components].color.border') })
                .enabled(!this.busy && !this.cancelActionPending && this.canOperateOrder())
                .onClick(() => this.run('consignment', (): Promise<void> => this.runConsignment(), '已提醒商家发货'))
            }
          }
          .width('100%')
        } else if (this.displayedOrderState === OrderState.AWAITING_RECEIPT) { // 待收货：查看物流、确认收货。
          Row({ space: 8 }) {
            Button('查看物流')
              .height(36)
              .fontSize(13)
              .fontColor($r('[ui_components].color.gray'))
              .backgroundColor($r('[ui_components].color.white'))
              .border({ width: 0.5, color: $r('[ui_components].color.border') })
              .onClick(() => {})
            Button(this.busy === 'receipt' ? '确认中...' : '确认收货')
              .height(36)
              .fontSize(13)
              .backgroundColor($r('[ui_components].color.red'))
              .enabled(!this.busy && !this.cancelActionPending && this.canOperateOrder())
              .onClick(() => this.run('receipt', (): Promise<void> => this.runReceipt(), '已确认收货'))
          }
          .width('100%')
        } else if (this.displayedOrderState === OrderState.AWAITING_REVIEW) { // 待评价：去评价。
          Row() {
            Blank()
            Button('去评价')
              .height(36)
              .fontSize(13)
              .fontColor($r('[ui_components].color.red'))
              .backgroundColor($r('[ui_components].color.white'))
              .border({ width: 0.5, color: $r('[ui_components].color.red') })
              .enabled(!this.busy && !this.cancelActionPending && this.canOperateOrder())
              .onClick(() => this.runComment())
          }
          .width('100%')
        }
      }
    }
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: this.order ? getPaymentDisplayLabel(this.order) : '订单详情',
          onLeftClick: () => this.stackPath.pop()
        })
        if (this.cancelActionPending) {
          Text('操作结果待确认，请重新查询').fontSize(12).padding(6)
          Button('重新查询').enabled(!this.busy && this.canOperateOrder())
            .onClick(() => this.runCancelAction('request', true))
        }
        if (this.cancellationPending) {
          Text('取消结果待确认，请稍后查询').fontSize(12).padding(6)
          Button(this.busy === 'cancel' ? '正在确认取消结果' : '重新查询')
            .enabled(!this.busy && this.canOperateOrder())
            .onClick(() => this.run('cancel', (): Promise<void> => this.runCancelWithFallback(true), '订单已取消'))
        }
        if (this.loading) {
          Column() {
            LoadingProgress()
              .width(60)
              .height(60)
              .color($r('[ui_components].color.red'))
          }
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else if (this.loadFailed || !this.order) {
          Column({ space: 12 }) {
            Text('订单加载失败，请稍后重试')
              .fontSize(14)
              .fontColor($r('[ui_components].color.gray'))
            Button('重新加载')
              .onClick(() => this.loadOrderDetail())
            Button('返回订单列表')
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
              Column({ space: 6 }) {
                Row({ space: 6 }) {
                  Text(this.displayStateText())
                    .fontSize(18)
                    .fontWeight(500)
                  if (this.displayedOrderState === OrderState.AWAITING_PAYMENT && shouldShowPaymentCountdown(this.order)) {
                    OrderCountdown({ countdown: this.order.countdown, baseAt: this.countdownBaseAt, fontSize: 12 })
                  }
                }
                if (this.displayedOrderState === OrderState.AWAITING_PAYMENT && shouldShowPaymentCountdown(this.order)) {
                  Text('请在 ' + this.order.payLatestTime + ' 前完成支付，超时自动取消')
                    .fontSize(12)
                    .fontColor($r('[ui_components].color.gray'))
                }
                if (this.order.cancelRequestNotice) {
                  Text(this.order.cancelRequestNotice).fontSize(12).padding(4)
                }
                if (this.order.cancelRequest?.state === 'pending') {
                  Text('处理截止：' + formatBeijingTime(this.order.cancelRequest.deadlineAt))
                    .fontSize(12).padding(4)
                }
                if (this.order.paymentNotice) {
                  Text(this.order.paymentNotice).fontSize(13).fontColor($r('[ui_components].color.gray'))
                }
                Text('订单号 ' + this.order.id)
                  .fontSize(11)
                  .fontColor($r('[ui_components].color.gray'))
                if (this.order.createTime) {
                  Text(formatBeijingTime(this.order.createTime) + ' 下单')
                  .fontSize(11)
                  .fontColor($r('[ui_components].color.gray'))
                }
                if (this.order.paymentState === 'review' || (this.order.paymentNotice || '').includes('人工')) {
                  Button('帮助与客服').onClick(() => this.stackPath.pushPath({ name: PAGE_PATH.CUSTOMER_SERVICE_PAGE }))
                }
              }
              .width('100%')
              .padding(12)
              .backgroundColor($r('[ui_components].color.white'))
              .borderRadius(8)
              .alignItems(HorizontalAlign.Start)

              if (this.order.refunds && this.order.refunds.length > 0) {
                Column({ space: 6 }) {
                  ForEach(this.order.refunds, (refund: OrderRefund) => {
                    Text(getRefundDisplayLine(refund)).fontSize(12).fontColor($r('[ui_components].color.gray'))
                  }, (refund: OrderRefund) => refund.id)
                }
                .width('100%').padding(12).backgroundColor($r('[ui_components].color.white')).borderRadius(8)
              }

              if (this.order.payMoney !== undefined) {
              Column() {
                ForEach(this.order.skus, (sku: OrderSku) => {
                  Row({ space: 10 }) {
                    Image(sku.image)
                      .width(72)
                      .height(72)
                      .borderRadius(4)
                      .backgroundColor($r('[ui_components].color.under'))
                    Column({ space: 4 }) {
                      Text(sku.name)
                        .width('100%')
                        .fontSize(13)
                        .maxLines(2)
                        .textOverflow({ overflow: TextOverflow.Ellipsis })
                      Text(sku.attrsText || '默认规格')
                        .fontSize(11)
                        .fontColor($r('[ui_components].color.gray'))
                      Text('x' + sku.quantity.toString() + '  ¥' + sku.realPay.toFixed(2))
                        .fontSize(13)
                        .fontColor($r('[ui_components].color.black'))
                    }
                    .layoutWeight(1)
                    .alignItems(HorizontalAlign.Start)
                  }
                  .width('100%')
                  .padding({ top: 8, bottom: 8 })
                }, (sku: OrderSku) => sku.id)
                Row() {
                  Text('共 ' + this.order.totalNum.toString() + ' 件')
                    .fontSize(12)
                    .fontColor($r('[ui_components].color.gray'))
                  Blank()
                  Text('实付款 ¥' + this.order.payMoney.toFixed(2))
                    .fontSize(14)
                    .fontWeight(500)
                }
                .width('100%')
                .padding({ top: 8 })
              }
              .width('100%')
              .padding(12)
              .backgroundColor($r('[ui_components].color.white'))
              .borderRadius(8)
              }
              if (this.hasEvaluation()) {
                Column({ space: 10 }) {
                  Row() {
                    Text('我的评价')
                      .fontSize(15)
                      .fontWeight(500)
                    Blank()
                    Text(this.evaluationScore().toString() + ' 星 · ' + getScoreLabel(this.evaluationScore()))
                      .fontSize(12)
                      .fontColor($r('[ui_components].color.red'))
                  }
                  .width('100%')
                  Row({ space: 4 }) {
                    ForEach([1, 2, 3, 4, 5], (value: number) => {
                      Text('★')
                        .fontSize(18)
                        .fontColor(value <= this.evaluationScore() ? '#F5A623' : $r('[ui_components].color.border'))
                    }, (value: number) => 'detail-star-' + value.toString())
                  }
                  .width('100%')
                  Text(this.evaluationContent())
                    .fontSize(14)
                    .lineHeight(22)
                    .fontColor($r('[ui_components].color.text'))
                    .width('100%')
                }
                .width('100%')
                .padding(12)
                .backgroundColor($r('[ui_components].color.white'))
                .borderRadius(8)
                .alignItems(HorizontalAlign.Start)
              }

              if (this.order.payMoney !== undefined) {
              Column({ space: 10 }) {
                if (this.order.serverManaged) {
                  Text(this.order.payerAccount ? '实际付款人：' + this.order.payerAccount : '尚未付款').fontSize(13)
                  if (this.order.receivedByAccount) {
                    Text('收货确认人：' + this.order.receivedByAccount).fontSize(13)
                  }
                }
                Row() {
                  Text('支付方式')
                    .fontSize(13)
                    .fontColor($r('[ui_components].color.gray'))
                  Blank()
                  Text(this.order.serverManaged ? (this.order.paymentMode === 'family' ? '亲友模拟代付' : '本人模拟支付') : '在线支付')
                    .fontSize(13)
                }
                .width('100%')
                Row() {
                  Text('运费')
                    .fontSize(13)
                    .fontColor($r('[ui_components].color.gray'))
                  Blank()
                  Text('¥' + this.order.postFee.toFixed(2))
                    .fontSize(13)
                }
                .width('100%')
                this.DetailActions()
              }
              .width('100%')
              .padding(12)
              .backgroundColor($r('[ui_components].color.white'))
              .borderRadius(8)
              }
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
            .padding({ left: 12, right: 12, top: 12, bottom: 16 + this.bottomHeight })
          }
          .width('100%')
          .layoutWeight(1)
          .align(Alignment.TopStart)
          .scrollBar(BarState.Off)

        }
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.Start)
      .backgroundColor($r('[ui_components].color.under'))
    }
    .hideTitleBar(true)
    .padding({ top: this.topHeight })
    .onReady((orderDetailPage: NavDestinationContext) => {
      // 取出用户选中的订单号；pathInfo.param 是框架存放本次跳转参数的位置。
      const selectedOrderId = orderDetailPage.pathInfo.param as string
      this.orderId = selectedOrderId // 保存到当前详情页，重新加载时仍查询这笔订单。
      this.loadOrderDetail() // 用保存的订单号查询详情；没有订单号时显示加载失败。
    })
    .onShown(() => {
      this.showOrderDetail()
    })
    .onHidden(() => {
      this.hideOrderDetail()
    })
  }
}
