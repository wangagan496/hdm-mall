import { GlobalVariable } from 'constants'
import { FamilyRelation, FamilyRelationPage, HDMUser, OrderItem, OrderPage, OrderState } from 'models'
import { HDMNavBar } from 'ui_components'
import {
  getFamilyRelationsPageAPI,
  inviteRelationAPI,
  updateRelationAPI,
  getFamilyOrdersPageAPI,
  getMerchantOrdersPageAPI,
  receiveOrderAPI,
  familyPayAPI,
  shipOrderAPI
} from '../../data/api'

@Builder
function FamilyViewBuilder() {
  FamilyView()
}

@Component
export struct FamilyView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('reloadForCurrentAccount')
  user: HDMUser = { account: '', nickname: '', token: '', avatar: '' }
  @StorageProp(GlobalVariable.APP_FOREGROUND_SEQUENCE) @Watch('refreshAfterForeground') foregroundSequence: number = 0
  @State familyRelations: FamilyRelation[] = []
  @State relationPage: number = 1
  @State relationPages: number = 0
  @State familyOrders: OrderItem[] = []
  @State ordersToShip: OrderItem[] = []
  @State familyPage: number = 1
  @State familyPages: number = 0
  @State merchantPage: number = 1
  @State merchantPages: number = 0
  @State friendAccount: string = ''
  @State loading: boolean = false
  @State isSubmitting: boolean = false
  @State errorText: string = ''
  private loadRequestId: number = 0
  private isPageActive: boolean = true
  private pageGeneration: number = 0
  private sessionToken: string = ''
  private sessionRole: string = ''
  @State loadedToken: string = ''
  private dialogSequence: number = 0

  aboutToAppear(): void {
    this.isPageActive = true
    this.loadFamilyCenter()
  }
  aboutToDisappear(): void {
    this.isPageActive = false
    // 离开页面后，让正在等待的查询失效。
    this.loadRequestId++
    this.pageGeneration++
    this.dialogSequence++
    this.loading = false
    this.isSubmitting = false
  }
  private showFamilyCenter(): void {
    if (!this.isPageActive) this.aboutToAppear()
  }
  private refreshAfterForeground(): void {
    if (this.isPageActive && !this.isSubmitting) this.loadFamilyCenter()
  }
  private reloadForCurrentAccount(): void {
    if (!this.synchronizeFamilySession()) return
    if (this.isPageActive) this.loadFamilyCenter()
  }
  private synchronizeFamilySession(): boolean {
    const token: string = this.user.token || ''
    const role: string = this.user.role || ''
    if (token === this.sessionToken && role === this.sessionRole) return false
    this.sessionToken = token
    this.sessionRole = role
    this.loadedToken = ''
    this.pageGeneration++
    this.dialogSequence++
    this.loadRequestId++
    this.familyRelations = []
    this.relationPage = 1
    this.relationPages = 0
    this.familyOrders = []
    this.ordersToShip = []
    this.familyPage = 1
    this.familyPages = 0
    this.merchantPage = 1
    this.merchantPages = 0
    this.loading = false
    this.isSubmitting = false
    this.friendAccount = ''
    this.errorText = ''
    return true
  }
  private async loadFamilyCenter(familyPage: number = this.familyPage, merchantPage: number = this.merchantPage,
    relationPage: number = this.relationPage): Promise<void> {
    if (this.synchronizeFamilySession()) {
      familyPage = 1
      merchantPage = 1
      relationPage = 1
    }
    const currentRequestId = ++this.loadRequestId
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const merchant: boolean = this.sessionRole === 'merchant'
    if (!this.isCurrentFamilySession(generation, token)) {
      this.loading = false
      return
    }
    this.loading = true
    this.errorText = ''
    try {
      let relationResult: FamilyRelationPage = await getFamilyRelationsPageAPI(relationPage, token)
      if (!this.isCurrentQuery(currentRequestId, generation, token)) { return }
      if (relationResult.page > Math.max(1, relationResult.pages)) {
        relationResult = await getFamilyRelationsPageAPI(Math.max(1, relationResult.pages), token)
      }
      if (!this.isCurrentQuery(currentRequestId, generation, token)) {
        return
      }
      let familyResult: OrderPage = await getFamilyOrdersPageAPI(familyPage, token)
      if (!this.isCurrentQuery(currentRequestId, generation, token)) {
        return
      }
      // 操作或其他人的更新使末页消失时，回到当前最后一页。
      if (familyResult.page > Math.max(1, familyResult.pages)) {
        familyResult = await getFamilyOrdersPageAPI(Math.max(1, familyResult.pages), token)
      }
      if (!this.isCurrentQuery(currentRequestId, generation, token)) {
        return
      }
      let merchantResult: OrderPage = { items: [], counts: 0, page: 1, pageSize: 10, pages: 0 }
      if (merchant) {
        merchantResult = await getMerchantOrdersPageAPI(merchantPage, token)
        if (!this.isCurrentQuery(currentRequestId, generation, token)) {
          return
        }
        if (merchantResult.page > Math.max(1, merchantResult.pages)) {
          merchantResult = await getMerchantOrdersPageAPI(Math.max(1, merchantResult.pages), token)
        }
      }
      // 只允许当前页面的最新查询更新列表。
      if (!this.isCurrentQuery(currentRequestId, generation, token)) {
        return
      }
      this.familyRelations = relationResult.items
      this.relationPage = relationResult.page
      this.relationPages = relationResult.pages
      this.familyOrders = familyResult.items
      this.familyPage = familyResult.page
      this.familyPages = familyResult.pages
      this.ordersToShip = merchantResult.items
      this.merchantPage = merchantResult.page
      this.merchantPages = merchantResult.pages
      this.loadedToken = token
    } catch {
      if (this.isCurrentQuery(currentRequestId, generation, token)) {
        this.errorText = '加载失败，请重新登录或重试'
      }
    } finally {
      if (this.isCurrentQuery(currentRequestId, generation, token)) {
        this.loading = false
      }
    }
  }
  private isCurrentFamilySession(generation: number, token: string): boolean {
    return this.isPageActive && generation === this.pageGeneration && token.length > 0 &&
      token === this.sessionToken && token === (this.user.token || '') && this.sessionRole === (this.user.role || '')
  }
  private isCurrentQuery(requestId: number, generation: number, token: string): boolean {
    return requestId === this.loadRequestId && this.isCurrentFamilySession(generation, token)
  }
  private canManageFamily(): boolean {
    return this.isCurrentFamilySession(this.pageGeneration, this.sessionToken) && this.loadedToken === this.sessionToken &&
      !this.loading && !this.isSubmitting && !this.errorText
  }
  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {}
  }

  // 先提交操作，再提示成功并重新查询；等待期间换账号就不再更新旧页面。
  private async submitThenRefresh(submitAction: (token: string) => Promise<void>, successMessage: string): Promise<void> {
    if (!this.canManageFamily()) {
      return
    }
    this.isSubmitting = true
    const submittingToken: string = this.sessionToken
    const generation: number = this.pageGeneration
    try {
      await submitAction(submittingToken)
      if (!this.isCurrentFamilySession(generation, submittingToken)) {
        return
      }
      this.safeToast(successMessage)
      await this.loadFamilyCenter()
    } catch {
      if (this.isCurrentFamilySession(generation, submittingToken)) {
        this.loadRequestId++
        this.loading = false
        this.errorText = '操作结果未确认，请刷新查看最新状态后重试'
      }
    } finally {
      if (this.isCurrentFamilySession(generation, submittingToken)) this.isSubmitting = false
    }
  }
  private sendFamilyInvitation(): void {
    const account: string = this.friendAccount.trim()
    if (account.length < 3 || account.length > 32) return
    this.submitThenRefresh(async (token: string): Promise<void> => {
      await inviteRelationAPI(account, token)
    }, '绑定邀请已发送')
  }
  private acceptFamilyInvitation(relationId: string): void {
    const relation: FamilyRelation | undefined = this.familyRelations.find((item: FamilyRelation) => item.id === relationId)
    if (!relation || relation.status !== 'pending' || relation.friendAccount !== this.user.account) return
    this.submitThenRefresh(async (token: string): Promise<void> => {
      await updateRelationAPI(relationId, 'accept', token)
    }, '已确认绑定')
  }

  private removeFamilyRelation(relationId: string): void {
    const relation: FamilyRelation | undefined = this.familyRelations.find((item: FamilyRelation) => item.id === relationId)
    if (!relation || (relation.ownerAccount !== this.user.account && relation.friendAccount !== this.user.account)) return
    this.submitThenRefresh(async (token: string): Promise<void> => {
      await updateRelationAPI(relationId, 'revoke', token)
    }, '已解除绑定')
  }

  private shipOrder(order: OrderItem): void {
    const current: OrderItem | undefined = this.ordersToShip.find((item: OrderItem) => item.id === order.id)
    if (this.user.role !== 'merchant' || !current || current.orderState !== OrderState.AWAITING_SHIPMENT) return
    const orderId: string = current.id
    this.submitThenRefresh(async (token: string): Promise<void> => {
      await shipOrderAPI(orderId, token)
    }, '已发货')
  }
  private confirmFamilyReceipt(order: OrderItem): void {
    const current: OrderItem | undefined = this.familyOrders.find((item: OrderItem) => item.id === order.id)
    if (!this.canManageFamily() || !current?.canReceive || current.orderState !== OrderState.AWAITING_RECEIPT) return
    const orderId: string = current.id
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const requestId: number = this.loadRequestId
    const dialog: number = ++this.dialogSequence
    this.getUIContext().showAlertDialog({
      title: '确认已经收到商品？',
      message: '确认后订单将完成收货，并记录你为实际确认人。',
      primaryButton: { value: '还没收到', action: () => {} },
      secondaryButton: { value: '已收到，确认', action: () => {
        if (dialog !== this.dialogSequence || !this.isCurrentQuery(requestId, generation, token)) return
        const latest: OrderItem | undefined = this.familyOrders.find((item: OrderItem) => item.id === orderId)
        if (!latest?.canReceive || latest.orderState !== OrderState.AWAITING_RECEIPT || !this.canManageFamily()) return
        this.dialogSequence++
        this.submitThenRefresh(async (session: string): Promise<void> => {
          await receiveOrderAPI(orderId, session)
        }, '已确认代收')
      } }
    })
  }
  private confirmFamilyPayment(order: OrderItem): void {
    const current: OrderItem | undefined = this.familyOrders.find((item: OrderItem) => item.id === order.id)
    if (!this.canManageFamily() || !current?.canPay || current.orderState !== OrderState.AWAITING_PAYMENT) return
    const orderId: string = current.id
    const amount: number = current.payMoney
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const requestId: number = this.loadRequestId
    const dialog: number = ++this.dialogSequence
    this.getUIContext().showAlertDialog({
      title: '为 ' + current.ownerAccount + ' 模拟代付',
      message: '金额 ¥' + amount.toFixed(2) + '。这是测试支付，不会实际扣款。',
      primaryButton: { value: '取消', action: () => {} },
      secondaryButton: { value: '确认模拟代付', action: () => {
        if (dialog !== this.dialogSequence || !this.isCurrentQuery(requestId, generation, token)) return
        const latest: OrderItem | undefined = this.familyOrders.find((item: OrderItem) => item.id === orderId)
        if (!latest?.canPay || latest.orderState !== OrderState.AWAITING_PAYMENT || latest.payMoney !== amount ||
          !this.canManageFamily()) return
        this.dialogSequence++
        this.submitThenRefresh(async (session: string): Promise<void> => {
          await familyPayAPI(orderId, amount, session)
        }, '代付成功')
      } }
    })
  }
  private getFamilyOrderStatus(orderState: number): string {
    switch (orderState) {
      case OrderState.AWAITING_PAYMENT:
        return '等待代付'
      case OrderState.AWAITING_SHIPMENT:
        return '待发货'
      case OrderState.AWAITING_RECEIPT:
        return '待收货'
      default:
        return '已收货'
    }
  }

  @Builder
  private OrderSummary(order: OrderItem) {
    Text('下单人：' + order.ownerAccount).fontSize(16).fontColor('#1F2329')
    Text(order.skus.map((goods) => goods.name).join('、')).fontSize(14).maxLines(2).fontColor('#1F2329')
    Text('¥' + order.payMoney.toFixed(2)).fontSize(18).fontColor('#B34D36')
    Text(this.getFamilyOrderStatus(order.orderState)).fontSize(12).fontColor('#1F2329')
    if (order.receivedByAccount) {
      Text('收货确认人：' + order.receivedByAccount).fontSize(12).fontColor('#1F2329')
    }
  }

  @Styles
  orderCardStyle() {
    .width('100%')
    .padding(16)
    .backgroundColor(Color.White)
    .borderRadius(12)
  }

  @Builder
  private FamilyOrderCard(order: OrderItem) {
    Column({ space: 8 }) {
      this.OrderSummary(order)
      // 服务端决定当前亲友能否代付、代收，页面只按权限展示按钮。
      if (order.canPay) {
        Button('确认模拟代付')
          .enabled(this.canManageFamily())
          .onClick(() => this.confirmFamilyPayment(order))
      }
      if (order.canReceive) {
        Button('确认代收')
          .enabled(this.canManageFamily())
          .onClick(() => this.confirmFamilyReceipt(order))
      }
    }
    .orderCardStyle()
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  private MerchantOrderCard(order: OrderItem) {
    Column({ space: 8 }) {
      this.OrderSummary(order)
      if (order.address) {
        Text(order.address.receiver + ' · ' + order.address.contact).fontSize(14).fontColor('#1F2329')
        Text(order.address.fullLocation + ' ' + order.address.address).fontSize(14).fontColor('#1F2329')
      }
      Button('确认发货')
        .enabled(this.canManageFamily())
        .onClick(() => this.shipOrder(order))
    }
    .orderCardStyle()
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({ title: '亲友中心', onLeftClick: () => this.stackPath.pop() })
        Scroll() {
          Column({ space: 12 }) {
            Text('添加代付与代收亲友').fontSize(20).fontWeight(FontWeight.Bold).fontColor('#1F2329')
            Text('对方确认后，可以受邀代付；你的亲友代付订单发货后，所有已绑定代收亲友均可确认收货。本人付款订单不支持代收。')
              .fontSize(13).fontColor('#666666')
            TextInput({ placeholder: '输入亲友的商城账号', text: $$this.friendAccount }).maxLength(32)
              .fontColor('#1F2329').placeholderColor('#666666').backgroundColor(Color.White)
            Button('发送绑定邀请').enabled(this.canManageFamily() && this.friendAccount.trim().length >= 3).onClick(() => this.sendFamilyInvitation())
            Button(this.loading ? '加载中...' : '刷新').enabled(!this.loading && !this.isSubmitting).onClick(() => this.loadFamilyCenter())
            if (this.errorText) { Text(this.errorText).fontColor('#B34D36') }
            Row({ space: 8 }) {
              Button('关系上一页').enabled(this.relationPage > 1 && !this.loading && !this.isSubmitting)
                .onClick(() => this.loadFamilyCenter(this.familyPage, this.merchantPage, this.relationPage - 1))
              Text(this.relationPage + ' / ' + Math.max(1, this.relationPages)).fontColor('#1F2329')
              Button('关系下一页').enabled(this.relationPage < this.relationPages && !this.loading && !this.isSubmitting)
                .onClick(() => this.loadFamilyCenter(this.familyPage, this.merchantPage, this.relationPage + 1))
            }
            if (!this.loading && this.familyRelations.length === 0) { Text('暂无亲友关系').fontColor('#1F2329') }
            ForEach(this.familyRelations, (relation: FamilyRelation) => {
              Column({ space: 8 }) {
                Text(relation.ownerAccount === this.user.account ? '我的亲友：' + relation.friendAccount : relation.ownerAccount + ' 邀请我作为代付与代收亲友')
                  .fontColor('#1F2329')
                Text(relation.status === 'accepted' ? '已绑定' : '待确认').fontSize(12).fontColor('#1F2329')
                if (relation.status === 'pending' && relation.friendAccount === this.user.account) {
                  Button('同意绑定').enabled(this.canManageFamily()).onClick(() => this.acceptFamilyInvitation(relation.id))
                }
                Button(relation.status === 'pending' ? '取消 / 拒绝邀请' : '解除绑定').enabled(this.canManageFamily())
                  .onClick(() => this.removeFamilyRelation(relation.id))
              }.width('100%').padding(16).backgroundColor(Color.White).borderRadius(12)
            // 普通接口对象刷新后重建变化行，避免保留旧状态与旧操作按钮。
            }, (relation: FamilyRelation) => JSON.stringify(relation))
            Text('亲友订单').fontSize(18).fontWeight(FontWeight.Bold).fontColor('#1F2329')
            Row({ space: 8 }) {
              Button('亲友上一页').enabled(this.familyPage > 1 && !this.loading && !this.isSubmitting)
                .onClick(() => this.loadFamilyCenter(this.familyPage - 1, this.merchantPage))
              Text(this.familyPage + ' / ' + Math.max(1, this.familyPages)).fontColor('#1F2329')
              Button('亲友下一页').enabled(this.familyPage < this.familyPages && !this.loading && !this.isSubmitting)
                .onClick(() => this.loadFamilyCenter(this.familyPage + 1, this.merchantPage))
            }
            if (!this.loading && this.familyOrders.length === 0) { Text('暂无需要代付或代收的订单').fontSize(14).fontColor('#1F2329') }
            ForEach(this.familyOrders, (order: OrderItem) => { this.FamilyOrderCard(order) }, (order: OrderItem) => JSON.stringify(order))
            if (this.user.role === 'merchant') {
              Text('商家待发货订单').fontSize(18).fontWeight(FontWeight.Bold).fontColor('#1F2329')
              Row({ space: 8 }) {
                Button('发货上一页').enabled(this.merchantPage > 1 && !this.loading && !this.isSubmitting)
                  .onClick(() => this.loadFamilyCenter(this.familyPage, this.merchantPage - 1))
                Text(this.merchantPage + ' / ' + Math.max(1, this.merchantPages)).fontColor('#1F2329')
                Button('发货下一页').enabled(this.merchantPage < this.merchantPages && !this.loading && !this.isSubmitting)
                  .onClick(() => this.loadFamilyCenter(this.familyPage, this.merchantPage + 1))
              }
              ForEach(this.ordersToShip, (order: OrderItem) => { this.MerchantOrderCard(order) }, (order: OrderItem) => JSON.stringify(order))
            }
          }.width('100%').padding(16).alignItems(HorizontalAlign.Start)
        }.layoutWeight(1).width('100%')
      }.width('100%').height('100%').padding({ top: this.safeTop }).backgroundColor('#F6F5F3')
    }.hideTitleBar(true)
    .onShown(() => this.showFamilyCenter())
    .onHidden(() => this.aboutToDisappear())
  }
}
