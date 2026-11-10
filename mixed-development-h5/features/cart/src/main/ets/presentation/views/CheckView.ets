import { HDMCell, HDMNavBar } from 'ui_components'
import { AddressItem, CheckoutSelection, CheckoutPrice, CheckoutShortage, ExcludedCheckoutGoods, CreateOrderParams, CreateOrderParamsGoods, HDMUser, OrderGoodsItem, Summary } from 'models'
import { BusinessVariable, GlobalVariable, PAGE_PATH } from 'constants'
import { authCart, checkoutFailure, getOrderByRequestAPI, storeManager } from 'storage'
import { emitter } from '@kit.BasicServicesKit'
import { util } from '@kit.ArkTS'
import { connection } from '@kit.NetworkKit'
import { createOrderAPI, getPreOrderAPI, updateCheckoutCartAPI } from '../../data/api'
import { normalizeCheckoutAddress } from '../utils/CartPresentation'
import { ReturnPolicyConfirmation, ReturnPolicyGoods, returnPolicyLabel } from 'models'

// 用业务名称区分弹层，避免读者猜测 1、2 各代表什么。
enum CheckoutSheet {
  None = 0,
  Address = 2
}

@Builder
function CheckViewBuilder() {
  CheckView()
}

@Component
export struct CheckView {
  // 结算流程：读取商品／地址／金额 → 用户确认 → 创建订单 → 带订单号进入收银台。
  // loadCheckoutPreview 只读取结算信息；createOrderAndOpenCashier 才真正下单。
  // 创建成功不代表支付成功，支付结果由收银台后续查询服务端确认。
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('reloadForCurrentAccount') user: HDMUser = {} as HDMUser
  // 本次要购买的商品：由服务端根据购物袋中已勾选的商品返回。
  @State goodsList: OrderGoodsItem[] = []
  @State returnPolicy: ReturnPolicyConfirmation = new ReturnPolicyConfirmation()
  private checkoutScroller: Scroller = new Scroller()
  @State excludedNotice: string = ''
  // 用户可选的收货地址。
  @State addressList: AddressItem[] = []
  // 服务端返回的结算金额，购物袋的本地合计不直接用于下单。
  @State summary: Summary = {
    discountPrice: 0,
    goodsCount: 0,
    postFee: 0,
    totalPayPrice: 0,
    totalPrice: 0
  }
  // 结算页弹层
  @State showSheet: boolean = false
  @State activeSheet: CheckoutSheet = CheckoutSheet.None
  // 支付渠道
  @State payChannel: number = 1
  // 地址 id
  @State addressId: string = ''
  // 用户是否在结算页手动选过地址：未手动选择时跟随最新默认地址，改默认后立即生效
  @State addressManuallySelected: boolean = false
  // 只表示“正在创建订单”，不是结算信息加载中，也不是支付中。
  @State isSubmittingOrder: boolean = false
  @State confirmingOrder: boolean = false
  @State confirmingRequest: boolean = false
  @State confirmationExhausted: boolean = false
  @StorageProp(GlobalVariable.APP_FOREGROUND_SEQUENCE) @Watch('refreshAfterForeground') foregroundSequence: number = 0
  private confirmationTimer: number = -1
  private confirmationAttempt: number = 0
  private networkMonitor: connection.NetConnection | undefined = undefined
  private networkAttempted: boolean = false
  private requestSummary: string = ''
  private confirmationSequence: number = 0
  private recoveredOrderId: string = ''
  private checkoutAccountId: string = ''
  private checkoutSelection: CheckoutSelection | undefined = undefined
  private buyNowRemoved: boolean = false
  @Consume
  stackPath: NavPathStack

  private readonly reloadCheckoutAfterAddressChange: () => void = () => {
    this.loadCheckoutPreview()
  }
  // 同账号、同一个结算页实例的下单重试沿用此编号，切换会话才重新生成。
  // 服务端按“用户 + 编号”找回原订单，并核对商品和地址是否与首次提交一致。
  private orderRequestKey: string = util.generateRandomUUID(true)
  private checkoutQuerySequence: number = 0
  @State checkoutToken: string = ''
  private pageGeneration: number = 0
  @State pageActive: boolean = true
  @State checkoutLoading: boolean = true
  @State checkoutRefreshFailed: boolean = false
  @State editingCheckout: boolean = false
  private keepEmptyCheckout: boolean = false

  aboutToAppear(): void {
    this.pageActive = true
    if (!GlobalVariable.DEMO_ORDER_FLOW) {
      const params = this.stackPath.getParamByName?.(PAGE_PATH.CHECK_ORDER_PAGE) as Array<CheckoutSelection> | undefined
      const selection = params && params.length > 0 ? params[params.length - 1] : undefined
      if (selection && selection.skuId && Number.isInteger(selection.count) && selection.count > 0) this.checkoutSelection = selection
    }
    emitter.on(BusinessVariable.UPDATE_ADDRESS_LIST, this.reloadCheckoutAfterAddressChange)
    this.loadCheckoutPreview()
  }

  aboutToDisappear(): void {
    this.stopOrderRecovery()
    this.confirmationSequence++
    this.confirmingRequest = false
    this.pageActive = false
    this.pageGeneration++
    this.isSubmittingOrder = false
    this.checkoutQuerySequence++
    this.checkoutLoading = true
    this.showSheet = false
    this.editingCheckout = false
    emitter.off(BusinessVariable.UPDATE_ADDRESS_LIST, this.reloadCheckoutAfterAddressChange)
  }

