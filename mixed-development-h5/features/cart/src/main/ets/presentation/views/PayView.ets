import { GlobalVariable, PAGE_PATH } from 'constants'
import { FamilyRelationPage, HDMUser, OrderItem, PayResultParams, formatBeijingTime } from 'models'
import { HDMNavBar } from 'ui_components'
import { auth, demoOrderStore, RecoveryQuery } from 'storage'
import { getOrderDetailAPI, startPaymentAPI, invitePayerAPI, getPayerRelationsPageAPI, FamilyRelation } from '../../data/api'
import { mergeOrderState, readPhoneClockMillis, secondsLeftToPay } from '../utils/OrderPresentation'
import { OrderCountdown } from '../components'

interface PaymentErrorResponse { status?: number }
interface PaymentError { message?: string; httpStatus?: number; response?: PaymentErrorResponse }

@Component
struct PayView {
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('reloadForCurrentAccount')
  user: HDMUser = { account: '', nickname: '', token: '', avatar: '' }
  @StorageProp(GlobalVariable.APP_FOREGROUND_SEQUENCE) @Watch('refreshAfterForeground') foregroundSequence: number = 0
  private querySequence: number = 0
  private cashierCheck: RecoveryQuery | undefined = undefined
  @State checkingCashier: boolean = false
  @State invitationUnknown: boolean = false
  private cashierCheckBusy: boolean = false

  private stopCashierCheck(): void {
    this.cashierCheck?.cancel()
    this.cashierCheck = undefined
    this.checkingCashier = false
    this.cashierCheckBusy = false
  }

  private scheduleCashierCheck(): void {
    if (this.cashierCheck || !this.isCurrentCashier(this.pageGeneration, this.sessionToken, this.orderId) ||
      !(this.invitationUnknown || this.order?.paymentState === 'confirming' || this.order?.paymentState === 'review')) return
    const job: RecoveryQuery = new RecoveryQuery()
    this.cashierCheck = job
    this.checkingCashier = true
    job.start(() => this.checkCashierStatus(), () => {
      if (this.cashierCheck === job) this.checkingCashier = false
    }, [2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000,
      10000, 30000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 50000], 600000)
  }

  private async checkCashierStatus(): Promise<boolean> {
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const id: string = this.orderId
    if (!this.isCurrentCashier(generation, token, id)) return true
    if (this.cashierCheckBusy || this.loading || this.paying) return false
    this.cashierCheckBusy = true
    const sequence: number = this.querySequence
    try {
      const order: OrderItem = await getOrderDetailAPI(id, token)
      if (!this.isCurrentQuery(sequence, generation, token, id)) return true
      if (order.id !== id) return false
      this.order = order
      this.loadedToken = token
      this.loadFailed = false
      this.invitationUnknown = false
      this.countdownBaseAt = readPhoneClockMillis()
      if (order.orderState >= 2 && order.orderState <= 5) { this.openPaymentResult(id); return true }
      if (order.orderState === 6) { this.aboutToDisappear(); this.stackPath.pop(); return true }
      const done: boolean = order.paymentState !== 'confirming' && order.paymentState !== 'review'
      if (done) this.stopCashierCheck()
      return done
    } catch { return false }
    finally { if (this.isCurrentCashier(generation, token, id)) this.cashierCheckBusy = false }
  }

  private refreshAfterForeground(): void {
    if (this.active && !this.paying) {
      if (this.checkingCashier || this.invitationUnknown) void this.checkCashierStatus()
      else this.load()
    }
  }
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @State order: OrderItem | null = null
  @State loading: boolean = true
  @State loadFailed: boolean = false
  @State paying: boolean = false
  @State relatives: FamilyRelation[] = []
  @State relativePage: number = 1
  @State relativePages: number = 0
  @State relativesLoadFailed: boolean = false
  @State active: boolean = true
  private pageGeneration: number = 0
  @State sessionToken: string = ''
  @State sessionOrderId: string = ''
  @State loadedToken: string = ''
  @Consume stackPath: NavPathStack
  @State orderId: string = ''
  private countdownBaseAt: number = 0

  aboutToAppear(): void {
    this.active = true
    const params = this.stackPath.getParamByName(PAGE_PATH.PAY_PAGE) as string[]
    this.orderId = params && params.length ? params[params.length - 1] : ''
    this.load()
  }

