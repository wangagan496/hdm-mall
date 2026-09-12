import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMNavBar } from 'ui_components'
import { DemoOrderOverlay, LocalEvaluationItem, OrderItem, OrderSku } from 'models'
import { demoOrderStore } from 'storage'
import {
  cancelOrderWithFallback,
  consignmentOrderAPI,
  getOrderDetailAPI,
  receiptOrderAPI
} from '../../data/api'
import { getDisplayOrderStateText, mergeOrderState } from '../utils/OrderPresentation'
import { getScoreLabel } from '../utils/EvaluationPresentation'
import { advanceOrderState } from '../utils/DemoOrderFlow'
import { OrderCountdown } from '../components'

@Builder
function OrderDetailViewBuilder() {
  OrderDetailView()
}

@Component
export struct OrderDetailView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM)
  bottomHeight: number = 0
  @State order: OrderItem | null = null
  @State demoOverlay: DemoOrderOverlay | null = null
  @State evaluation: LocalEvaluationItem | null = null
  @State loading: boolean = true
  @State loadFailed: boolean = false
  @State busy: string = ''
  @Consume stackPath: NavPathStack

  private orderId: string = ''
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
    this.load()
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
      this.refreshLocalOverlay()
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
      this.refreshLocalOverlay()
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
    const orderId: string = this.order.id
    await advanceOrderState(orderId, 3, async (): Promise<void> => {
      await consignmentOrderAPI(orderId)
    })
  }

  private async runReceipt(): Promise<void> {
    if (!this.order) {
      return
    }
    const orderId: string = this.order.id
    await advanceOrderState(orderId, 4, async (): Promise<void> => {
      await receiptOrderAPI(orderId)
    })
  }

  private async runComment(): Promise<void> {
    if (!this.order) {
      return
    }
    this.stackPath.pushPath({ name: PAGE_PATH.EVALUATION_PAGE, param: this.order.id })
  }

  private refreshLocalOverlay(): void {
    if (!this.order) {
      this.demoOverlay = null
      this.evaluation = null
      return
    }
    this.demoOverlay = demoOrderStore.getOverlay(this.order.id)
    this.evaluation = demoOrderStore.getEvaluation(this.order.id)
  }

  private mergedState(): number {
    if (!this.order) {
      return 0
    }
    return mergeOrderState(this.order, this.demoOverlay, this.evaluation)
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
    return getDisplayOrderStateText(this.mergedState(), this.hasEvaluation())
  }

  @Builder
  private DetailActions() {
    Column() {
      if (this.order) {
        if (this.mergedState() === 1) {
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
          }
          .width('100%')
        } else if (this.mergedState() === 2) {
          Row() {
            Blank()
            Button(this.busy === 'consignment' ? '处理中...' : '提醒发货')
              .height(36)
              .fontSize(13)
              .fontColor($r('[ui_components].color.gray'))
              .backgroundColor($r('[ui_components].color.white'))
              .border({ width: 0.5, color: $r('[ui_components].color.border') })
              .enabled(!this.busy)
              .onClick(() => this.run('consignment', (): Promise<void> => this.runConsignment(), '已提醒商家发货'))
          }
          .width('100%')
        } else if (this.mergedState() === 3) {
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
              .enabled(!this.busy)
              .onClick(() => this.run('receipt', (): Promise<void> => this.runReceipt(), '已确认收货'))
          }
          .width('100%')
        } else if (this.mergedState() === 4) {
          Row() {
            Blank()
            Button('去评价')
              .height(36)
              .fontSize(13)
              .fontColor($r('[ui_components].color.red'))
              .backgroundColor($r('[ui_components].color.white'))
              .border({ width: 0.5, color: $r('[ui_components].color.red') })
              .enabled(!this.busy)
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
          title: this.order ? this.displayStateText() : '订单详情',
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
                  Text(this.displayStateText())
                    .fontSize(18)
                    .fontWeight(500)
                  if (this.mergedState() === 1) {
                    OrderCountdown({ countdown: this.order.countdown, baseAt: this.countdownBaseAt, fontSize: 12 })
                  }
                }
                if (this.mergedState() === 1) {
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
              .alignItems(HorizontalAlign.Start)

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
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
            .padding({ left: 12, right: 12, top: 12, bottom: 16 })
          }
          .width('100%')
          .layoutWeight(1)
          .align(Alignment.TopStart)
          .scrollBar(BarState.Off)

          Column() {
            Button('查看全部订单')
              .width('100%')
              .height(44)
              .fontSize(14)
              .backgroundColor($r('[ui_components].color.white'))
              .fontColor($r('[ui_components].color.black'))
              .border({ width: 0.5, color: $r('[ui_components].color.border') })
              .onClick(() => this.stackPath.pushPath({ name: PAGE_PATH.ORDER_PAGE, param: 0 }))
          }
          .width('100%')
          .padding({ left: 12, right: 12, top: 8, bottom: 8 + this.bottomHeight })
          .backgroundColor($r('[ui_components].color.white'))
        }
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.Start)
      .backgroundColor($r('[ui_components].color.under'))
    }
    .hideTitleBar(true)
    .padding({ top: this.topHeight })
    .onShown(() => {
      this.refreshLocalOverlay()
    })
  }
}