  private reloadForCurrentAccount(): void {
    if ((this.user.token || '') !== this.checkoutToken) {
      if (!GlobalVariable.DEMO_ORDER_FLOW && this.checkoutAccountId && this.checkoutAccountId === this.user.id && this.goodsList.length > 0) {
        this.synchronizeCheckoutAccount()
        if (this.checkoutToken && storeManager.getPendingOrder(this.checkoutAccountId)) void this.confirmPendingOrder()
        return
      }
      this.loadCheckoutPreview()
    }
  }

  private synchronizeCheckoutAccount(): void {
    const token: string = this.user.token || ''
    const accountId: string = this.user.id || ''
    if (token === this.checkoutToken && (!accountId || accountId === this.checkoutAccountId)) {
      return
    }
    const changedAccount: boolean = !!accountId && !!this.checkoutAccountId && accountId !== this.checkoutAccountId
    if (accountId) this.checkoutAccountId = accountId
    this.checkoutToken = token
    this.stopOrderRecovery()
    this.confirmationSequence++
    this.confirmingOrder = false
    this.confirmingRequest = false
    this.pageGeneration++
    this.checkoutQuerySequence++
    this.isSubmittingOrder = false
    this.editingCheckout = false
    this.checkoutLoading = false
    this.showSheet = false
    this.activeSheet = CheckoutSheet.None
    if (!changedAccount) return
    this.returnPolicy = new ReturnPolicyConfirmation()
    this.requestSummary = ''
    this.recoveredOrderId = ''
    this.goodsList = []
    this.addressList = []
    this.addressId = ''
    this.addressManuallySelected = false
    this.summary = { discountPrice: 0, goodsCount: 0, postFee: 0, totalPayPrice: 0, totalPrice: 0 }
    this.isSubmittingOrder = false
    this.checkoutRefreshFailed = false
    this.checkoutLoading = false
    this.orderRequestKey = util.generateRandomUUID(true)
    this.pageActive = false
    AppStorage.setOrCreate<number>('currentTabIndex', 0)
    this.stackPath.clear()
  }

  private isCurrentCheckout(generation: number, token: string): boolean {
    return this.pageActive && generation === this.pageGeneration && token === this.checkoutToken &&
      token === (this.user.token || '') && token.length > 0
  }

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  // 第一步：获取结算预览，让用户核对商品、地址和金额；此时没有创建订单。
  private async loadCheckoutPreview(): Promise<void> {
    this.synchronizeCheckoutAccount()
    if (this.checkoutAccountId && this.user.id && this.checkoutAccountId !== this.user.id) return
    const token: string = this.checkoutToken
    const generation: number = this.pageGeneration
    if (!this.isCurrentCheckout(generation, token)) {
      this.checkoutLoading = false
      return
    }
    const sequence: number = ++this.checkoutQuerySequence
    this.checkoutLoading = true
    this.checkoutRefreshFailed = false
    try {
      if (!GlobalVariable.DEMO_ORDER_FLOW && storeManager.getPendingOrder(this.user.id || '')) {
        this.confirmingOrder = true
        await this.confirmPendingOrder()
        if (!this.isCurrentCheckout(generation, token) || this.confirmingOrder || this.recoveredOrderId) return
      }
      if (this.buyNowRemoved) return
      const checkoutPreview = await getPreOrderAPI(token, this.checkoutSelection)
      if (sequence !== this.checkoutQuerySequence || !this.isCurrentCheckout(generation, token)) {
        return
      }
      this.checkoutRefreshFailed = false
      this.refreshReturnPolicy(checkoutPreview.returnPolicyToken || '')
      if (checkoutPreview.excludedGoods && checkoutPreview.excludedGoods.length > 0) {
        this.excludedNotice = checkoutPreview.excludedGoods.map((item: ExcludedCheckoutGoods) => item.name + item.reason + '，已移出本次结算').join('；')
        this.keepEmptyCheckout = true
      }
      if (!checkoutPreview.goods || checkoutPreview.goods.length === 0) {
        this.goodsList = []
        this.summary = { discountPrice: 0, goodsCount: 0, postFee: 0, totalPayPrice: 0, totalPrice: 0 }
        this.showSheet = false
        if (this.keepEmptyCheckout) return
        this.safeToast(this.checkoutSelection ? '商品规格已失效，请重新选择' : '购物车中没有选中的商品')
        this.stackPath.pop()
        return
      }

      this.updateCheckoutAddress(checkoutPreview.userAddresses, this.addressId)
      this.summary = checkoutPreview.summary || {
        discountPrice: 0,
        goodsCount: 0,
        postFee: 0,
        totalPayPrice: 0,
        totalPrice: 0
      }
      this.goodsList = checkoutPreview.goods || []
    } catch {
      if (sequence === this.checkoutQuerySequence && this.isCurrentCheckout(generation, token)) {
        this.checkoutRefreshFailed = true
        this.safeToast('结算资料刷新失败，已保存的地址不受影响，请重新加载')
      }
    } finally {
      // 旧请求结束不能让仍在刷新的结算页恢复下单。
      if (sequence === this.checkoutQuerySequence && this.isCurrentCheckout(generation, token)) {
        this.checkoutLoading = false
      }
    }
  }