  aboutToDisappear(): void {
    this.stopCashierCheck()
    this.active = false
    this.pageGeneration++
    this.querySequence++
    this.loading = false
    this.paying = false
  }

  private showCashier(): void {
    if (!this.active) this.aboutToAppear()
  }

  private reloadForCurrentAccount(): void {
    if ((auth.getUserInfo()?.token || '') === this.sessionToken) return
    this.synchronizeCashierContext()
    if (this.active) this.load()
  }

  private synchronizeCashierContext(): void {
    const token: string = auth.getUserInfo()?.token || ''
    if (token === this.sessionToken && this.orderId === this.sessionOrderId) return
    this.stopCashierCheck()
    this.invitationUnknown = false
    this.sessionToken = token
    this.sessionOrderId = this.orderId
    this.pageGeneration++
    this.querySequence++
    this.loadedToken = ''
    this.order = null
    this.relatives = []
    this.relativePage = 1
    this.relativePages = 0
    this.loading = false
    this.loadFailed = true
    this.relativesLoadFailed = false
    this.paying = false
    this.countdownBaseAt = 0
  }

  private isCurrentCashier(generation: number, token: string, orderId: string): boolean {
    return this.active && generation === this.pageGeneration && token.length > 0 &&
      token === this.sessionToken && token === auth.getUserInfo()?.token && orderId.length > 0 &&
      orderId === this.orderId && orderId === this.sessionOrderId
  }

  private isCurrentQuery(sequence: number, generation: number, token: string, orderId: string): boolean {
    return sequence === this.querySequence && this.isCurrentCashier(generation, token, orderId)
  }

  private canManagePayment(): boolean {
    return this.isCurrentCashier(this.pageGeneration, this.sessionToken, this.orderId) &&
      this.loadedToken === this.sessionToken && !!this.order && this.order.id === this.orderId &&
      !this.loading && !this.loadFailed && !this.paying && !this.invitationUnknown && this.mergedState() === 1 &&
      this.order.paymentState !== 'confirming' && this.order.paymentState !== 'review'
  }

  private openPaymentResult(orderId: string): void {
    this.aboutToDisappear()
    this.stackPath.replacePath({
      name: PAGE_PATH.PAY_RESULT_PAGE,
      param: { payResult: true, orderId } as PayResultParams
    })
  }

  private async choosePayer(friendId: string | null): Promise<void> {
    if (!this.canManagePayment() || !this.order?.canInvitePayer) return
    if (friendId !== null && (this.relativesLoadFailed ||
      !this.relatives.some((relative: FamilyRelation) => relative.friendId === friendId))) return
    this.paying = true
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const orderId: string = this.orderId
    try {
      await invitePayerAPI(orderId, friendId, token)
      if (!this.isCurrentCashier(generation, token, orderId)) return
      this.safeToast(friendId ? '已发送代付邀请，亲友可在亲友中心付款' : '已切换为本人付款')
      await this.load()
    } catch {
      if (this.isCurrentCashier(generation, token, orderId)) {
        this.querySequence++
        this.loading = false
        this.loadFailed = true
        this.invitationUnknown = true
        this.safeToast('操作结果未确认，请刷新订单后重试')
      }
    } finally {
      if (this.isCurrentCashier(generation, token, orderId)) { this.paying = false; this.scheduleCashierCheck() }
    }
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
    return secondsLeftToPay(this.order.countdown, this.countdownBaseAt)
  }

  private mergedState(): number {
    if (!this.order) {
      return 1
    }
    return mergeOrderState(this.order, demoOrderStore.getOverlay(this.order.id), demoOrderStore.getEvaluation(this.order.id))
  }

