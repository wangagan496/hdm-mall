import { GlobalVariable, PAGE_PATH } from 'constants'
import { OrderItem, PayResultParams } from 'models'
import { HDMNavBar } from 'ui_components'
import { demoOrderStore } from 'storage'
import { getOrderDetailAPI } from '../../data/api'
import { formatOrderCountdown, mergeOrderState } from '../utils/OrderPresentation'

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

  // 演示支付：本地推进订单覆盖层，不产生真实扣款
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
          title: '确认付款',
          onLeftClick: () => {
            this.stackPath.pop()
          }
        })
        if (this.loading) {
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
                this.ChannelRow('支', '#1677FF', '支付宝', '演示环境不产生真实扣款', 1, true)
                Divider().strokeWidth(0.5).color($r('[ui_components].color.border'))
                this.ChannelRow('微', '#07C160', '微信支付', '演示环境不产生真实扣款', 2, true)
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
                Text('本页为演示支付，不产生真实扣款。点「确认支付」后订单进入待发货。')
                  .fontSize(11)
                  .fontColor($r('[ui_components].color.gray'))
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
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 0, bottom: 12 })
          .backgroundColor($r('[ui_components].color.white'))
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