  // 手动选过且仍存在的地址优先；否则依次使用默认地址、原地址、列表首个地址。
  private updateCheckoutAddress(addresses: AddressItem[], previousAddressId: string): void {
    this.addressList = addresses.map((address: AddressItem) => normalizeCheckoutAddress(address))
    // 当前接口约定 isDefault === 0 表示默认地址。
    const defaultAddress = this.addressList.find((address: AddressItem) => address.isDefault === 0)
    const previousAddress = this.addressList.find((address: AddressItem) => address.id === previousAddressId)
    if (this.addressManuallySelected && previousAddress) {
      this.addressId = previousAddress.id
    } else {
      this.addressId = defaultAddress?.id || previousAddress?.id || this.addressList[0]?.id || ''
    }
  }

  // 第二步：用户提交订单，校验成功后进入收银台。
  private async createOrderAndOpenCashier(): Promise<void> {
    if (this.confirmingOrder) {
      await this.confirmPendingOrder()
      return
    }
    if (!this.canSubmitOrder()) {
      return
    }
    this.isSubmittingOrder = true
    const token: string = this.checkoutToken
    const generation: number = this.pageGeneration
    const accountId: string = this.user.id || ''
    const request = this.buildOrderRequest()
    let sent: boolean = false
    try {
      if (!GlobalVariable.DEMO_ORDER_FLOW) {
        await storeManager.savePendingOrder({ accountId, requestKey: this.orderRequestKey,
          summary: this.requestSummary })
        if (!this.isCurrentCheckout(generation, token)) return
      }
      sent = true
      const createdOrder = await createOrderAPI(request, token)
      if (!this.isCurrentCheckout(generation, token)) {
        return
      }
      if (!GlobalVariable.DEMO_ORDER_FLOW) await storeManager.clearPendingOrder(accountId, request.requestKey || '')
      if (!this.isCurrentCheckout(generation, token)) return
      // 下单后服务端会移除对应购物袋商品；角标刷新不阻塞进入收银台。
      void authCart.updateCartCount()
      this.openCashier(createdOrder.id)
    } catch (error) {
      // 401 明确未通过鉴权；即使登录拦截器已切换页面状态，也只清理本次原账号的记录。
      if (sent && !GlobalVariable.DEMO_ORDER_FLOW && checkoutFailure(error as Error).status === 401) {
        await storeManager.clearPendingOrder(accountId, request.requestKey || '')
      }
      if (this.isCurrentCheckout(generation, token)) {
        const failure = checkoutFailure(error as Error)
        if (!GlobalVariable.DEMO_ORDER_FLOW) {
          if (!sent) {
            this.confirmingOrder = storeManager.getPendingOrder(accountId) !== null
            this.safeToast('提交记录保存失败，请重试确认订单')
            return
          }
          if (failure.status === 401) {
            this.showSheet = false
            this.stackPath.pushPath({ name: PAGE_PATH.LOGIN_PAGE })
            return
          }
          if (failure.status < 400 || failure.status >= 500 || failure.status === 408 || failure.status === 429) {
            this.confirmingOrder = true
            this.showSheet = false
            await this.confirmPendingOrder()
            return
          }
          await storeManager.clearPendingOrder(accountId, request.requestKey || '')
          if (!this.isCurrentCheckout(generation, token)) return
          this.orderRequestKey = util.generateRandomUUID(true)
        }
        if ((failure.reason === 'RETURN_POLICY_CHANGED' || failure.reason === 'RETURN_POLICY_CONFIRM_REQUIRED') && failure.result) {
          const policies = failure.result.goods as ReturnPolicyGoods[]
          this.goodsList = this.goodsList.map((item: OrderGoodsItem): OrderGoodsItem => {
            const updated = this.copyCheckoutItem(item), policy = policies.find((value: ReturnPolicyGoods): boolean => value.skuId === item.skuId)
            if (policy) {
              updated.returnPolicy = policy.returnPolicy; updated.returnPolicyReason = policy.returnPolicyReason; updated.returnPolicyNote = policy.returnPolicyNote
            }
            return updated
          })
          this.returnPolicy = new ReturnPolicyConfirmation()
          this.refreshReturnPolicy(failure.result.returnPolicyToken || '')
          this.showSheet = false
          this.validateReturnPolicy()
        } else if (failure.reason === 'PRICE_CHANGED' && failure.result) {
          const prices = failure.result.goods as CheckoutPrice[]
          this.goodsList = this.goodsList.map((item: OrderGoodsItem): OrderGoodsItem => {
            const price = prices.find((value: CheckoutPrice) => value.skuId === item.skuId)
            const updated = this.copyCheckoutItem(item)
            if (price) {
              updated.price = String(price.priceCents / 100)
              updated.payPrice = updated.price
              updated.totalPrice = String(price.subtotalCents / 100)
              updated.totalPayPrice = updated.totalPrice
            }
            return updated
          })
          this.summary = { goodsCount: this.summary.goodsCount, discountPrice: this.summary.discountPrice,
            postFee: this.summary.postFee, totalPrice: (failure.result.totalAmountCents || 0) / 100,
            totalPayPrice: (failure.result.totalAmountCents || 0) / 100 }
          this.orderRequestKey = util.generateRandomUUID(true)
          this.showSheet = false
          this.safeToast('商品价格有变化，已更新为最新价格，请确认后再提交')
        } else if (failure.reason === 'PRODUCT_UNAVAILABLE') {
          this.keepEmptyCheckout = true
          this.showSheet = false
          if (failure.result) this.excludedNotice = (failure.result.goods as ExcludedCheckoutGoods[])
            .map((item: ExcludedCheckoutGoods) => item.name + item.reason + '，已移出本次结算').join('；')
          await this.loadCheckoutPreview()
        } else if (failure.reason === 'STOCK_SHORTAGE' && failure.result) {
          const shortages = failure.result.goods as CheckoutShortage[]
          this.goodsList = this.goodsList.map((item: OrderGoodsItem): OrderGoodsItem => {
            const shortage = shortages.find((value: CheckoutShortage) => value.skuId === item.skuId)
            const updated = this.copyCheckoutItem(item)
            if (shortage) updated.stock = shortage.remainingCount
            return updated
          })
          this.orderRequestKey = util.generateRandomUUID(true)
          this.showSheet = false
          this.safeToast('库存不足：' + shortages.map((item: CheckoutShortage) => item.name + '（' + item.spec + '）').join('、'))
        } else {
          this.safeToast('提交订单失败，请稍后重试')
        }
      }
    } finally {
      if (this.isCurrentCheckout(generation, token)) {
        this.isSubmittingOrder = false
      }
    }
  }