  private async load(relativePage: number = this.relativePage): Promise<void> {
    const previousToken: string = this.sessionToken
    const previousOrderId: string = this.sessionOrderId
    this.synchronizeCashierContext()
    if (previousToken !== this.sessionToken || previousOrderId !== this.sessionOrderId) relativePage = 1
    const sequence: number = ++this.querySequence
    const token: string = this.sessionToken
    const generation: number = this.pageGeneration
    const orderId: string = this.orderId
    if (!this.isCurrentCashier(generation, token, orderId)) {
      this.loading = false
      this.loadFailed = true
      return
    }
    this.loading = true
    this.loadFailed = false
    try {
      const order: OrderItem = await getOrderDetailAPI(orderId, token)
      if (!this.isCurrentQuery(sequence, generation, token, orderId)) return
      if (order.id !== orderId) throw new Error('订单结果不匹配')
      this.order = order
      this.loadedToken = token
      this.countdownBaseAt = readPhoneClockMillis()
      if (this.mergedState() >= 2 && this.mergedState() <= 5) {
        this.openPaymentResult(orderId)
        return
      }
      if (order.orderState === 6) {
        this.safeToast('订单已取消')
        this.aboutToDisappear()
        this.stackPath.pop()
        return
      }
      if (order.canInvitePayer) {
        try {
          let relations: FamilyRelationPage = await getPayerRelationsPageAPI(relativePage, token)
          if (!this.isCurrentQuery(sequence, generation, token, orderId)) return
          if (relations.page > Math.max(1, relations.pages)) {
            relations = await getPayerRelationsPageAPI(Math.max(1, relations.pages), token)
          }
          if (!this.isCurrentQuery(sequence, generation, token, orderId)) return
          this.relatives = relations.items
          this.relativePage = relations.page
          this.relativePages = relations.pages
          this.relativesLoadFailed = false
        } catch {
          if (this.isCurrentQuery(sequence, generation, token, orderId)) {
            this.relativesLoadFailed = true
          }
        }
      } else {
        this.relatives = []
        this.relativePage = 1
        this.relativePages = 0
        this.relativesLoadFailed = false
      }
    } catch {
      if (this.isCurrentQuery(sequence, generation, token, orderId)) {
        this.loadFailed = true
      }
    } finally {
      if (this.isCurrentQuery(sequence, generation, token, orderId)) {
        this.loading = false
        this.scheduleCashierCheck()
      }
    }
  }

