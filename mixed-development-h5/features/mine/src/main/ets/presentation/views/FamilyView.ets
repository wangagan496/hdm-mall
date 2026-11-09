import { cancelActions, cancelActionFailure, RecoveryQuery } from 'storage'
import { GlobalVariable, PAGE_PATH } from 'constants'
import { CancelActionIntent, FamilyRelation, FamilyRelationPage, FamilyGroupCounts, HDMUser, OrderItem, OrderPage, OrderState, OrderRefund, formatBeijingTime } from 'models'
import { HDMNavBar } from 'ui_components'
import {
  getFamilyRelationsPageAPI,
  inviteRelationAPI,
  updateRelationAPI,
  getFamilyOrdersPageAPI,
  getFamilyOrderDetailAPI,
  getMerchantOrdersPageAPI,
  receiveOrderAPI,
  startFamilyPaymentAPI,
  shipOrderAPI
} from '../../data/api'

interface FamilyFilterItem {
  key: string
  label: string
}

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
  @State pendingCancelActions: string[] = []
  @State showCancelResolution: boolean = false
  @State resolvingOrder: OrderItem | null = null
  @State rejectReason: string = ''
  private resolutionGeneration: number = 0
  private resolutionQuery: number = 0
  private resolutionToken: string = ''
  private loadRequestId: number = 0
  @State isPageActive: boolean = true
  @State pageGeneration: number = 0
  @State sessionToken: string = ''
  @State sessionRole: string = ''
  @State loadedToken: string = ''
  private dialogSequence: number = 0
  @State relationsExpanded: boolean = false
  @State familyGroup: string = 'all'
  @State familyGroupInitialized: boolean = false
  @State familyGroupCounts: FamilyGroupCounts | null = null
  @State pendingFamilyOrders: string[] = []
  @State checkingFamilyOrders: string[] = []
  private familyChecks: Map<string, RecoveryQuery> = new Map<string, RecoveryQuery>()
  private familyQueries: Set<string> = new Set<string>()

  private visibleFamilyOrders(): OrderItem[] {
    return this.familyOrders.filter((order: OrderItem) => this.familyGroup === 'all' ||
      (this.familyGroup === 'pay' && order.canPay === true) ||
      (this.familyGroup === 'receipt' && order.canReceive === true) ||
      (this.familyGroup === 'pending' && (this.pendingFamilyOrders.includes(order.id) ||
        order.paymentState === 'confirming' || order.paymentState === 'review' || order.needsAttention === true)))
  }

  private familyGroupCount(group: string): number {
    if (this.familyGroupCounts) {
      if (group === 'pay') return this.familyGroupCounts.pay
      if (group === 'receipt') return this.familyGroupCounts.receipt
      if (group === 'pending') return this.familyGroupCounts.pending + this.familyOrders.filter((order: OrderItem) =>
        this.pendingFamilyOrders.includes(order.id) && order.paymentState !== 'confirming' &&
        order.paymentState !== 'review' && order.needsAttention !== true).length
      return this.familyGroupCounts.all
    }
    if (group === 'all') return this.familyOrders.length
    if (group === 'pay') return this.familyOrders.filter((order: OrderItem) => order.canPay === true).length
    if (group === 'receipt') return this.familyOrders.filter((order: OrderItem) => order.canReceive === true).length
    return this.familyOrders.filter((order: OrderItem) => this.pendingFamilyOrders.includes(order.id) ||
      order.paymentState === 'confirming' || order.paymentState === 'review' || order.needsAttention === true).length
  }

  private familyGroupLabel(group: string, label: string): string {
    return label + ' ' + this.familyGroupCount(group)
  }

  private selectFamilyGroup(group: string): void {
    if (this.loading || this.isSubmitting) return
    this.familyGroup = group
    this.familyGroupInitialized = true
    this.familyPage = 1
    this.loadFamilyCenter(1)
  }

  private updateFamilyOrder(order: OrderItem): void {
    const previous: OrderItem | undefined = this.familyOrders.find(item => item.id === order.id)
    if (previous && this.familyGroupCounts) {
      const beforePending: boolean = previous.paymentState === 'confirming' || previous.paymentState === 'review' || previous.needsAttention === true
      const afterPending: boolean = order.paymentState === 'confirming' || order.paymentState === 'review' || order.needsAttention === true
      this.familyGroupCounts = {
        pay: Math.max(0, this.familyGroupCounts.pay + (order.canPay ? 1 : 0) - (previous.canPay ? 1 : 0)),
        receipt: Math.max(0, this.familyGroupCounts.receipt + (order.canReceive ? 1 : 0) - (previous.canReceive ? 1 : 0)),
        pending: Math.max(0, this.familyGroupCounts.pending + (afterPending ? 1 : 0) - (beforePending ? 1 : 0)),
        all: this.familyGroupCounts.all
      }
      this.familyPages = Math.ceil(this.familyGroupCount(this.familyGroup) / 10)
    }
    this.familyOrders = this.familyOrders.map(item => item.id === order.id ? order : item)
  }

  private familyEmptyText(): string {
    if (this.familyGroup === 'pay') return '暂时没有需要你付款的订单'
    if (this.familyGroup === 'receipt') return '暂时没有需要你收货的订单'
    if (this.familyGroup === 'pending') return '暂时没有需要核对的订单'
    return '暂时没有亲友订单'
  }

  private stopFamilyChecks(): void {
    this.familyChecks.forEach((job: RecoveryQuery) => job.cancel())
    this.familyChecks.clear()
    this.familyQueries.clear()
    this.checkingFamilyOrders = []
  }

  private scheduleFamilyCheck(id: string): void {
    if (!this.isCurrentFamilySession(this.pageGeneration, this.sessionToken)) return
    if (!this.pendingFamilyOrders.includes(id)) this.pendingFamilyOrders = [...this.pendingFamilyOrders, id]
    if (this.familyChecks.has(id)) return
    const job: RecoveryQuery = new RecoveryQuery()
    this.familyChecks.set(id, job)
    this.checkingFamilyOrders = [...this.checkingFamilyOrders, id]
    job.start(() => this.checkFamilyOrder(id), () => {
      if (this.familyChecks.get(id) !== job) return
      this.checkingFamilyOrders = this.checkingFamilyOrders.filter(value => value !== id)
      if (!this.pendingFamilyOrders.includes(id)) this.familyChecks.delete(id)
    })
  }

  private async checkFamilyOrder(id: string): Promise<boolean> {
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    if (!this.isCurrentFamilySession(generation, token)) return true
    if (this.familyQueries.has(id) || this.isSubmitting || this.loading) return false
    this.familyQueries.add(id)
    const query: number = this.loadRequestId
    try {
      const order: OrderItem = await getFamilyOrderDetailAPI(id, token)
      if (!this.isCurrentQuery(query, generation, token)) return false
      if (order.id !== id) return false
      this.updateFamilyOrder(order)
      if (order.paymentState === 'confirming' || order.paymentState === 'review') return false
      this.pendingFamilyOrders = this.pendingFamilyOrders.filter(value => value !== id)
      if (this.familyGroupCounts && this.familyPage > Math.max(1, this.familyPages)) await this.loadFamilyCenter(Math.max(1, this.familyPages))
      return true
    } finally { if (this.isCurrentFamilySession(generation, token)) this.familyQueries.delete(id) }
  }

  private retryFamilyCheck(id: string): void {
    this.familyChecks.get(id)?.cancel()
    this.familyChecks.delete(id)
    this.scheduleFamilyCheck(id)
  }

  aboutToAppear(): void {
    this.isPageActive = true
    this.loadFamilyCenter()
  }
  aboutToDisappear(): void {
    this.stopFamilyChecks()
    this.isPageActive = false
    this.closeCancelResolution()
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
    if (!this.isPageActive || this.isSubmitting) return
    if (this.pendingFamilyOrders.length) {
      for (const id of this.pendingFamilyOrders) void this.checkFamilyOrder(id).catch(() => {})
    } else this.loadFamilyCenter()
  }
  private reloadForCurrentAccount(): void {
    if (!this.synchronizeFamilySession()) return
    if (this.isPageActive) this.loadFamilyCenter()
  }
  private synchronizeFamilySession(): boolean {
    const token: string = this.user.token || ''
    const role: string = this.user.role || ''
    if (token === this.sessionToken && role === this.sessionRole) return false
    this.stopFamilyChecks()
    this.pendingFamilyOrders = []
    this.relationsExpanded = false
    this.familyGroup = 'all'
    this.familyGroupInitialized = false
    this.familyGroupCounts = null
    this.sessionToken = token
    this.sessionRole = role
    this.loadedToken = ''
    this.pendingCancelActions = []
    this.closeCancelResolution()
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
      let group: string = this.familyGroup === 'merchant' ? 'all' : this.familyGroup
      let familyResult: OrderPage = await getFamilyOrdersPageAPI(familyPage, token, group)
      if (!this.isCurrentQuery(currentRequestId, generation, token)) {
        return
      }
      if (!this.familyGroupInitialized && familyResult.groupCounts) {
        const counts: FamilyGroupCounts = familyResult.groupCounts
        const initial: string = counts.pay > 0 ? 'pay' : counts.receipt > 0 ? 'receipt' : counts.pending > 0 ? 'pending' : 'all'
        if (initial !== group) {
          group = initial
          familyResult = await getFamilyOrdersPageAPI(1, token, group)
          if (!this.isCurrentQuery(currentRequestId, generation, token)) return
        }
      }
      // 操作或其他人的更新使末页消失时，回到当前最后一页。
      if (familyResult.page > Math.max(1, familyResult.pages)) {
        familyResult = await getFamilyOrdersPageAPI(Math.max(1, familyResult.pages), token, group)
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
      this.familyGroupCounts = familyResult.groupCounts || null
      this.familyPage = familyResult.page
      this.familyPages = familyResult.pages
      if (!this.familyGroupInitialized) {
        this.familyGroup = familyResult.groupCounts ? group : (this.familyGroupCount('pay') > 0 ? 'pay' : this.familyGroupCount('receipt') > 0 ? 'receipt' :
          this.familyGroupCount('pending') > 0 ? 'pending' : 'all')
        this.familyGroupInitialized = true
      }
      this.ordersToShip = merchantResult.items
      this.merchantPage = merchantResult.page
      this.merchantPages = merchantResult.pages
      this.loadedToken = token
      this.pendingCancelActions = cancelActions.pending().filter(record => record.action === 'approve' || record.action === 'reject-and-ship').map(record => record.orderId)
    } catch {
      if (this.isCurrentQuery(currentRequestId, generation, token)) {
        this.errorText = '加载失败，请重新登录或重试'
      }
    } finally {
      if (this.isCurrentQuery(currentRequestId, generation, token)) {
        this.loading = false
        for (const order of this.familyOrders) {
          if (this.pendingFamilyOrders.includes(order.id) || order.paymentState === 'confirming' || order.paymentState === 'review') this.scheduleFamilyCheck(order.id)
        }
      }
    }
    if (this.isCurrentQuery(currentRequestId, generation, token) && !this.isSubmitting && !this.errorText) this.recoverCancelActions()
  }
  private async recoverCancelActions(): Promise<void> {
    if (!this.canManageFamily() || this.sessionRole !== 'merchant') return
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    for (const orderId of this.pendingCancelActions.slice()) {
      if (!this.isCurrentFamilySession(generation, token) || this.isSubmitting) return
      await this.resolveCancellation(orderId, 'approve', true)
    }
  }

  private closeCancelResolution(): void {
    this.showCancelResolution = false
    this.resolvingOrder = null
    this.rejectReason = ''
    this.dialogSequence++
  }

  private openCancelResolution(order: OrderItem): void {
    const current = this.ordersToShip.find((item: OrderItem) => item.id === order.id)
    if (!this.canManageFamily() || !current?.canResolveCancel || !current.cancelRequest || this.pendingCancelActions.includes(order.id)) return
    this.resolvingOrder = current
    this.rejectReason = ''
    this.resolutionGeneration = this.pageGeneration
    this.resolutionQuery = this.loadRequestId
    this.resolutionToken = this.sessionToken
    this.showCancelResolution = true
  }

  private currentResolution(): OrderItem | undefined {
    if (!this.resolvingOrder || !this.canManageFamily() ||
      !this.isCurrentQuery(this.resolutionQuery, this.resolutionGeneration, this.resolutionToken)) return undefined
    const current = this.ordersToShip.find((item: OrderItem) => item.id === this.resolvingOrder?.id)
    if (!current?.canResolveCancel || current.cancelRequest?.id !== this.resolvingOrder.cancelRequest?.id ||
      this.pendingCancelActions.includes(current.id)) return undefined
    return current
  }

  private approveCancellation(): void {
    const current = this.currentResolution()
    if (!current) { this.closeCancelResolution(); return }
    const dialog: number = ++this.dialogSequence
    const orderId: string = current.id
    const destination: string = current.paymentMode === 'family' ? '亲友 ' + current.payerAccount + ' 的付款账户' : '付款账户'
    this.getUIContext().showAlertDialog({ title: '同意取消订单',
      message: '同意后不再发货，¥' + current.payMoney.toFixed(2) + '将原路退回' + destination + '。确定同意取消吗？',
      primaryButton: { value: '再等等', action: () => { this.dialogSequence++ } },
      secondaryButton: { value: '同意取消', action: () => {
        if (dialog !== this.dialogSequence || this.currentResolution()?.id !== orderId) return
        this.dialogSequence++
        this.resolveCancellation(orderId, 'approve')
      } }
    })
  }

  private async rejectCancellation(): Promise<void> {
    const current = this.currentResolution()
    if (!current) { this.closeCancelResolution(); return }
    const reason: string = this.rejectReason.trim()
    if (!reason) { this.safeToast('请填写拒绝原因'); return }
    if (reason.length > 200) { this.safeToast('拒绝原因最多填写200字'); return }
    await this.resolveCancellation(current.id, 'reject-and-ship', false, reason)
  }

  private async resolveCancellation(orderId: string, action: 'approve' | 'reject-and-ship', resume: boolean = false, reason: string = ''): Promise<void> {
    if (!this.canManageFamily() || this.sessionRole !== 'merchant') return
    const current = resume ? undefined : this.currentResolution()
    if (!resume && (!current || current.id !== orderId)) return
    const generation: number = this.pageGeneration
    const query: number = this.loadRequestId
    const token: string = this.sessionToken
    const cancelRequestId: string = current?.cancelRequest?.id || ''
    this.closeCancelResolution()
    this.isSubmitting = true
    try {
      if (resume) await cancelActions.recover(orderId, token)
      else {
        const intent: CancelActionIntent = { orderId, cancelRequestId, action, reason }
        await cancelActions.confirm(intent, token)
      }
      if (this.isCurrentQuery(query, generation, token)) this.safeToast('取消操作已确认')
    } catch (error) {
      if (this.isCurrentQuery(query, generation, token)) this.safeToast((error as Error).message)
    } finally {
      if (this.isCurrentFamilySession(generation, token)) {
        this.pendingCancelActions = cancelActions.pending().filter(record => record.action === 'approve' || record.action === 'reject-and-ship').map(record => record.orderId)
        if (query === this.loadRequestId) await this.loadFamilyCenter()
        if (this.isCurrentFamilySession(generation, token)) this.isSubmitting = false
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
  private async submitThenRefresh(submitAction: (token: string) => Promise<void>, successMessage: string, orderId: string = ''): Promise<void> {
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
      if (orderId) this.scheduleFamilyCheck(orderId)
      else await this.loadFamilyCenter()
    } catch (error) {
      if (this.isCurrentFamilySession(generation, submittingToken)) {
        const failure = cancelActionFailure(error as Error)
        if (orderId) {
          if (!failure.status || failure.status === 408 || failure.status === 429 || failure.status >= 500) this.scheduleFamilyCheck(orderId)
          else this.safeToast(failure.message || '操作未完成，请重新查询订单')
          return
        }
        if (['CANCEL_REQUEST_BLOCKS_SHIPMENT', 'CANCELLED_ORDER_BLOCKS_SHIPMENT', 'CANCEL_REQUEST_EXPIRED',
          'CANCEL_REQUEST_WITHDRAWN', 'CANCEL_REQUEST_RESOLVED'].includes(failure.reason)) {
          this.safeToast(failure.message)
          await this.loadFamilyCenter()
          return
        }
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
    if (this.user.role !== 'merchant' || !current?.canShip || this.pendingCancelActions.includes(order.id) || current.orderState !== OrderState.AWAITING_SHIPMENT) return
    const orderId: string = current.id
    this.submitThenRefresh(async (token: string): Promise<void> => {
      await shipOrderAPI(orderId, token)
    }, '已发货')
  }
  private confirmFamilyReceipt(order: OrderItem): void {
    const current: OrderItem | undefined = this.familyOrders.find((item: OrderItem) => item.id === order.id)
    if (!this.canManageFamily() || this.pendingFamilyOrders.includes(order.id) || !current?.canReceive || current.orderState !== OrderState.AWAITING_RECEIPT) return
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
        }, '已确认代收', orderId)
      } }
    })
  }
  private confirmFamilyPayment(order: OrderItem): void {
    const current: OrderItem | undefined = this.familyOrders.find((item: OrderItem) => item.id === order.id)
    if (!this.canManageFamily() || this.pendingFamilyOrders.includes(order.id) || !current?.canPay || current.orderState !== OrderState.AWAITING_PAYMENT ||
      current.paymentState === 'confirming' || current.paymentState === 'review') return
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
          latest.paymentState === 'confirming' || latest.paymentState === 'review' ||
          !this.canManageFamily()) return
        this.dialogSequence++
        this.submitFamilyPayment(orderId, amount)
      } }
    })
  }
  private async submitFamilyPayment(orderId: string, amount: number): Promise<void> {
    if (!this.canManageFamily() || this.pendingFamilyOrders.includes(orderId)) return
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    this.isSubmitting = true
    try {
      const result = await startFamilyPaymentAPI(orderId, amount, token)
      if (!this.isCurrentFamilySession(generation, token)) return
      this.safeToast(result.state === 'succeeded' ? '代付成功' : '正在确认付款结果，请勿重复付款')
    } catch {
      if (!this.isCurrentFamilySession(generation, token)) return
      this.safeToast('正在确认付款结果，请勿重复付款')
    } finally {
      if (this.isCurrentFamilySession(generation, token)) {
        this.isSubmitting = false
        this.scheduleFamilyCheck(orderId)
      }
    }
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

  private refundDisplayLine(refund: OrderRefund): string {
    const paidAt: string = refund.paidAt === null ? '付款时间待确认' : formatBeijingTime(refund.paidAt)
    return '¥' + refund.amount.toFixed(2) + ' · ' + refund.payerAccount + ' · ' + paidAt + ' · ' + refund.state
  }

  private familyOrderStatus(order: OrderItem): string {
    if (order.cancelRequest?.state === 'pending') return '取消申请审核中'
    if (order.orderState === OrderState.CANCELLED) {
      const states: string[] = []
      order.refunds?.forEach((refund: OrderRefund) => {
        if (!states.includes(refund.state)) states.push(refund.state)
      })
      return '已取消' + (states.length > 0 ? ' · ' + states.join(' · ') : '')
    }
    return order.paymentState === 'review' ? '核实中' : order.paymentState === 'confirming' ? '确认中' :
      this.getFamilyOrderStatus(order.orderState)
  }

  private hasFamilyOrderActions(order: OrderItem): boolean {
    return order.orderState !== OrderState.CANCELLED
  }

  private openFamilyOrder(order: OrderItem): void {
    if (!this.canManageFamily() || !this.familyOrders.some((item: OrderItem) => item.id === order.id)) return
    this.stackPath.pushPath({ name: PAGE_PATH.ORDER_DETAIL_PAGE, param: order.id,
      onPop: () => this.showFamilyCenter() })
  }

  @Builder
  private CancelResolutionSheet() {
    Column({ space: 12 }) {
      Text('处理取消申请').fontSize(20)
      Button('同意取消').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(!this.isSubmitting && !this.loading)
        .onClick(() => this.approveCancellation())
      Text('拒绝并发货：提交后订单将进入待收货').fontSize(14)
      TextArea({ placeholder: '请填写拒绝原因（最多200字）', text: $$this.rejectReason })
        .height(100).enabled(!this.isSubmitting && !this.loading)
      Button('拒绝并发货').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(!this.isSubmitting && !this.loading)
        .onClick(() => this.rejectCancellation())
      Button('关闭').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(!this.isSubmitting).onClick(() => this.closeCancelResolution())
    }.padding(20).width('100%')
  }

  @Builder
  private OrderSummary(order: OrderItem) {
    if (order.ownerAccount) {
      Text('下单人：' + order.ownerAccount).fontSize(16).fontColor($r('[ui_components].color.text'))
    }
    Text(order.skus.map((goods) => goods.name).join('、')).fontSize(14).maxLines(2).fontColor($r('[ui_components].color.text'))
    if (order.payMoney !== undefined) {
      Text('¥' + order.payMoney.toFixed(2)).fontSize(18).fontColor($r('[ui_components].color.red'))
    }
    Text(this.familyOrderStatus(order)).fontSize(12).fontColor($r('[ui_components].color.text'))
    if (order.needsAttention) {
      Text('●').fontSize(10).fontColor($r('[ui_components].color.red'))
    }
    if (order.cancelRequestNotice) {
      Text(order.cancelRequestNotice).fontSize(12).fontColor($r('[ui_components].color.gray'))
    }
    if (order.cancelRequest?.state === 'pending') {
      Text('处理截止：' + formatBeijingTime(order.cancelRequest.deadlineAt))
        .fontSize(12).fontColor($r('[ui_components].color.gray'))
    }
    if (order.paymentNotice) {
      Text(order.paymentNotice).fontSize(12).fontColor($r('[ui_components].color.gray'))
    }
    if (order.refunds && order.refunds.length > 0) {
      ForEach(order.refunds, (refund: OrderRefund) => {
        Text(this.refundDisplayLine(refund))
          .fontSize(12).fontColor($r('[ui_components].color.gray'))
      }, (refund: OrderRefund) => refund.id)
    }
    if (order.receivedByAccount) {
      Text('收货确认人：' + order.receivedByAccount).fontSize(12).fontColor($r('[ui_components].color.text'))
    }
  }

  @Styles
  orderCardStyle() {
    .width('100%')
    .padding(16)
    .backgroundColor($r('[ui_components].color.white'))
    .borderRadius(8)
  }

  @Builder
  private FamilyOrderCard(order: OrderItem) {
    Column({ space: 8 }) {
      this.OrderSummary(order)
      if (this.pendingFamilyOrders.includes(order.id)) {
        Text('正在核对这笔订单的操作结果，请勿重复提交').fontSize(12)
        if (!this.checkingFamilyOrders.includes(order.id)) {
          Button('核对结果').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).onClick(() => this.retryFamilyCheck(order.id))
        }
      }
      Button('查看付款与订单详情').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') })
        .enabled(this.canManageFamily())
        .onClick(() => this.openFamilyOrder(order))
      if (this.hasFamilyOrderActions(order)) {
        if (order.paymentState === 'review' || (order.paymentNotice || '').includes('人工')) {
          Button('帮助与客服').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).onClick(() => this.stackPath.pushPath({ name: PAGE_PATH.CUSTOMER_SERVICE_PAGE }))
        }
        // 服务端决定当前亲友能否代付、代收，页面只按权限展示按钮。
        if (order.canPay && order.paymentState !== 'confirming' && order.paymentState !== 'review') {
          Button('确认模拟代付').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') })
            .enabled(this.canManageFamily() && !this.pendingFamilyOrders.includes(order.id))
            .onClick(() => this.confirmFamilyPayment(order))
        }
        if (order.canReceive) {
          Button('确认代收').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') })
            .enabled(this.canManageFamily() && !this.pendingFamilyOrders.includes(order.id))
            .onClick(() => this.confirmFamilyReceipt(order))
        }
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
        Text(order.address.receiver + ' · ' + order.address.contact).fontSize(14).fontColor($r('[ui_components].color.text'))
        Text(order.address.fullLocation + ' ' + order.address.address).fontSize(14).fontColor($r('[ui_components].color.text'))
      }
      if (order.cancelRequest?.state === 'pending') { Text('买家申请取消').fontSize(14) }
      if (order.canResolveCancel) {
        Button('处理取消申请').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') })
          .enabled(this.canManageFamily() && !this.pendingCancelActions.includes(order.id))
          .onClick(() => this.openCancelResolution(order))
      } else if (order.canShip) {
        Button('确认发货').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') })
          .enabled(this.canManageFamily() && !this.pendingCancelActions.includes(order.id))
          .onClick(() => this.shipOrder(order))
      }
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
            Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.SpaceBetween }) {
              ForEach([{ key: 'pay', label: '待我付款' }, { key: 'receipt', label: '待我收货' },
                { key: 'pending', label: '待处理' }, { key: 'all', label: '全部订单' }],
                (item: FamilyFilterItem) => {
                  Button(this.familyGroupLabel(item.key, item.label))
                    .id('family-filter-' + item.key)
                    .fontSize(14)
                    .width('48%')
                    .height(44)
                    .margin({ bottom: 8 })
                    .backgroundColor(this.familyGroup === item.key ? $r('[ui_components].color.red') : $r('[ui_components].color.under'))
                    .fontColor(this.familyGroup === item.key ? $r('[ui_components].color.white') : $r('[ui_components].color.text'))
                    .border({ width: this.familyGroup === item.key ? 0 : 1, color: $r('[ui_components].color.border') })
                    .enabled(!this.loading && !this.isSubmitting)
                    .onClick(() => this.selectFamilyGroup(item.key))
                }, (item: FamilyFilterItem) => item.key + ':' + this.familyGroup + ':' + this.familyGroupCount(item.key))
            }.width('100%')
            Row({ space: 8 }) {
              Button(this.relationsExpanded ? '收起关系管理' : '关系管理').fontSize(13)
                .backgroundColor($r('[ui_components].color.under'))
                .fontColor($r('[ui_components].color.text'))
                .border({ width: 1, color: $r('[ui_components].color.border') })
                .onClick(() => { this.relationsExpanded = !this.relationsExpanded })
              if (this.user.role === 'merchant') {
                Button('商家发货').fontSize(13)
                  .backgroundColor($r('[ui_components].color.under'))
                  .fontColor($r('[ui_components].color.text'))
                  .border({ width: 1, color: $r('[ui_components].color.border') })
                  .onClick(() => { this.familyGroup = 'merchant' })
              }
            }
            if (this.relationsExpanded) {
            Text('添加代付与代收亲友').fontSize(20).fontWeight(FontWeight.Bold).fontColor($r('[ui_components].color.text'))
            Text('对方确认后，可以受邀代付；你的亲友代付订单发货后，所有已绑定代收亲友均可确认收货。本人付款订单不支持代收。')
              .fontSize(13).fontColor($r('[ui_components].color.gray'))
            TextInput({ placeholder: '输入亲友的商城账号', text: $$this.friendAccount }).maxLength(32)
              .fontColor($r('[ui_components].color.text')).placeholderColor($r('[ui_components].color.gray')).backgroundColor($r('[ui_components].color.white'))
            Button('发送绑定邀请').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(this.canManageFamily() && this.friendAccount.trim().length >= 3).onClick(() => this.sendFamilyInvitation())
            if (this.errorText) { Text(this.errorText).fontColor($r('[ui_components].color.red')) }
            if (!this.loading && this.familyRelations.length === 0) { Text('暂无亲友关系').fontColor($r('[ui_components].color.text')) }
            ForEach(this.familyRelations, (relation: FamilyRelation) => {
              Column({ space: 8 }) {
                Text(relation.ownerAccount === this.user.account ? '我的亲友：' + relation.friendAccount : relation.ownerAccount + ' 邀请我作为代付与代收亲友')
                  .fontColor($r('[ui_components].color.text'))
                Text(relation.status === 'accepted' ? '已绑定' : '待确认').fontSize(12).fontColor($r('[ui_components].color.text'))
                if (relation.status === 'pending' && relation.friendAccount === this.user.account) {
                  Button('同意绑定').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(this.canManageFamily()).onClick(() => this.acceptFamilyInvitation(relation.id))
                }
                Button(relation.status === 'pending' ? '取消 / 拒绝邀请' : '解除绑定').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(this.canManageFamily())
                  .onClick(() => this.removeFamilyRelation(relation.id))
              }.width('100%').padding(16).backgroundColor($r('[ui_components].color.white')).borderRadius(8)
            // 普通接口对象刷新后重建变化行，避免保留旧状态与旧操作按钮。
            }, (relation: FamilyRelation) => JSON.stringify(relation))
            if (this.relationPages > 1) {
              Row({ space: 8 }) {
                Button('关系上一页').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(this.relationPage > 1 && !this.loading && !this.isSubmitting)
                  .onClick(() => this.loadFamilyCenter(this.familyPage, this.merchantPage, this.relationPage - 1))
                Text(this.relationPage + ' / ' + this.relationPages).fontColor($r('[ui_components].color.text'))
                Button('关系下一页').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(this.relationPage < this.relationPages && !this.loading && !this.isSubmitting)
                  .onClick(() => this.loadFamilyCenter(this.familyPage, this.merchantPage, this.relationPage + 1))
              }
            }
            }
            if (!this.relationsExpanded) {
              if (this.errorText) { Text(this.errorText).fontColor($r('[ui_components].color.red')) }
            }
            if (this.errorText) {
              Button('重试加载').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(!this.loading && !this.isSubmitting)
                .onClick(() => this.loadFamilyCenter())
            }
            if (this.familyGroup !== 'merchant') {
            Text('亲友订单').fontSize(18).fontWeight(FontWeight.Bold).fontColor($r('[ui_components].color.text'))
            if (!this.loading && this.visibleFamilyOrders().length === 0) { Text(this.familyEmptyText()).fontSize(14).fontColor($r('[ui_components].color.text')) }
            ForEach(this.visibleFamilyOrders(), (order: OrderItem) => { this.FamilyOrderCard(order) }, (order: OrderItem) => JSON.stringify(order))
            if (this.familyPages > 1) {
              Row({ space: 8 }) {
                Button('亲友上一页').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(this.familyPage > 1 && !this.loading && !this.isSubmitting)
                  .onClick(() => this.loadFamilyCenter(this.familyPage - 1, this.merchantPage))
                Text(this.familyPage + ' / ' + this.familyPages).fontColor($r('[ui_components].color.text'))
                Button('亲友下一页').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(this.familyPage < this.familyPages && !this.loading && !this.isSubmitting)
                  .onClick(() => this.loadFamilyCenter(this.familyPage + 1, this.merchantPage))
              }
            }
            }
            if (this.user.role === 'merchant' && (this.familyGroup === 'merchant' || this.familyGroup === 'all')) {
              if (this.pendingCancelActions.length > 0) {
                Text('操作结果待确认，请重新查询').fontSize(12).fontColor($r('[ui_components].color.text'))
                Button('重新查询').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(this.canManageFamily()).onClick(() => this.recoverCancelActions())
              }
              Text('商家待发货订单').fontSize(18).fontWeight(FontWeight.Bold).fontColor($r('[ui_components].color.text'))
              ForEach(this.ordersToShip, (order: OrderItem) => { this.MerchantOrderCard(order) }, (order: OrderItem) => JSON.stringify(order))
              if (this.merchantPages > 1) {
              Row({ space: 8 }) {
                Button('发货上一页').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(this.merchantPage > 1 && !this.loading && !this.isSubmitting)
                  .onClick(() => this.loadFamilyCenter(this.familyPage, this.merchantPage - 1))
                Text(this.merchantPage + ' / ' + Math.max(1, this.merchantPages)).fontColor($r('[ui_components].color.text'))
                Button('发货下一页').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).enabled(this.merchantPage < this.merchantPages && !this.loading && !this.isSubmitting)
                  .onClick(() => this.loadFamilyCenter(this.familyPage, this.merchantPage + 1))
              }
              }
            }
          }.width('100%').padding(16).alignItems(HorizontalAlign.Start)
        }.layoutWeight(1).width('100%').align(Alignment.TopStart)
      }.width('100%').height('100%').padding({ top: this.safeTop }).backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true)
    .bindSheet($$this.showCancelResolution, this.CancelResolutionSheet(), {
      height: SheetSize.FIT_CONTENT,
      onDisappear: () => this.closeCancelResolution()
    })
    .onShown(() => this.showFamilyCenter())
    .onHidden(() => this.aboutToDisappear())
  }
}