  private canSubmitOrder(): boolean {
    if (!this.isCurrentCheckout(this.pageGeneration, this.checkoutToken)) {
      return false
    }
    if (this.isSubmittingOrder) {
      return false
    }
    if (!this.isCheckoutReady()) {
      this.safeToast(this.checkoutLoading ? '结算资料加载中，请稍候' :
        this.checkoutRefreshFailed ? '请重新加载结算资料后再提交' : '购物车中没有选中的商品')
      return false
    }
    if (this.payChannel !== 1) {
      this.safeToast('暂不支持该支付方式')
      return false
    }
    if (!this.addressList.some((address: AddressItem) => address.id === this.addressId)) {
      this.safeToast('未选择收货地址')
      return false
    }
    return this.validateReturnPolicy()
  }

  private refreshReturnPolicy(token: string): void {
    const gate = this.returnPolicy.copy(); gate.refresh(token); this.returnPolicy = gate
  }
  private chooseReturnPolicy(confirmed: boolean): void {
    if (this.confirmingOrder || this.isSubmittingOrder || !this.isCheckoutReady()) return
    const gate = this.returnPolicy.copy(); gate.choose(confirmed); this.returnPolicy = gate
  }
  private validateReturnPolicy(): boolean {
    const gate = this.returnPolicy.copy(), valid = gate.validate(this.goodsList)
    this.returnPolicy = gate
    if (!valid) this.checkoutScroller.scrollToIndex(5, false, ScrollAlign.END)
    return valid
  }
  private restrictedGoods(): OrderGoodsItem[] { return this.goodsList.filter((item: OrderGoodsItem): boolean => !!item.returnPolicy && item.returnPolicy !== 'standard') }
  private needsReturnPolicyConfirmation(): boolean { return this.goodsList.some((item: OrderGoodsItem): boolean => item.returnPolicy === 'confirm-required') }

  private isCheckoutReady(): boolean {
    return this.pageActive && this.checkoutToken.length > 0 && this.checkoutToken === (this.user.token || '') &&
      !this.confirmingOrder && !this.editingCheckout && !this.checkoutLoading && !this.checkoutRefreshFailed && this.goodsList.length > 0 && !this.hasStockShortage()
  }

  private hasStockShortage(): boolean {
    return this.goodsList.some((item: OrderGoodsItem) => item.stock !== undefined && item.count > item.stock)
  }

  private stockShortageText(item: OrderGoodsItem): string {
    return item.stock !== undefined && item.count > item.stock ? '库存不足，剩余' + item.stock + '件' : ''
  }

  private copyCheckoutItem(item: OrderGoodsItem): OrderGoodsItem {
    return { id: item.id, skuId: item.skuId, name: item.name, attrsText: item.attrsText, count: item.count,
      returnPolicy: item.returnPolicy, returnPolicyReason: item.returnPolicyReason, returnPolicyNote: item.returnPolicyNote,
      picture: item.picture, stock: item.stock, price: item.price, payPrice: item.payPrice,
      totalPrice: item.totalPrice, totalPayPrice: item.totalPayPrice }
  }

