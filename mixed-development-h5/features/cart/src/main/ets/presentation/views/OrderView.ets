import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMUser, OrderItem, OrderSku } from 'models'
import { HDMEmpty, HDMNavBar } from 'ui_components'
import { consignmentOrderAPI, getOrderListAPI } from '../../data/api'

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
  @State selectedState: number = 0
  @State loading: boolean = false
  @State loadFailed: boolean = false
  @State consignmentOrderId: string = ''
  @State isFinished: boolean = false
  @Consume stackPath: NavPathStack

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
    this.reloadOrders()
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
    await this.loadMore()
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

  private selectTab(orderState: number): void {
    if (this.selectedState === orderState) {
      return
    }
    this.selectedState = orderState
    this.reloadOrders()
  }

  private async simulateConsignment(orderId: string): Promise<void> {
    if (this.consignmentOrderId || !orderId) {
      return
    }
    this.consignmentOrderId = orderId
    try {
      await consignmentOrderAPI(orderId)
      this.safeToast('模拟发货成功，订单状态将刷新')
      await this.reloadOrders()
    } catch {
      this.safeToast('模拟发货失败，请稍后重试')
    } finally {
      this.consignmentOrderId = ''
    }
  }

  private getOrderStateText(orderState: number): string {
    if (orderState === 1) {
      return '待付款'
    }
    if (orderState === 2) {
      return '待发货'
    }
    if (orderState === 3) {
      return '待收货'
    }
    if (orderState === 4) {
      return '待评价'
    }
    if (orderState === 5) {
      return '已完成'
    }
    if (orderState === 6) {
      return '已取消'
    }
    return '订单处理中'
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
  private OrderCard(order: OrderItem) {
    Column() {
      Row() {
        Text(order.createTime)
          .fontSize(11)
          .fontColor($r('[ui_components].color.gray'))
        Blank()
        Text(this.getOrderStateText(order.orderState))
          .fontSize(13)
          .fontColor(order.orderState === 6 ? $r('[ui_components].color.gray') : $r('[ui_components].color.red'))
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

      if (order.orderState === 2) {
        Row() {
          Blank()
          Button(this.consignmentOrderId === order.id ? '发货中...' : '模拟发货')
            .height(32)
            .fontSize(12)
            .fontColor($r('[ui_components].color.red'))
            .backgroundColor($r('[ui_components].color.white'))
            .border({ width: 0.5, color: $r('[ui_components].color.red') })
            .enabled(!this.consignmentOrderId)
            .onClick(() => this.simulateConsignment(order.id))
        }
        .width('100%')
        .padding({ bottom: 10 })
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
