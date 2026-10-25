import { GlobalVariable, PAGE_PATH } from 'constants'
import { OrderItem, PayResultParams } from 'models'
import { HDMNavBar } from 'ui_components'
import { auth, demoOrderStore } from 'storage'
import { getOrderDetailAPI, mockPayAPI, invitePayerAPI, getFamilyRelationsAPI, FamilyRelation } from '../../data/api'
import { mergeOrderState } from '../utils/OrderPresentation'
import { OrderCountdown } from '../components'

@Component
struct PayView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @State order: OrderItem | null = null
  @State loading: boolean = true
  @State loadFailed: boolean = false
  @State paying: boolean = false
  @State relatives: FamilyRelation[] = []
  private active: boolean = true
  @Consume stackPath: NavPathStack
  private orderId: string = ''
  private countdownBaseAt: number = 0

  aboutToAppear(): void {
    this.active = true
    const params = this.stackPath.getParamByName(PAGE_PATH.PAY_PAGE) as string[]
    this.orderId = params && params.length ? params[params.length - 1] : ''
    this.load()
  }

  aboutToDisappear(): void { this.active = false }

  private async choosePayer(friendId: string | null): Promise<void> {
    if (this.paying || !this.order) { return }
    this.paying = true
    try {
      await invitePayerAPI(this.orderId, friendId)
      if (!this.active) { return }
      this.safeToast(friendId ? '已发送代付邀请，亲友可在亲友中心付款' : '已切换为本人付款')
      await this.load()
    } catch {
      if (this.active) { this.safeToast('操作失败，请刷新后重试') }
    } finally { this.paying = false }
  }

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  /** 支付前校验用的即时剩余秒数；界面上的倒计时由 OrderCountdown 组件自己驱动。 */
  private remainingCountdown(): number {
    if (!this.order) {
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
      const order: OrderItem = await getOrderDetailAPI(this.orderId)
      if (!this.active) { return }
      this.order = order
      this.countdownBaseAt = Date.now()
      if (this.mergedState() >= 2 && this.mergedState() <= 5) {
        this.stackPath.replacePath({
          name: PAGE_PATH.PAY_RESULT_PAGE,
          param: { payResult: true, orderId: this.orderId } as PayResultParams
        })
        return
      }
      if (order.orderState === 6) {
        this.safeToast('订单已取消')
        this.stackPath.pop()
        return
      }
      if (order.canInvitePayer) {
        try {
          const relations: FamilyRelation[] = await getFamilyRelationsAPI()
          if (this.active) {
            this.relatives = relations.filter((item: FamilyRelation) => item.status === 'accepted' && item.ownerAccount === auth.getUserInfo()?.account)
          }
        } catch {
          if (this.active) {
            this.relatives = []
            this.safeToast('亲友列表加载失败')
          }
        }
      }
    } catch {
      this.loadFailed = true
    } finally {
      this.loading = false
    }
  }

  // 演示支付：本地推进订单覆盖层，不产生真实扣款。开关与说明见 GlobalVariable.DEMO_ORDER_FLOW。
  private async handleMockPay(): Promise<void> {
    if (!this.order || this.paying) {
      return
    }
    if (!this.order.serverManaged && !GlobalVariable.DEMO_ORDER_FLOW) {
      this.safeToast('当前环境未接入支付渠道')
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
      if (this.order.serverManaged) {
        await mockPayAPI(this.order.id, this.order.payMoney)
      } else {
        await demoOrderStore.setOverlay(this.order.id, 2)
      }
      if (!this.active) { return }
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
                  OrderCountdown({
                    countdown: this.order.countdown,
                    baseAt: this.countdownBaseAt,
                    fontSize: 12,
                    expiredText: this.order.countdown > 0 ? '已超时' : ''
                  })
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
                Text(this.order.invitedPayerAccount ? '等待亲友 ' + this.order.invitedPayerAccount + ' 代付' : '本人模拟支付')
                  .fontSize(14).padding(12)
                if (this.order.canInvitePayer) {
                  Button('本人付款').enabled(!this.paying).onClick(() => this.choosePayer(null))
                  ForEach(this.relatives, (relative: FamilyRelation) => {
                    Button('邀请 ' + relative.friendAccount + ' 代付')
                      .enabled(!this.paying).onClick(() => this.choosePayer(relative.friendId))
                  }, (relative: FamilyRelation) => relative.id)
                  if (this.relatives.length === 0) {
                    Text('请先到「我的 → 亲友中心」绑定亲友').fontSize(12).padding(8)
                  }
                }
                Button('刷新支付状态').enabled(!this.paying).onClick(() => this.load())
              }
              .width('100%')
              .padding(16)
              .backgroundColor($r('[ui_components].color.white'))
              .borderRadius(12)

              Column({ space: 6 }) {
                Row({ space: 6 }) {
                  Image($r('[ui_components].media.ic_public_check_filled')).width(14).height(14).fillColor('#07C160')
                  Text('模拟支付，不产生真实扣款')
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
                .enabled(!this.paying && (!this.order.serverManaged || this.order.canPay === true))
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