  private async updateCheckoutQuantity(skuId: string, value: string): Promise<void> {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 999) {
      this.safeToast('数量请输入 1 到 999 的整数')
      return
    }
    await this.changeCheckoutItem(skuId, Number(value))
  }

  private async removeCheckoutItem(skuId: string): Promise<void> {
    await this.changeCheckoutItem(skuId, 0)
  }

  private async changeCheckoutItem(skuId: string, count: number): Promise<void> {
    const generation: number = this.pageGeneration
    const token: string = this.checkoutToken
    if (!this.isCurrentCheckout(generation, token) || this.confirmingOrder || this.isSubmittingOrder ||
      this.editingCheckout || this.checkoutLoading || !this.goodsList.some((item: OrderGoodsItem) => item.skuId === skuId)) return
    this.editingCheckout = true
    this.keepEmptyCheckout = true
    try {
      if (this.checkoutSelection) {
        if (count === 0) {
          this.buyNowRemoved = true
          this.goodsList = []
          this.summary = { discountPrice: 0, goodsCount: 0, postFee: 0, totalPayPrice: 0, totalPrice: 0 }
          return
        }
        this.checkoutSelection = { skuId, count }
      } else {
        if (count === 0) await updateCheckoutCartAPI(skuId, { selected: false }, token)
        else await updateCheckoutCartAPI(skuId, { count }, token)
        if (!this.isCurrentCheckout(generation, token)) return
      }
      await this.loadCheckoutPreview()
    } catch {
      if (this.isCurrentCheckout(generation, token)) {
        this.checkoutRefreshFailed = true
        this.safeToast('暂时连不上服务，请重新加载确认商品数量')
      }
    } finally {
      if (this.isCurrentCheckout(generation, token)) this.editingCheckout = false
    }
  }

  private async submitCheckout(): Promise<void> {
    if (!this.canSubmitOrder()) {
      return
    }
    this.showSheet = false
    await this.createOrderAndOpenCashier()
  }

  private openCheckoutAddressEditor(addressId: string = ''): void {
    if (this.confirmingOrder || this.isSubmittingOrder || !this.isCurrentCheckout(this.pageGeneration, this.checkoutToken)) return
    const token: string = this.checkoutToken
    this.showSheet = false
    this.stackPath.pushPath({ name: PAGE_PATH.ADDRESS_PAGE, param: 'checkout:' + addressId,
      onPop: (info: PopInfo) => {
        if (token !== (this.user.token || '') || typeof info.result !== 'string' || !info.result) return
        this.addressId = info.result as string
        this.addressManuallySelected = true
        void this.loadCheckoutPreview()
      }
    })
  }

  // 只提交商品规格、数量和地址等下单信息；金额由服务端核算。
  private buildOrderRequest(): CreateOrderParams {
    const source: 'cart' | 'buy-now' = this.checkoutSelection ? 'buy-now' : 'cart'
    const summary: string = JSON.stringify({ source, addressId: this.addressId, expectedAmountCents: Math.round(this.summary.totalPayPrice * 100),
      returnPolicyConfirmed: this.returnPolicy.confirmed, expectedReturnPolicyToken: this.returnPolicy.token,
      goods: this.goodsList.map((item: OrderGoodsItem): CreateOrderParamsGoods => ({ skuId: item.skuId, count: item.count }))
        .sort((left: CreateOrderParamsGoods, right: CreateOrderParamsGoods) => left.skuId.localeCompare(right.skuId)) })
    if (!GlobalVariable.DEMO_ORDER_FLOW && this.requestSummary && this.requestSummary !== summary) {
      this.orderRequestKey = util.generateRandomUUID(true)
    }
    this.requestSummary = summary
    return {
      source,
      requestKey: this.orderRequestKey,
      expectedAmountCents: Math.round(this.summary.totalPayPrice * 100),
      returnPolicyConfirmed: this.returnPolicy.confirmed,
      expectedReturnPolicyToken: this.returnPolicy.token || undefined,
      payChannel: this.payChannel,
      payType: 1,
      buyerMessage: '',
      addressId: this.addressId,
      goods: this.goodsList.map((item: OrderGoodsItem): CreateOrderParamsGoods => ({
        skuId: item.skuId,
        count: item.count
      })),
      deliveryTimeType: 1
    }
  }

  // 第三步：关闭弹层，用服务端返回的真实订单号打开收银台。
  private openCashier(orderId: string): void {
    this.showSheet = false
    this.stackPath.replacePath({ name: PAGE_PATH.PAY_PAGE, param: orderId })
  }

  private orderStatusText(): string {
    return this.confirmingOrder ? '正在确认是否下单成功，请勿重复提交' : ''
  }

  private refreshAfterForeground(): void {
    if (this.pageActive && this.confirmingOrder) void this.confirmPendingOrder()
  }

  private stopOrderRecovery(): void {
    if (this.confirmationTimer !== -1) clearTimeout(this.confirmationTimer)
    this.confirmationTimer = -1
    this.confirmationAttempt = 0
    this.confirmationExhausted = false
    const monitor = this.networkMonitor
    this.networkMonitor = undefined
    this.networkAttempted = false
    if (monitor) {
      try { monitor.unregister(() => {}) } catch {}
    }
  }

  private watchOrderNetwork(generation: number, token: string): void {
    if (this.networkAttempted) return
    this.networkAttempted = true
    try {
      const monitor = connection.createNetConnection()
      this.networkMonitor = monitor
      monitor.on('netAvailable', () => {
        if (this.networkMonitor === monitor && this.confirmingOrder && this.isCurrentCheckout(generation, token)) {
          void this.confirmPendingOrder()
        }
      })
      monitor.register((error) => {
        if (!error && this.networkMonitor !== monitor) {
          try { monitor.unregister(() => {}) } catch {}
          return
        }
        if (error && this.networkMonitor === monitor) {
          this.networkMonitor = undefined
          try { monitor.unregister(() => {}) } catch {}
        }
      })
    } catch {
      const monitor = this.networkMonitor
      this.networkMonitor = undefined
      if (monitor) { try { monitor.unregister(() => {}) } catch {} }
    }
  }

  private scheduleOrderConfirmation(generation: number, token: string): void {
    if (!this.confirmingOrder || !this.isCurrentCheckout(generation, token) || this.confirmationTimer !== -1) return
    const delays: number[] = [1000, 3000, 8000]
    if (this.confirmationAttempt >= delays.length) {
      this.confirmationExhausted = true
      return
    }
    const delay: number = delays[this.confirmationAttempt++]
    this.confirmationTimer = setTimeout(() => {
      if (!this.isCurrentCheckout(generation, token) || !this.confirmingOrder) return
      this.confirmationTimer = -1
      void this.confirmPendingOrder()
    }, delay)
  }

  private retryOrderConfirmation(): void {
    if (this.confirmingRequest) return
    this.confirmationAttempt = 0
    this.confirmationExhausted = false
    void this.confirmPendingOrder()
  }

  private async confirmPendingOrder(): Promise<void> {
    const generation: number = this.pageGeneration
    const token: string = this.checkoutToken
    if (this.confirmingRequest || !this.isCurrentCheckout(generation, token)) return
    const accountId: string = this.user.id || ''
    const record = storeManager.getPendingOrder(accountId)
    if (!record) { this.confirmingOrder = false; this.stopOrderRecovery(); return }
    const sequence: number = ++this.confirmationSequence
    this.orderRequestKey = record.requestKey
    this.confirmingOrder = true
    this.confirmingRequest = true
    this.watchOrderNetwork(generation, token)
    try {
      const order = await getOrderByRequestAPI(record.requestKey, token)
      if (sequence !== this.confirmationSequence || !this.isCurrentCheckout(generation, token)) return
      await storeManager.clearPendingOrder(accountId, record.requestKey)
      if (sequence !== this.confirmationSequence || !this.isCurrentCheckout(generation, token)) return
      this.confirmingOrder = false
      this.stopOrderRecovery()
      this.goodsList = []
      this.recoveredOrderId = order.id
      void authCart.updateCartCount()
      if (order.orderState === 1) this.openCashier(order.id)
      else this.stackPath.replacePath({ name: PAGE_PATH.ORDER_DETAIL_PAGE, param: order.id })
    } catch {
      // 查询失败或暂时查无记录都不能证明创建失败，保留原请求直到查清。
    } finally {
      if (sequence === this.confirmationSequence && this.isCurrentCheckout(generation, token)) {
        this.confirmingRequest = false
        this.scheduleOrderConfirmation(generation, token)
      }
    }
  }

  // 以下只负责页面展示和把用户操作交给上述业务方法。
  @Builder
  private ReturnPolicyArea() {
    Column({ space: 10 }) {
      Text('请了解商品退货规则').fontColor($r('[ui_components].color.text')).fontWeight(500).width('100%')
      ForEach(this.restrictedGoods(), (item: OrderGoodsItem) => {
        Text(item.name + '：' + returnPolicyLabel(item)).fontSize(14).fontColor($r('[ui_components].color.text')).width('100%')
      }, (item: OrderGoodsItem) => item.skuId + ':' + item.returnPolicy + ':' + item.returnPolicyReason + ':' + item.returnPolicyNote)
      if (this.needsReturnPolicyConfirmation()) {
        Row({ space: 8 }) {
          Checkbox().id('checkout-policy-checkbox').select(this.returnPolicy.confirmed)
            .selectedColor($r('[ui_components].color.red')).size({ width: 22, height: 22 })
            .enabled(!this.isSubmittingOrder && this.isCheckoutReady())
            .onChange((value: boolean) => this.chooseReturnPolicy(value))
          Text('我已了解以上商品的退货限制').fontSize(14).fontColor($r('[ui_components].color.text')).layoutWeight(1)
            .onClick(() => this.chooseReturnPolicy(!this.returnPolicy.confirmed))
        }.width('100%')
        if (this.returnPolicy.highlighted) {
          Text('请先阅读并勾选退货限制，再提交订单').id('checkout-policy-warning').fontSize(14).fontColor($r('[ui_components].color.red')).width('100%')
        }
      }
    }.id('checkout-return-policy').padding(14).margin(8).backgroundColor($r('[ui_components].color.white'))
      .borderRadius(12).border({ width: this.returnPolicy.highlighted ? 2 : 1,
        color: this.returnPolicy.highlighted ? $r('[ui_components].color.red') : $r('[ui_components].color.border') })
  }
  @Builder
  GoodsItemBuilder(goods: OrderGoodsItem) {
    Row({ space: 10 }) {
      Image(goods.picture)
        .width(80)
        .height(80)
      Column({ space: 8 }) {
        Text(goods.name)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .maxLines(1)
          .fontSize(14)
          .fontColor($r('[ui_components].color.black'))
          .width('100%')
        Row({ space: 8 }) {
          Text(goods.attrsText)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .maxLines(1)
            .fontSize(12)
            .fontColor($r('[ui_components].color.text'))
            .layoutWeight(1)
          Text('x' + goods.count)
            .fontSize(14)
            .fontColor($r('[ui_components].color.gray'))
        }
        .width('100%')
        .justifyContent(FlexAlign.SpaceBetween)

        Text('¥' + goods.payPrice)
          .width('100%')
          .fontSize(16)
          .fontColor($r('[ui_components].color.black'))
        if (this.stockShortageText(goods).length > 0) {
          Text(this.stockShortageText(goods))
            .fontColor($r('[ui_components].color.red'))
            .fontSize(14)
          Row({ space: 8 }) {
            TextInput({ text: String(goods.count), placeholder: '购买数量' })
              .type(InputType.Number)
              .width(100)
              .enabled(!this.editingCheckout && !this.confirmingOrder && !this.checkoutLoading)
              .onSubmit((enterKey: EnterKeyType, event: SubmitEvent) => {
                void this.updateCheckoutQuantity(goods.skuId, event.text)
              })
            Button('移除此商品')
              .enabled(!this.editingCheckout && !this.confirmingOrder && !this.checkoutLoading)
              .onClick(() => this.removeCheckoutItem(goods.skuId))
          }
        }
      }
      .layoutWeight(1)
    }
    .padding({ top: 10, bottom: 10 })
    .border({
      width: { bottom: 0.5 },
      color: $r('[ui_components].color.border')
    })
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: '结算',
          onLeftClick: () => {
            this.stackPath.pop()
          }
        })
          .border({
            width: { bottom: 0.5 },
            color: $r('[ui_components].color.border')
          })
        if (this.confirmingOrder) {
          Text(this.orderStatusText())
          if (this.confirmationExhausted) {
          Button('再查一次')
            .enabled(!this.confirmingRequest)
            .onClick(() => this.retryOrderConfirmation())
          }
        }
        if (this.excludedNotice) { Text(this.excludedNotice).fontColor('#B34D36').padding(12) }
        if (!this.user.token) {
          Button('重新登录后继续结算')
            .onClick(() => this.stackPath.pushPath({ name: PAGE_PATH.LOGIN_PAGE }))
        }
        if (this.checkoutLoading) {
          Text('正在加载结算资料…')
            .fontSize(13)
            .padding(12)
        } else if (this.checkoutRefreshFailed) {
          Text('结算资料刷新失败，点击重新加载')
            .fontColor($r('[ui_components].color.red'))
            .fontSize(13)
            .padding(12)
            .onClick(() => this.loadCheckoutPreview())
        }
        if (!this.checkoutLoading && this.goodsList.length === 0 && !this.confirmingOrder) {
          if (this.excludedNotice) { Text('所选商品暂不可购买').fontColor('#B34D36') }
          Text('本次结算没有商品')
          Button('返回购物车')
            .onClick(() => this.stackPath.replacePath({ name: PAGE_PATH.CART_PAGE, param: true }))
        }
        List({ scroller: this.checkoutScroller }) {
          ListItem() {
            ChangeAddressComp({
              addressList: this.addressList,
              selectedAddressId: this.addressId,
              onAddressClick: () => {
                this.activeSheet = CheckoutSheet.Address
                this.showSheet = true
              }
            })
          }

          ListItem() {
            Row() {
              Column() {
                ForEach(this.goodsList, (goods: OrderGoodsItem) => {
                  this.GoodsItemBuilder(goods)
                })
              }
              .padding({ left: 8, right: 8 })
              .backgroundColor($r('[ui_components].color.white'))
            }
            .padding({ top: 8, left: 8, right: 8 })
          }

          ListItem() {
            Row() {
              Column() {
                HDMCell({ title: '配送时间', value: '时间不限' })
                HDMCell({ title: '留言', value: '建议留言前先和卖家沟通' })
              }
              .padding({ left: 8, right: 8 })
              .backgroundColor($r('[ui_components].color.white'))
            }
            .padding({ top: 8, left: 8, right: 8 })
          }

          ListItem() {
            Row() {
              Column() {
                PriceCell({ label: '商品总价', price: this.summary.totalPrice })
                PriceCell({ label: '运费', price: this.summary.postFee })
                PriceCell({ label: '实付金额', price: this.summary.totalPayPrice, isRed: true })
              }
              .padding({ left: 8, right: 8 })
              .backgroundColor($r('[ui_components].color.white'))
            }
            .padding({ top: 8, left: 8, right: 8 })
          }

          ListItem() {
            Row() {
              Column() {
                CheckCell({ label: '在线支付', checked: true })
                CheckCell({ label: '货到付款' })
              }
              .padding({ left: 8, right: 8 })
              .backgroundColor($r('[ui_components].color.white'))
            }
            .padding(8)
          }

          ListItem() {
            if (this.restrictedGoods().length > 0) { this.ReturnPolicyArea() }
          }
        }
        .width('100%')
        .height('100%')
        .layoutWeight(1)
        .scrollBar(BarState.Off)

        Row() {
          Column() {
            Text() {
              Span('¥')
                .fontSize(14)
              Span((this.summary.totalPayPrice || 0).toFixed(2))
                .fontSize(20)
            }
            .fontColor($r('[ui_components].color.red'))
            .fontWeight(500)

            Text() {
              Span('共减')
                .fontColor($r('[ui_components].color.gray'))
              Span('¥' + (this.summary.discountPrice || 0).toFixed(2))
                .fontColor($r('[ui_components].color.red'))
                .fontWeight(500)
            }
            .fontSize(8)
          }
          .alignItems(HorizontalAlign.Start)

          Blank()
          Button('提交订单并付款')
            .enabled(!this.isSubmittingOrder && this.isCheckoutReady())
            .fontSize(14)
            .height(36)
            .backgroundColor($r('[ui_components].color.red'))
            .onClick(() => {
              // 此处只建单；收银台仍由用户明确确认付款。
              this.submitCheckout()
            })
        }
        .height(50 + this.safeBottom)
        .width('100%')
        .backgroundColor($r('[ui_components].color.white'))
        .border({
          width: { top: 0.5 },
          color: '#e4e4e4'
        })
        .padding({ left: 16, right: 16, bottom: this.safeBottom })
      }
      .backgroundColor($r('[ui_components].color.under'))
      .bindSheet($$this.showSheet, this.AddressSelectBuilder(), {
        title: {
          title: '选择收货地址',
          subtitle: ''
        }, height: SheetSize.FIT_CONTENT, backgroundColor: $r('[ui_components].color.white')
      })
      .padding({
        top: this.safeTop,
      })
    }
    .hideTitleBar(true)
    .onHidden(() => this.aboutToDisappear())
    .onShown(() => {
      if (!this.pageActive) this.aboutToAppear()
    })
  }

  @Builder
  AddressSelectBuilder() {
    Column({ space: 10 }) {
      if (this.addressList.length === 0) {
        Text('还没有收货地址，请先添加')
          .fontSize(14)
          .fontColor($r('[ui_components].color.gray'))
          .padding({ top: 16, bottom: 16 })
      } else {
        List({ space: 8 }) {
          ForEach(this.addressList, (address: AddressItem) => {
            ListItem() {
              Row({ space: 8 }) {
                Column({ space: 4 }) {
                  Row({ space: 6 }) {
                    if (address.isDefault === 0) {
                      Text('默认')
                        .fontSize(11)
                        .fontColor($r('[ui_components].color.white'))
                        .backgroundColor($r('[ui_components].color.red'))
                        .borderRadius(3)
                        .padding({ left: 4, right: 4, top: 2, bottom: 2 })
                    }
                    Text(`${address.receiver}  ${address.contact}`)
                      .fontSize(14)
                      .fontColor($r('[ui_components].color.black'))
                  }
                  Text(`${address.fullLocation} ${address.address}`)
                    .fontSize(12)
                    .fontColor($r('[ui_components].color.text'))
                    .maxLines(2)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .width('100%')
                }
                .layoutWeight(1)
                if (address.id === this.addressId) {
                  Text('✓')
                    .fontSize(18)
                    .fontColor($r('[ui_components].color.red'))
                }
                Button('编辑')
                  .onClick(() => this.openCheckoutAddressEditor(address.id))
              }
              .width('100%')
              .padding(12)
              .backgroundColor(address.id === this.addressId ? $r('[ui_components].color.under') : $r('[ui_components].color.white'))
              .borderRadius(6)
            }
            .onClick(() => {
              this.addressId = address.id
              this.addressManuallySelected = true
              this.showSheet = false
            })
          }, (address: AddressItem) => address.id)
        }
        .width('100%')
        .height(260)
        .scrollBar(BarState.Off)
      }
      Button('新增地址')
        .width('100%')
        .height(40)
        .fontSize(14)
        .backgroundColor($r('[ui_components].color.under'))
        .fontColor($r('[ui_components].color.text'))
        .onClick(() => {
          this.openCheckoutAddressEditor()
        })
    }
    .width('100%')
    .padding({ left: 16, right: 16, bottom: 20 })
  }
}

