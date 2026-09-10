import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMNavBar } from 'ui_components'
import { OrderItem, OrderSku, PayResultParams } from 'models'
import {
  cancelOrderWithFallback,
  commentOrderAPI,
  consignmentOrderAPI,
  getOrderDetailAPI,
  receiptOrderAPI
} from '../../data/api'
import { formatOrderCountdown, getOrderStateText } from '../utils/OrderPresentation'

@Builder
function OrderDetailViewBuilder() {
  OrderDetailView()
}

@Component
export struct OrderDetailView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @State order: OrderItem | null = null
  @State loading: boolean = true
  @State loadFailed: boolean = false
  @State busy: string = ''
  @State countdownTick: number = 0
  @Consume stackPath: NavPathStack

  private orderId: string = ''
  private countdownTimer: number = -1
  private countdownBaseAt: number = 0

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  aboutToAppear(): void {
    const params = this.stackPath.getParamByName(PAGE_PATH.ORDER_DETAIL_PAGE) as string[]
    this.orderId = params && params.length ? params[params.length - 1] : ''
    this.countdownTimer = setInterval(() => {
      this.countdownTick++
    }, 1000)
    this.load()
  }

  aboutToDisappear(): void {
    clearInterval(this.countdownTimer)
  }

  /** 同订单列表：服务端只给下单时刻的剩余秒数，页面按加载时刻回推。 */
  private remainingCountdown(): number {
    if (!this.order || this.countdownTick < 0) {
      return 0
    }
    const elapsed: number = Math.floor((Date.now() - this.countdownBaseAt) / 1000)
    return this.order.countdown - elapsed
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
    } catch {
      this.loadFailed = true
      this.safeToast('订单加载失败，请稍后重试')
    } finally {
      this.loading = false
    }
  }

  private async run(action: string, task: () => Promise<void>, successText: string): Promise<void> {
    if (this.busy) {
      return
    }
    this.busy = action
    try {
      await task()
      this.safeToast(successText)
      await this.load()
    } catch {
      this.safeToast('操作失败，请稍后重试')
    } finally {
      this.busy = ''
    }
  }

  private async runCancelWithFallback(): Promise<void> {
    if (!this.order) {
      return
    }
    await cancelOrderWithFallback(this.order.id)
  }

  private async runConsignment(): Promise<void> {
    if (!this.order) {
      return
    }
    await consignmentOrderAPI(this.order.id)
  }

  private async runReceipt(): Promise<void> {
    if (!this.order) {
      return
    }
    await receiptOrderAPI(this.order.id)
  }

  private async runComment(): Promise<void> {
    if (!this.order) {
      return
    }
    await commentOrderAPI(this.order.id)
  }

  @Builder
  private DetailActions() {
    Column() {
      if (this.order) {
        if (this.order.orderState === 1) {
          Row({ space: 8 }) {
            Button(this.busy === 'cancel' ? '取消中...' : '取消订单')
              .height(36)
              .fontSize(13)
              .fontColor($r('[ui_components].color.gray'))
              .backgroundColor($r('[ui_components].color.white'))
              .border({ width: 0.5, color: $r('[ui_components].color.border') })
              .enabled(!this.busy)
              .onClick(() => this.run('cancel', (): Promise<void> => this.runCancelWithFallback(), '订单已取消'))
            Button('去支付')
              .height(36)
              .fontSize(13)
              .backgroundColor($r('[ui_components].color.red'))
              .onClick(() => this.stackPath.pushPath({ name: PAGE_PATH.PAY_PAGE, param: this.order!.id }))
            // 沙箱环境没有真实支付回调，这里只引导到支付结果页，以服务端查单结果为准。
            Button('查支付状态')
              .height(36)
              .fontSize(13)
              .fontColor($r('[ui_components].color.red'))
              .backgroundColor($r('[ui_components].color.white'))
              .border({ width: 0.5, color: $r('[ui_components].color.red') })
              .enabled(!this.busy)
              .onClick(() => {
                this.safeToast('沙箱环境：请在支付页点"我已完成支付"后以服务端状态为准')
                const resultParams: PayResultParams = { payResult: false, orderId: this.order!.id }
                this.stackPath.pushPath({ name: PAGE_PATH.PAY_RESULT_PAGE, param: resultParams })
              })
          }
          .width('100%')
        } else if (this.order.orderState === 2) {
          Row() {
            Blank()
            Button(this.busy === 'consignment' ? '发货中...' : '模拟发货')
              .height(36)
              .fontSize(13)
              .fontColor($r('[ui_components].color.red'))
              .backgroundColor($r('[ui_components].color.white'))
              .border({ width: 0.5, color: $r('[ui_components].color.red') })
              .enabled(!this.busy)
              .onClick(() => this.run('consignment', (): Promise<void> => this.runConsignment(), '模拟发货成功'))
          }
          .width('100%')
        } else if (this.order.orderState === 3) {
          Row() {
            Blank()
            Button(this.busy === 'receipt' ? '确认中...' : '确认收货')
              .height(36)
              .fontSize(13)
              .backgroundColor($r('[ui_components].color.red'))
              .enabled(!this.busy)
              .onClick(() => this.run('receipt', (): Promise<void> => this.runReceipt(), '已确认收货'))
          }
          .width('100%')
        } else if (this.order.orderState === 4) {
          Row() {
            Blank()
            Button(this.busy === 'comment' ? '提交中...' : '去评价')
              .height(36)
              .fontSize(13)
              .fontColor($r('[ui_components].color.red'))
              .backgroundColor($r('[ui_components].color.white'))
              .border({ width: 0.5, color: $r('[ui_components].color.red') })
              .enabled(!this.busy)
              .onClick(() => this.run('comment', (): Promise<void> => this.runComment(), '评价成功，订单已完成'))
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
          title: this.order ? getOrderStateText(this.order.orderState) : '订单详情',
          onLeftClick: () => this.stackPath.pop()
        })
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
              .onClick(() => this.load())
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
                  Text(getOrderStateText(this.order.orderState))
                    .fontSize(18)
                    .fontWeight(500)
                  if (this.order.orderState === 1 && this.remainingCountdown() > 0) {
                    Text(formatOrderCountdown(this.remainingCountdown()))
                      .fontSize(12)
                      .fontColor($r('[ui_components].color.red'))
                  }
                }
                if (this.order.orderState === 1) {
                  Text('请在 ' + this.order.payLatestTime + ' 前完成支付，超时自动取消')
                    .fontSize(12)
                    .fontColor($r('[ui_components].color.gray'))
                }
                Text('订单号 ' + this.order.id)
                  .fontSize(11)
                  .fontColor($r('[ui_components].color.gray'))
                Text(this.order.createTime + ' 下单')
                  .fontSize(11)
                  .fontColor($r('[ui_components].color.gray'))
              }
              .width('100%')
              .padding(12)
              .backgroundColor($r('[ui_components].color.white'))
              .borderRadius(8)

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

              Column({ space: 10 }) {
                Row() {
                  Text('支付方式')
                    .fontSize(13)
                    .fontColor($r('[ui_components].color.gray'))
                  Blank()
                  Text(this.order.payChannel === 1 ? '支付宝' : '在线支付')
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

              Button('查看全部订单')
                .width('100%')
                .height(36)
                .fontSize(13)
                .backgroundColor($r('[ui_components].color.white'))
                .fontColor($r('[ui_components].color.black'))
                .border({ width: 0.5, color: $r('[ui_components].color.border') })
                .onClick(() => this.stackPath.pushPath({ name: PAGE_PATH.ORDER_PAGE, param: 0 }))
            }
            .padding(8)
          }
          .layoutWeight(1)
          .scrollBar(BarState.Off)
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
