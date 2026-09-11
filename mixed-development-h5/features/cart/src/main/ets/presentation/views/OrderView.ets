import { GlobalVariable, PAGE_PATH } from 'constants'
import { DemoOrderOverlay, HDMUser, LocalEvaluationItem, OrderItem, OrderSku } from 'models'
import { HDMEmpty, HDMNavBar } from 'ui_components'
import { demoOrderStore } from 'storage'
import {
  cancelOrderWithFallback,
  consignmentOrderAPI,
  getOrderListAPI,
  receiptOrderAPI
} from '../../data/api'
import {
  formatOrderCountdown,
  getOrderStateText,
  isDemoOverlayApplied,
  mergeOrderState
} from '../utils/OrderPresentation'

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
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY)
  user: HDMUser = {
    avatar: '',
    token: '',
    nickname: '',
    account: ''
  }
  @State orders: OrderItem[] = []
  @State overlays: Record<string, DemoOrderOverlay> = {}
  @State evaluations: Record<string, LocalEvaluationItem> = {}
  @State selectedState: number = 0
  @State loading: boolean = false
  @State loadFailed: boolean = false
  @State busyOrderId: string = ''
  @State busyAction: string = ''
  @State isFinished: boolean = false
  // 每秒自增，驱动待付款订单的倒计时走字；倒计时基数来自服务端返回值。
  @State countdownTick: number = 0
  @Consume stackPath: NavPathStack
  private countdownTimer: number = -1
  private countdownBaseAt: number = 0

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  private page: number = 1
  private readonly pageSize: number = 10
  private requestGeneration: number = 0
  private readonly tabs: OrderTab[] = [
    { label: '全部', state: 0 },
    { label: '待付款', state: 1 },
    { label: '待发货', state: 2 },
    { label: '待收货', state: 3 },
    { label: '待评价', state: 4 }
  ]

  aboutToAppear(): void {
    const routeStates: number[] = this.stackPath.getParamByName(PAGE_PATH.ORDER_PAGE) as number[]
    const routeState: number | undefined = routeStates[routeStates.length - 1]
    if (routeState !== undefined && this.isSupportedOrderState(routeState)) {
      this.selectedState = routeState
    }
    this.countdownTimer = setInterval(() => {
      this.countdownTick++
    }, 1000)
    this.reloadOrders()
  }

  aboutToDisappear(): void {
    clearInterval(this.countdownTimer)
  }

  /**
   * 服务端只返回下单时刻的剩余秒数（秒，非截止时间戳），页面按加载时刻回推。
   * 剩余量以真实时间为准，避免定时器在卡顿时累计误差导致倒计时越走越偏；
   * countdownTick 由每秒定时器自增，作用是让这个计算重新执行。
   */
  private remainingCountdown(order: OrderItem): number {
    if (this.countdownTick < 0) {
      return order.countdown
    }
    const elapsed: number = Math.floor((Date.now() - this.countdownBaseAt) / 1000)
    return order.countdown - elapsed
  }

  private isSupportedOrderState(orderState: number): boolean {
    return orderState >= 0 && orderState <= 4
  }

  private async reloadOrders(): Promise<void> {
    this.requestGeneration++
    this.page = 1
    this.orders = []
    this.isFinished = false
    this.loadFailed = false
    this.loading = false
    this.refreshLocalOverlay()
    await this.loadMore()
  }

  private refreshLocalOverlay(): void {
    const overlays: DemoOrderOverlay[] = demoOrderStore.getAllOverlays()
    const nextOverlays: Record<string, DemoOrderOverlay> = {}
    overlays.forEach((overlay: DemoOrderOverlay) => {
      nextOverlays[overlay.orderId] = overlay
    })
    const evaluations: LocalEvaluationItem[] = demoOrderStore.getAllEvaluations()
    const nextEvaluations: Record<string, LocalEvaluationItem> = {}
    evaluations.forEach((item: LocalEvaluationItem) => {
      nextEvaluations[item.orderId] = item
    })
    this.overlays = nextOverlays
    this.evaluations = nextEvaluations
  }

  private async loadMore(): Promise<void> {
    if (this.loading || this.isFinished || !this.user.token) {
      return
    }
    const generation: number = this.requestGeneration
    this.loading = true
    try {
      const result = await getOrderListAPI({
        page: this.page,
        pageSize: this.pageSize,
        orderState: this.selectedState
      })
      if (generation !== this.requestGeneration) {
        return
      }
      const items: OrderItem[] = result.items || []
      this.countdownBaseAt = Date.now()
      this.orders = this.orders.concat(items)
      this.page++
      this.isFinished = items.length === 0 || this.page > result.pages
    } catch {
      if (generation === this.requestGeneration) {
        this.loadFailed = true
      }
    } finally {
      if (generation === this.requestGeneration) {
        this.loading = false
      }
    }
  }

  private mergedState(order: OrderItem): number {
    return mergeOrderState(order, this.overlays[order.id] ?? null, this.evaluations[order.id] ?? null)
  }

  private isOverlayApplied(order: OrderItem): boolean {
    return isDemoOverlayApplied(order, this.overlays[order.id] ?? null, this.evaluations[order.id] ?? null)
  }

  private displayStateFor(order: OrderItem): number {
    return this.mergedState(order)
  }

  private selectTab(orderState: number): void {
    if (this.selectedState === orderState) {
      return
    }
    this.selectedState = orderState
    this.reloadOrders()
  }

  private async runOrderAction(orderId: string, action: string, task: () => Promise<void>, successText: string): Promise<void> {
    if (this.busyOrderId || !orderId) {
      return
    }
    this.busyOrderId = orderId
    this.busyAction = action
    try {
      await task()
      this.safeToast(successText)
      await this.reloadOrders()
    } catch {
      this.safeToast('操作失败，请稍后重试')
    } finally {
      this.busyOrderId = ''
      this.busyAction = ''
    }
  }

  private isBusy(orderId: string): boolean {
    return this.busyOrderId === orderId
  }

  private goPay(orderId: string): void {
    this.stackPath.pushPath({ name: PAGE_PATH.PAY_PAGE, param: orderId })
  }

  private openDetail(orderId: string): void {
    this.stackPath.pushPath({ name: PAGE_PATH.ORDER_DETAIL_PAGE, param: orderId })
  }

  private async runConsignment(orderId: string): Promise<void> {
    await consignmentOrderAPI(orderId)
  }

  private async runReceipt(orderId: string): Promise<void> {
    await receiptOrderAPI(orderId)
  }

  private async runComment(orderId: string): Promise<void> {
    this.stackPath.pushPath({ name: PAGE_PATH.EVALUATION_PAGE, param: orderId })
  }

  /**
   * 沙箱环境没有真实支付/物流回调，本地演示按钮按 1→2→3→4 顺序把订单状态往前推一格，
   * 不写真实支付、不调远端任何接口，不与后端真实数据混淆。
   */
  private async advanceOneStep(orderId: string): Promise<void> {
    if (!orderId) {
      return
    }
    const overlay = this.overlays[orderId]
    const current = overlay ? overlay.advancedState : 1
    if (current >= 5) {
      this.safeToast('已到达演示终态')
      return
    }
    const next = current + 1
    await demoOrderStore.setOverlay(orderId, next)
    this.safeToast('已推进到' + getOrderStateText(next) + '（仅本地演示）')
    this.refreshLocalOverlay()
    await this.reloadOrders()
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
    if (this.displayStateFor(order) === 1) {
      Row({ space: 8 }) {
        Blank()
        Button(this.isBusy(order.id) && this.busyAction === 'cancel' ? '取消中...' : '取消订单')
          .height(32)
          .fontSize(12)
          .fontColor($r('[ui_components].color.gray'))
          .backgroundColor($r('[ui_components].color.white'))
          .border({ width: 0.5, color: $r('[ui_components].color.border') })
          .enabled(!this.busyOrderId)
          .onClick(() => {
            this.runOrderAction(order.id, 'cancel', (): Promise<void> => cancelOrderWithFallback(order.id), '订单已取消')
          })
        Button('去支付')
          .height(32)
          .fontSize(12)
          .backgroundColor($r('[ui_components].color.red'))
          .onClick(() => {
            this.goPay(order.id)
          })
        // 沙箱环境没有真实支付回调，本地演示按钮把订单状态往前推一格。
        Button('演示推进')
          .height(32)
          .fontSize(12)
          .fontColor($r('[ui_components].color.red'))
          .backgroundColor($r('[ui_components].color.white'))
          .border({ width: 0.5, color: $r('[ui_components].color.red') })
          .enabled(!this.busyOrderId)
          .onClick(() => {
            this.advanceOneStep(order.id)
          })
      }
      .width('100%')
      .padding({ bottom: 10 })
    } else if (this.displayStateFor(order) === 2) {
      Row({ space: 8 }) {
        Blank()
        Button(this.isBusy(order.id) ? '发货中...' : '模拟发货')
          .height(32)
          .fontSize(12)
          .fontColor($r('[ui_components].color.red'))
          .backgroundColor($r('[ui_components].color.white'))
          .border({ width: 0.5, color: $r('[ui_components].color.red') })
          .enabled(!this.busyOrderId)
          .onClick(() => {
            this.runOrderAction(order.id, 'consignment', (): Promise<void> => this.runConsignment(order.id), '模拟发货成功')
          })
        Button('演示推进')
          .height(32)
          .fontSize(12)
          .fontColor($r('[ui_components].color.red'))
          .backgroundColor($r('[ui_components].color.white'))
          .border({ width: 0.5, color: $r('[ui_components].color.red') })
          .enabled(!this.busyOrderId)
          .onClick(() => {
            this.advanceOneStep(order.id)
          })
      }
      .width('100%')
      .padding({ bottom: 10 })
    } else if (this.displayStateFor(order) === 3) {
      Row({ space: 8 }) {
        Blank()
        Button(this.isBusy(order.id) ? '确认中...' : '确认收货')
          .height(32)
          .fontSize(12)
          .backgroundColor($r('[ui_components].color.red'))
          .enabled(!this.busyOrderId)
          .onClick(() => {
            this.runOrderAction(order.id, 'receipt', (): Promise<void> => this.runReceipt(order.id), '已确认收货')
          })
        Button('演示推进')
          .height(32)
          .fontSize(12)
          .fontColor($r('[ui_components].color.red'))
          .backgroundColor($r('[ui_components].color.white'))
          .border({ width: 0.5, color: $r('[ui_components].color.red') })
          .enabled(!this.busyOrderId)
          .onClick(() => {
            this.advanceOneStep(order.id)
          })
      }
      .width('100%')
      .padding({ bottom: 10 })
    } else if (this.displayStateFor(order) === 4) {
      Row({ space: 8 }) {
        Blank()
        Button('去评价')
          .height(32)
          .fontSize(12)
          .fontColor($r('[ui_components].color.red'))
          .backgroundColor($r('[ui_components].color.white'))
          .border({ width: 0.5, color: $r('[ui_components].color.red') })
          .enabled(!this.busyOrderId)
          .onClick(() => {
            this.runComment(order.id)
          })
      }
      .width('100%')
      .padding({ bottom: 10 })
    } else if (this.displayStateFor(order) === 5) {
      Row({ space: 8 }) {
        Blank()
        Text('已演示完成')
          .fontSize(12)
          .fontColor($r('[ui_components].color.gray'))
      }
      .width('100%')
      .padding({ bottom: 10 })
    }
  }

  @Builder
  private OrderCard(order: OrderItem) {
    Column() {
      Row({ space: 6 }) {
        Text(order.createTime)
          .fontSize(11)
          .fontColor($r('[ui_components].color.gray'))
        if (this.displayStateFor(order) === 1 && this.remainingCountdown(order) > 0) {
          Text(formatOrderCountdown(this.remainingCountdown(order)))
            .fontSize(11)
            .fontColor($r('[ui_components].color.red'))
        }
        if (this.isOverlayApplied(order)) {
          Blank().width(8)
          Text('本地演示')
            .fontSize(10)
            .fontColor($r('[ui_components].color.gray'))
            .border({ width: 0.5, color: $r('[ui_components].color.border') })
            .borderRadius(2)
            .padding({ left: 4, right: 4 })
        }
        Blank()
        Text(getOrderStateText(this.displayStateFor(order)))
          .fontSize(13)
          .fontColor(this.displayStateFor(order) === 6 ? $r('[ui_components].color.gray') : $r('[ui_components].color.red'))
      }
      .width('100%')
      .padding({ top: 12, bottom: 2 })

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

      this.OrderActions(order)
    }
    .width('100%')
    .padding({ left: 12, right: 12 })
    .backgroundColor($r('[ui_components].color.white'))
    .borderRadius(8)
    .onClick(() => this.openDetail(order.id))
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: '我的订单',
          onLeftClick: () => this.stackPath.pop()
        })

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
            }, (order: OrderItem) => order.id)
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
  }
}