@Component
struct ChangeAddressComp {
  @Prop @Watch('onAddressListChange') addressList: AddressItem[] = []
  @Prop @Watch('onAddressSelectionChange') selectedAddressId: string = ''
  @State currentAddress: AddressItem = {} as AddressItem
  onAddressClick: () => void = () => {
  }

  onAddressListChange() {
    if (this.addressList.length === 0) {
      this.currentAddress = {} as AddressItem
      return
    }
    const selectedAddress = this.addressList.find(addr => addr.id === this.selectedAddressId)
    if (selectedAddress) {
      this.currentAddress = selectedAddress
    } else {
      const defAddress = this.addressList.find(addr => addr.isDefault === 0)
      this.currentAddress = defAddress || this.addressList[0]
    }
  }

  onAddressSelectionChange() {
    this.onAddressListChange()
  }

  aboutToAppear() {
    this.onAddressListChange()
  }

  @Builder
  AddressTipBuilder() {
    if (this.addressList.length) {
      Column({ space: 8 }) {
        Row({ space: 4 }) {
          if (this.currentAddress.isDefault === 0) {
            Text('默认')
              .fontSize(14)
              .width(40)
              .height(20)
              .borderRadius(4)
              .fontColor($r('[ui_components].color.white'))
              .textAlign(TextAlign.Center)
              .linearGradient({
                angle: 90,
                colors: [[$r('[ui_components].color.linear_begin'), 0], [$r('[ui_components].color.linear_end'), 1]]
              })
          }
          Text(this.currentAddress.fullLocation)
            .fontSize(14)
            .fontColor($r('[ui_components].color.text'))
        }

        Text(this.currentAddress.address)
          .fontWeight(500)
          .fontSize(16)
          .fontColor($r('[ui_components].color.black'))
        Text(`${this.currentAddress.receiver} ${this.currentAddress.contact}`)
          .fontSize(13)
          .fontColor($r('[ui_components].color.text'))
      }
      .alignItems(HorizontalAlign.Start)
      .padding({ top: 10, bottom: 10 })
    } else {
      Text('请填写收货地址')
        .fontSize(14)
        .fontColor($r('[ui_components].color.gray'))
    }
  }