  // 演示支付：本地推进订单覆盖层，不产生真实扣款。开关与说明见 GlobalVariable.DEMO_ORDER_FLOW。
  private async handlePayment(): Promise<void> {
    if (!this.order || !this.canManagePayment() || (this.order.serverManaged && !this.order.canPay)) {
      return
    }
    if (!this.order.serverManaged && !GlobalVariable.DEMO_ORDER_FLOW) {
      this.safeToast('当前环境未接入支付渠道')
      return
    }
    if (this.remainingCountdown() <= 0) {
      this.safeToast('订单已超时，请重新下单')
      return
    }
    this.paying = true
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const orderId: string = this.order.id
    const serverManaged: boolean = this.order.serverManaged === true
    const amount: number = this.order.payMoney
    try {
      if (serverManaged) {
        await startPaymentAPI(orderId, amount, token)
      } else {
        await demoOrderStore.setOverlay(orderId, 2)
      }
      if (!this.isCurrentCashier(generation, token, orderId)) return
      this.openPaymentResult(orderId)
    } catch (error) {
      if (this.isCurrentCashier(generation, token, orderId)) {
        const failure = error as PaymentError
        const status: number | undefined = failure.httpStatus || failure.response?.status
        if (serverManaged && status !== undefined && status < 500 && status !== 408 && status !== 429) {
          this.safeToast(failure.message || '付款未能发起，请刷新订单')
          await this.load()
        } else if (serverManaged) {
          this.openPaymentResult(orderId)
        } else {
          this.querySequence++
          this.loading = false
          this.loadFailed = true
          this.safeToast('演示支付保存失败，请刷新后重试')
        }
      }
    } finally {
      if (this.isCurrentCashier(generation, token, orderId)) this.paying = false
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
            Text('订单状态待确认').fontSize(14).fontColor($r('[ui_components].color.black'))
            Text('请重新加载，确认最新状态后再操作').fontSize(12).fontColor($r('[ui_components].color.gray'))
            Button(this.invitationUnknown ? '核对邀请结果' : '重新加载').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') })
              .onClick(() => { if (this.invitationUnknown) void this.checkCashierStatus(); else this.load() })
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
                  Text(this.order.paymentState === 'review' || this.order.paymentState === 'confirming' ? '等待付款结果' : '需付款')
                    .fontSize(13)
                    .fontColor($r('[ui_components].color.gray'))
                  Blank()
                  if (this.order.paymentState === 'confirming' || this.order.paymentState === 'review') {
                    Text(this.order.paymentState === 'review' ? '核实中' : '确认中')
                      .fontSize(12)
                      .fontColor($r('[ui_components].color.red'))
                  } else {
                    OrderCountdown({
                      countdown: this.order.countdown,
                      baseAt: this.countdownBaseAt,
                      fontSize: 12,
                      expiredText: this.order.countdown > 0 ? '已超时' : ''
                    })
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
                  Text(formatBeijingTime(this.order.createTime) + ' 下单')
                    .fontSize(11)
                    .fontColor($r('[ui_components].color.gray'))
                }
              }
              .width('100%')
              .padding(16)
              .backgroundColor($r('[ui_components].color.white'))
              .borderRadius(12)

              if (this.order.paymentState === 'confirming' || this.order.paymentState === 'review') {
                Text(this.order.paymentNotice || '正在确认付款结果，请勿重复付款')
                  .fontSize(13)
                  .fontColor($r('[ui_components].color.gray'))
                  .width('100%')
                  .padding(12)
                  .backgroundColor($r('[ui_components].color.white'))
                  .borderRadius(8)
              }

              Column({ space: 0 }) {
                Text('选择支付方式')
                  .fontSize(13)
                  .fontWeight(500)
                  .width('100%')
                  .padding({ bottom: 4 })
                Divider().strokeWidth(0.5).color($r('[ui_components].color.border'))
                Text(this.order.invitedPayerAccount ? '当前付款人：亲友 ' + this.order.invitedPayerAccount : '当前付款人：本人')
                  .fontSize(14).padding(12)
                if (this.order.canInvitePayer) {
                  Button('本人付款').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(this.canManagePayment()).onClick(() => this.choosePayer(null))
                  Row({ space: 8 }) {
                    Button('代付上一页').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(!this.paying && this.relativePage > 1)
                      .onClick(() => this.load(this.relativePage - 1))
                    Text(this.relativePage + ' / ' + Math.max(1, this.relativePages))
                    Button('代付下一页').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(!this.paying && this.relativePage < this.relativePages)
                      .onClick(() => this.load(this.relativePage + 1))
                  }
                  if (this.relativesLoadFailed) {
                    Text('亲友列表加载失败，请重试').fontSize(12).fontColor('#B34D36')
                    Button('重试亲友列表').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(!this.paying).onClick(() => this.load())
                  }
                  ForEach(this.relatives, (relative: FamilyRelation) => {
                    Button('邀请 ' + relative.friendAccount + ' 代付').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') })
                      .enabled(this.canManagePayment() && !this.relativesLoadFailed).onClick(() => this.choosePayer(relative.friendId))
                  }, (relative: FamilyRelation) => relative.id)
                  if (!this.relativesLoadFailed && this.relatives.length === 0) {
                    Text('请先到「我的 → 亲友中心」绑定亲友').fontSize(12).padding(8)
                  }
                }
                Button('刷新支付状态').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(!this.paying && !this.cashierCheckBusy).onClick(() => this.checkCashierStatus())
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
                Text(GlobalVariable.DEMO_ORDER_FLOW ? '本页为演示支付，不产生真实扣款。点「确认支付」后订单进入待发货。' :
                  '模拟支付不产生真实扣款。提交后会确认付款结果，请勿重复付款。')
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
              Button(this.paying ? '支付中...' :
                this.order.paymentState === 'confirming' || this.order.paymentState === 'review' ? '付款结果确认中' :
                  '确认支付 ¥' + this.order.payMoney.toFixed(2)).fontColor($r('[ui_components].color.on_primary'))
                .height(44)
                .fontSize(14)
                .fontWeight(500)
                .layoutWeight(1)
                .backgroundColor($r('[ui_components].color.red'))
                .enabled(this.canManagePayment() && (!this.order.serverManaged || this.order.canPay === true))
                .onClick(() => this.handlePayment())
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
    .onShown(() => this.showCashier())
    .onHidden(() => this.aboutToDisappear())
    .padding({ top: this.topHeight, bottom: this.safeBottom })
  }
}

@Builder
function PayViewBuilder() {
  PayView()
}