  build() {
    Row() {
      HDMCell({
        customLabel: () => {
          this.AddressTipBuilder()
        }
      })
    }
    .padding({ left: 16, right: 16 })
    .backgroundColor($r('[ui_components].color.white'))
    .width('100%')
    .onClick(() => this.onAddressClick())
  }
}

@Component
struct PriceCell {
  @Prop label: string
  @Prop price: number = 0
  @Prop isRed: boolean = false

  @Builder
  PriceBuilder() {
    Text('¥' + (this.price || 0).toFixed(2))
      .fontSize(this.isRed ? 16 : 14)
      .fontColor(this.isRed ? $r('[ui_components].color.red') : $r('[ui_components].color.gray'))
  }

  build() {
    HDMCell({
      title: this.label, customIcon: () => {
        this.PriceBuilder()
      }
    })
  }
}

@Component
struct CheckCell {
  @Prop label: string
  @Prop checked: boolean = false
  onClickBox: () => void = () => {

  }

  @Builder
  CheckBuilder() {
    Checkbox()
      .selectedColor($r('[ui_components].color.red'))
      .select(this.checked)
      .onClick(() => {
        this.onClickBox()
      })
  }

  build() {
    HDMCell({
      title: this.label, customIcon: () => {
        this.CheckBuilder()
      }
    })
  }
}
