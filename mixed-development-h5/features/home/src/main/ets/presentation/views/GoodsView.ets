import { BusinessVariable, GlobalVariable, PAGE_PATH } from 'constants'
import { CheckoutSelection, HDMGoodsItem, HDMUser } from 'models'
import { auth, checkoutFailure, localGoodsStore, storeManager } from 'storage'
import { util } from '@kit.ArkTS'
import { HDMGuess, HDMLoading, HDMLoadingDialog, HDMNavBar, HDMPreviewImage, HDMSku, HDMSkuType } from 'ui_components'
import { authCart } from 'storage'
import { Logger } from 'utils'
import { Goods, GoodsEvaluation } from '../../domain/models'
import { GoodsInfo, GoodsComment, GoodsDetail } from '../components'
import { getDetailAPI, getGoodsEvaluationsAPI, getGuessLikeAPI } from '../../data/api'
import { generateFallbackGoods, isFallbackSkuId } from '../../data/api/mockData'
import { normalizeSkuSelection } from '../../data/api/goodsPresentation'
import { canPreserveLoginSelection, isPendingTradeValid, PendingLoginSelection, restoreLoginSelection } from '../../data/api/loginSkuSelection'


@Builder
function GoodsViewBuilder() {
  GoodsView()
}

@Component
export struct GoodsView {
  @StorageProp
  (GlobalVariable.SAFE_AREA_BOTTOM)
  safeBottom: number = 0
  @StorageProp(BusinessVariable.CART_COUNT)
  cartCount: number = 0
  @StorageProp
  (GlobalVariable.SAFE_AREA_TOP)
  safeTop: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('reloadForCurrentAccount')
  user: HDMUser = { token: '', account: '', nickname: '', avatar: '' }
  @StorageProp(GlobalVariable.APP_FOREGROUND_SEQUENCE) @Watch('refreshAfterForeground') foregroundSequence: number = 0
  @State goods: Goods = {} as Goods
  @State activeIndex: number = 0
  @State showSheet: boolean = false
  @State cartAdded: boolean = false
  @State count: number = 1
  @State loading: boolean = false
  @State detailReady: boolean = false
  @State detailFailed: boolean = false
  private detailSequence: number = 0
  @State isFavorite: boolean = false
  @State favoriteSaving: boolean = false
  private isPageActive: boolean = false
  private pageGeneration: number = 0
  private sessionToken: string = ''
  private sessionAccount: string = ''
  private loginSelection: PendingLoginSelection | undefined = undefined
  private addRequestKey: string = ''
  private addRequestSignature: string = ''
  private navigatingPurchase: boolean = false
  private addRequestCreated: number = 0
  private addOutcomeUnknown: boolean = false
  @State evaluations: GoodsEvaluation[] = []
  @State evaluationCount: number = 0
  @State evaluationLoading: boolean = false
  @State
  sku: HDMSkuType = normalizeSkuSelection()
  scroller = new Scroller()
  loadingTitle: string = "加载中..."
  @State showLoadingDialog: boolean = false
  @State showPreview: boolean = false
  @State previewUrls: string[] = []
  @State previewIndex: number = 0
  @Consume
  stackPath: NavPathStack

  @Builder
  LoadingDialogBuilder() {
    HDMLoadingDialog({
      title: this.loadingTitle
    })
  }
  tabs: string[] = ['商品', '评价', '详情', '推荐']
  private evaluationRequestId: number = 0

  private getSelectedInventory(): number {
    return this.sku.id.length > 0 ? this.sku.inventory : 0
  }

  private getInventoryText(): string {
    if (this.sku.id.length === 0) {
      return '请选择规格'
    }
    return this.getSelectedInventory() > 0 ? `库存 ${this.getSelectedInventory()}` : '暂时缺货'
  }

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  aboutToAppear() {
    this.isPageActive = true
    // 接收并解析数据
    this.getDetailData() // 获取详情数据
  }

  private showGoods(): void { if (!this.isPageActive) this.aboutToAppear() }
  private refreshAfterForeground(): void {
    if (this.isPageActive && !this.loading && !this.favoriteSaving) this.getDetailData()
  }
  private reloadForCurrentAccount(): void {
    if (this.synchronizeSession() && this.isPageActive) this.getDetailData()
  }
  private synchronizeSession(): boolean {
    const token: string = this.user.token || '', account: string = this.user.account || ''
    if (token === this.sessionToken && account === this.sessionAccount) return false
    if (this.loginSelection && canPreserveLoginSelection(this.sessionToken, token)) {
      this.loginSelection.token = token
      if (!GlobalVariable.DEMO_ORDER_FLOW) {
        const raw = storeManager.getPendingTrade()
        if (raw) {
          const pending = JSON.parse(raw) as PendingLoginSelection
          const accountId = this.user.id || account
          if (pending.accountId && pending.accountId !== accountId) {
            void storeManager.clearPendingTrade(pending.requestKey || '')
          } else {
            pending.accountId = accountId
            void storeManager.savePendingTrade(JSON.stringify(pending))
          }
        }
      }
    } else {
      this.loginSelection = undefined
      if (!GlobalVariable.DEMO_ORDER_FLOW && this.sessionAccount && account && account !== this.sessionAccount) {
        const raw = storeManager.getPendingTrade()
        if (raw) void storeManager.clearPendingTrade((JSON.parse(raw) as PendingLoginSelection).requestKey || '')
      }
    }
    this.sessionToken = token; this.sessionAccount = account
    this.addRequestKey = ''; this.addRequestSignature = ''; this.navigatingPurchase = false
    this.pageGeneration++; this.detailSequence++; this.evaluationRequestId++
    this.resetInteractions()
    this.goods = {} as Goods
    this.isFavorite = false; this.evaluations = []; this.evaluationCount = 0; this.evaluationLoading = false
    return true
  }
  private resetInteractions(): void {
    this.loading = false; this.favoriteSaving = false; this.detailReady = false; this.detailFailed = false
    this.showSheet = false; this.showLoadingDialog = false; this.showPreview = false; this.cartAdded = false
    this.previewUrls = []; this.previewIndex = 0; this.count = 1; this.sku = normalizeSkuSelection()
  }
  private isCurrentSession(generation: number, token: string): boolean {
    const current: HDMUser | undefined = auth.getUserInfo()
    return this.isPageActive && generation === this.pageGeneration && token === this.sessionToken &&
      token === (this.user.token || '') && token === (current?.token || '') &&
      this.sessionAccount === (this.user.account || '') && this.sessionAccount === (current?.account || '')
  }
  private isCurrentGoods(generation: number, token: string, sequence: number, goodsId: string): boolean {
    return this.isCurrentSession(generation, token) && sequence === this.detailSequence &&
      goodsId === this.goods.id && goodsId === this.getGoodsFromNavigation()?.id
  }

  // 接收上一页商品 → 重新取最新详情 → 加载评价并记录足迹。
  // async 方法会先执行到 await；等待接口期间，页面仍可构建并显示加载提示。
  async getDetailData(): Promise<void> {
    this.synchronizeSession()
    const generation: number = this.pageGeneration, token: string = this.sessionToken
    if (!this.isCurrentSession(generation, token) || this.loading || this.favoriteSaving) return
    const sequence: number = ++this.detailSequence
    let loginSelection: PendingLoginSelection | undefined = this.loginSelection
    if (!GlobalVariable.DEMO_ORDER_FLOW) {
      loginSelection = undefined
      try {
        const raw = storeManager.getPendingTrade()
        if (raw) {
          const stored = JSON.parse(raw) as PendingLoginSelection
          if (isPendingTradeValid(stored, Date.now(), this.user.id || this.user.account || '')) loginSelection = stored
          else { loginSelection = undefined; void storeManager.clearPendingTrade(stored.requestKey || '') }
        }
      } catch { }
    }
    this.evaluationRequestId++
    this.evaluations = []; this.evaluationCount = 0; this.evaluationLoading = false
    this.detailReady = false
    this.detailFailed = false
    this.showSheet = false
    this.showPreview = false
    this.count = 1
    this.sku = normalizeSkuSelection()
    this.loadingTitle = '加载中...'
    this.showLoadingDialog = true
    let goodsId: string = ''
    try {
      const navigationGoods = this.getGoodsFromNavigation()
      if (navigationGoods && navigationGoods.id) {
        goodsId = navigationGoods.id
        this.goods = navigationGoods // 上一页只提供入口信息，下面还要重新查询详情。
        this.isFavorite = localGoodsStore.isFavorite(navigationGoods.id)
      } else {
        this.goods = {} as Goods
        this.isFavorite = false
        this.detailFailed = true
        this.safeToast('商品信息加载失败，请返回重试')
        return
      }
      const detail = await getDetailAPI(navigationGoods)
      if (!this.isCurrentGoods(generation, token, sequence, goodsId)) {
        return
      }
      if (detail.id !== goodsId) throw new Error('商品详情与入口商品不匹配')
      this.goods = detail
      this.detailReady = detail.available === false || !!detail.skus?.some(item => !isFallbackSkuId(item.id))
      this.detailFailed = !this.detailReady
      if (loginSelection && (!token || loginSelection.token === token || loginSelection.action)) {
        const restored = restoreLoginSelection(loginSelection, detail, GlobalVariable.DEMO_ORDER_FLOW)
        this.loginSelection = undefined
        this.sku = token ? restored.sku : normalizeSkuSelection(loginSelection.sku)
        this.count = token ? restored.count : loginSelection.count
        this.goods.specs = restored.specs
        this.showSheet = this.detailReady && (restored.invalid || !token || GlobalVariable.DEMO_ORDER_FLOW)
        if (!token || restored.invalid) {
          if (loginSelection.requestKey) await storeManager.clearPendingTrade(loginSelection.requestKey)
          if (restored.invalid && token) this.safeToast('商品规格或价格已变化，请重新选择')
        } else if (loginSelection.action && loginSelection.requestKey) {
          const accountId = this.user.id || this.user.account || ''
          if (!isPendingTradeValid(loginSelection, Date.now(), accountId)) {
            await storeManager.clearPendingTrade(loginSelection.requestKey)
          } else {
            loginSelection.accountId = accountId
            await storeManager.savePendingTrade(JSON.stringify(loginSelection))
            if (!this.isCurrentGoods(generation, token, sequence, goodsId)) return
            if (loginSelection.action === 'cart') {
              await this.submitCartSelection(loginSelection.sku.id, loginSelection.requestKey)
              if (!this.addOutcomeUnknown) await storeManager.clearPendingTrade(loginSelection.requestKey)
            } else {
              await storeManager.clearPendingTrade(loginSelection.requestKey)
              if (this.isCurrentGoods(generation, token, sequence, goodsId)) this.openBuyNow(loginSelection.sku.id, loginSelection.count)
            }
          }
        }
      }
      if (!this.isCurrentGoods(generation, token, sequence, goodsId)) return
      this.isFavorite = localGoodsStore.isFavorite(this.goods.id)
      this.loadEvaluations(this.goods.id)
      try {
        await localGoodsStore.recordHistory(this.goods)
      } catch {
        // 足迹写入失败不应阻断商品详情主流程。
      }
    } catch (error) {
      if (!this.isCurrentGoods(generation, token, sequence, goodsId)) {
        return
      }
      const status = checkoutFailure(error as Error).status
      if (loginSelection?.requestKey && status >= 400 && status < 500 && status !== 401) {
        void storeManager.clearPendingTrade(loginSelection.requestKey)
      }
      this.detailFailed = true
      this.loginSelection = undefined
      if (this.goods.id) {
        // 失败时保留入口商品的备用展示，同时明确提示失败；备用规格仍禁止购买。
        this.goods = generateFallbackGoods(this.goods)
        this.safeToast('商品详情加载失败，当前仅展示备用信息，请返回重试')
      } else {
        this.safeToast('商品信息加载失败，请返回重试')
      }
    } finally {
      if (this.isCurrentSession(generation, token) && sequence === this.detailSequence) {
        this.showLoadingDialog = false
      }
    }
  }

  aboutToDisappear(): void {
    this.loginSelection = undefined
    this.isPageActive = false
    this.pageGeneration++
    this.detailSequence++
    this.evaluationRequestId++
    this.resetInteractions()
    this.navigatingPurchase = false
    this.evaluationLoading = false
  }

  private hideGoods(): void {
    const selection: PendingLoginSelection | undefined = this.loginSelection
    this.aboutToDisappear()
    this.loginSelection = selection
  }

  // 取最近一次进入详情页的参数；兼容旧入口传“商品数组”和新入口传“单件商品”。
  private getGoodsFromNavigation(): Goods | undefined {
    const navigationEntries = this.stackPath.getParamByName(PAGE_PATH.GOODS_PAGE) as Array<Goods | Array<Goods>>
    const latestEntry = navigationEntries.length > 0 ? navigationEntries[navigationEntries.length - 1] : undefined
    return Array.isArray(latestEntry) ? latestEntry[0] : latestEntry
  }

  private openPreview(urls: string[], activeIndex: number): void {
    this.previewUrls = urls.slice()
    this.previewIndex = activeIndex
    this.showPreview = true
  }

  private async loadEvaluations(goodsId: string): Promise<void> {
    const generation: number = this.pageGeneration, token: string = this.sessionToken, sequence: number = this.detailSequence
    if (!goodsId || !this.isCurrentGoods(generation, token, sequence, goodsId)) {
      return
    }
    const requestId: number = ++this.evaluationRequestId
    this.evaluationLoading = true
    this.evaluations = []
    this.evaluationCount = 0
    try {
      const result = await getGoodsEvaluationsAPI(goodsId)
      if (requestId !== this.evaluationRequestId || !this.isCurrentGoods(generation, token, sequence, goodsId)) {
        return
      }
      this.evaluations = result.items || []
      this.evaluationCount = result.counts || this.evaluations.length
      Logger.info(`[GoodsView] loadEvaluations goodsId=${goodsId} counts=${this.evaluationCount} items=${this.evaluations.length}`)
    } catch {
      if (requestId === this.evaluationRequestId && this.isCurrentGoods(generation, token, sequence, goodsId)) {
        this.evaluations = []
        this.evaluationCount = 0
        this.safeToast('商品评价加载失败，请稍后重试')
      }
    } finally {
      if (requestId === this.evaluationRequestId && this.isCurrentGoods(generation, token, sequence, goodsId)) {
        this.evaluationLoading = false
      }
    }
  }

  @Builder
  CustomTitleBuilder() {
    Row() {
      Row({ space: 6 }) {
        ForEach(this.tabs, (item: string, index: number) => {
          Text(item)
            .fontColor(this.activeIndex === index ? $r("[ui_components].color.black") : $r("[ui_components].color.gray"))
            .onClick(() => {
              this.activeIndex = index
              this.scroller.scrollToIndex(index)
            })
        })
      }

      // 楼层切换
      Image($r('[ui_components].media.ic_public_shared'))
        .iconButton()
    }
    .justifyContent(FlexAlign.SpaceBetween)
    .width("100%")
    .padding({
      left: 40,
      right: 40
    })
  }

  // 交易前校验只负责确认当前操作具备真实交易条件。
  private validateCartSelection(): string | undefined {
    if (!this.isCurrentGoods(this.pageGeneration, this.sessionToken, this.detailSequence, this.goods.id)) return undefined
    if (!this.detailReady || this.loading) {
      this.safeToast(this.detailFailed ? '详情或规格未更新，请重试后再购买' : '正在更新商品资料，请稍候')
      return undefined
    }
    if (!this.canPurchase()) { this.safeToast(this.unavailableText()); return undefined }
    if (!this.sku.id) {
      this.safeToast('请选择对应的产品规格')
      return undefined
    }
    if (isFallbackSkuId(this.sku.id)) {
      this.safeToast('商品规格加载失败，请返回重试')
      return undefined
    }
    const current: HDMSkuType | undefined = this.goods.skus?.find(item => item.id === this.sku.id)
    if (!current) { this.safeToast('该规格暂不可购买，请选择其他规格'); return undefined }
    if (!current || current.inventory <= 0 || !Number.isInteger(this.count) || this.count < 1 ||
      this.count > 999 || this.count > current.inventory) {
      this.safeToast('请选择有库存的规格和有效购买数量')
      return undefined
    }
    return this.sku.id
  }

  private async requestGuestTrade(action: 'cart' | 'buy-now'): Promise<void> {
    const generation = this.pageGeneration, sequence = this.detailSequence, goodsId = this.goods.id
    const selection: PendingLoginSelection = { goodsId, sku: normalizeSkuSelection(this.sku), count: this.count,
      token: '', action, requestKey: util.generateRandomUUID(true), created: Date.now(), accountId: '', entry: this.getGoodsFromNavigation() }
    this.loading = true
    try {
      if (!GlobalVariable.DEMO_ORDER_FLOW) await storeManager.savePendingTrade(JSON.stringify(selection))
      if (!this.isCurrentGoods(generation, '', sequence, goodsId)) return
      if (GlobalVariable.DEMO_ORDER_FLOW) { selection.action = undefined; selection.requestKey = undefined }
      this.loginSelection = selection
      this.safeToast('您还未登录')
      this.showSheet = false
      this.stackPath.pushPath({ name: PAGE_PATH.LOGIN_PAGE })
    } catch {
      if (this.isCurrentGoods(generation, '', sequence, goodsId)) this.safeToast('保存购买选择失败，请重试')
    } finally {
      if (this.isCurrentGoods(generation, '', sequence, goodsId)) this.loading = false
    }
  }

  // 只有加入购物车成功，调用方才可以继续结算或立即购买。
  private async submitCartSelection(skuId: string, requestKey?: string, openCart: boolean = true): Promise<boolean> {
    if (this.validateCartSelection() !== skuId) return false
    const generation: number = this.pageGeneration, token: string = this.sessionToken
    const sequence: number = this.detailSequence, goodsId: string = this.goods.id, count: number = this.count
    const signature = JSON.stringify({ token, skuId, count })
    if (signature !== this.addRequestSignature || Date.now() - this.addRequestCreated > 30 * 60_000) {
      this.addRequestSignature = signature
      this.addRequestKey = requestKey || util.generateRandomUUID(true)
      this.addRequestCreated = Date.now()
    }
    this.addOutcomeUnknown = false
    const key = requestKey || this.addRequestKey
    this.loadingTitle = "加入中..."
    this.loading = true
    // 加购仅锁定按钮；全屏遮罩会触发详情隐藏并清掉成功提示。
    try {
      try {
        await authCart.addCart({ skuId, count, requestKey: key }, token)
      } catch (error) {
        const status = checkoutFailure(error as Error).status
        if (!this.isCurrentGoods(generation, token, sequence, goodsId) || Date.now() - this.addRequestCreated > 30 * 60_000 ||
          (status >= 400 && status < 500)) throw error as Error
        await authCart.addCart({ skuId, count, requestKey: key }, token)
      }
      if (!this.isCurrentGoods(generation, token, sequence, goodsId)) return false
      this.addRequestKey = ''; this.addRequestSignature = ''
      this.safeToast('已加入购物车')
      this.showSheet = false
      this.cartAdded = true
      return true
    } catch (error) {
      const status = checkoutFailure(error as Error).status
      if (this.isCurrentGoods(generation, token, sequence, goodsId)) {
        this.addOutcomeUnknown = status === 0 || status >= 500
        if (status === 409) {
          this.addRequestKey = ''; this.addRequestSignature = ''
          if (checkoutFailure(error as Error).reason === 'PRODUCT_UNAVAILABLE') {
            this.loading = false; this.showLoadingDialog = false; this.showSheet = false
            await this.getDetailData()
            if (this.isPageActive && this.sessionToken === token && this.goods.id === goodsId) this.safeToast(this.unavailableText() || '该规格暂不可购买，请选择其他规格')
          } else this.safeToast('库存不足，请重新选择数量')
        } else this.safeToast('加入购物车失败，请稍后重试')
      }
      return false
    } finally {
      if (this.isCurrentGoods(generation, token, sequence, goodsId)) {
        this.loading = false
        this.showLoadingDialog = false
      }
    }
  }

  // 加入购物车
  async addToCart(openCart: boolean = true): Promise<boolean> {
    const skuId: string | undefined = this.validateCartSelection()
    if (!skuId) {
      return false
    }
    if (!auth.getUserInfo()?.token) {
      await this.requestGuestTrade('cart')
      return false
    }
    return this.submitCartSelection(skuId, undefined, openCart)
  }

  private openBuyNow(skuId: string, count: number): void {
    if (this.navigatingPurchase) return
    this.navigatingPurchase = true
    this.showSheet = false
    const selection: CheckoutSelection = { skuId, count }
    this.stackPath.pushPath({ name: PAGE_PATH.CHECK_ORDER_PAGE, param: selection })
  }

  // 快速购买
  async buyQuickly() {
    const skuId = this.validateCartSelection()
    if (!skuId || this.navigatingPurchase) return
    if (!auth.getUserInfo()?.token) {
      await this.requestGuestTrade('buy-now')
      return
    }
    if (GlobalVariable.DEMO_ORDER_FLOW) {
      const added = await this.addToCart(false)
      if (added) this.openBuyNow(skuId, this.count)
      return
    }
    this.openBuyNow(skuId, this.count)
  }

  async toggleFavorite(): Promise<void> {
    const generation: number = this.pageGeneration, token: string = this.sessionToken
    const sequence: number = this.detailSequence, goodsId: string = this.goods.id
    if (!goodsId || !this.detailReady || this.favoriteSaving || !this.isCurrentGoods(generation, token, sequence, goodsId)) {
      return
    }
    this.favoriteSaving = true
    try {
      const favorite: boolean = await localGoodsStore.toggleFavorite(this.goods)
      if (!this.isCurrentGoods(generation, token, sequence, goodsId)) return
      this.isFavorite = favorite
      this.safeToast(this.isFavorite ? '收藏成功' : '已取消收藏')
    } catch {
      if (this.isCurrentGoods(generation, token, sequence, goodsId)) this.safeToast('收藏操作失败，请稍后重试')
    } finally {
      if (this.isCurrentGoods(generation, token, sequence, goodsId)) this.favoriteSaving = false
    }
  }

  private canPurchase(): boolean {
    return this.detailReady && this.goods.status !== 'off' && this.goods.available !== false &&
      !!this.goods.skus?.some(item => !isFallbackSkuId(item.id))
  }
  private unavailableText(): string {
    if (this.goods.status === 'off') return '商品已下架，暂时无法购买'
    if (this.goods.available === false || !this.goods.skus?.length) return '暂无可购买规格'
    return ''
  }

  @Builder
  AddCartBuilder() {
    Column() {
      Text(this.sku.id ? `已选:${this.sku.specsText} ` : "")
        .fontWeight(300)
        .width('100%')
        .fontColor($r('[ui_components].color.black'))
        .fontSize(14)
        .padding({ bottom: 10, right: 50 })
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Row({ space: 10 }) {
        Image(this.sku.picture || this.goods.mainPictures?.[0])
          .alt($r('app.media.ic_sku_img'))
          .width(80)
          .height(80)
          .backgroundColor($r('[ui_components].color.under'))
          .borderRadius(4)
        Column() {
          Row() {
            Text('现价¥')
              .fontSize(14)
              .fontColor($r('[ui_components].color.black'))
              .offset({ y: -4 })
            Text((this.sku.price || this.goods.price || '').toString())
              .fontSize(24)
              .fontColor($r('[ui_components].color.black'))
              .fontWeight(500)
            Text('原价¥' + (this.sku.oldPrice || this.goods.price || ''))
              .fontSize(12)
              .fontColor($r('[ui_components].color.gray'))
              .margin({ left: 10 })
              .offset({ y: -4 })
              .decoration({
                type: TextDecorationType.LineThrough,
                color: $r('[ui_components].color.gray')
              })
          }
          .alignItems(VerticalAlign.Bottom)

          Row({ space: 10 }) {
            // 计数器
            Counter() {
              Text(this.count.toString())
            }
            .enableDec(!this.loading && this.count > 1) // 小于1不能减
            .enableInc(!this.loading && this.sku.id.length > 0 && this.count < Math.min(999, this.getSelectedInventory()))
            .onInc(() => {
              this.count++
            })
            .onDec(() => {
              this.count--
            })

            Text(this.getInventoryText())
              .fontSize(12)
              .fontColor(this.sku.id.length > 0 && this.getSelectedInventory() > 0 ?
                $r('[ui_components].color.gray') : $r('[ui_components].color.red'))
          }
        }
        .height(80)
        .justifyContent(FlexAlign.SpaceBetween)
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')

      Divider()
        .strokeWidth(4)
        .color($r('[ui_components].color.under'))
        .margin({ left: -8, right: -8, top: 13 })

      List() {
        ListItem() {
          // Sku 组件
          HDMSku({
            skus: this.goods.skus ?? [],
            specs: this.goods.specs ?? [],
            onSkuChange: (sku) => {
              if (this.loading || !this.detailReady) return
              this.sku = normalizeSkuSelection(sku)
              if (this.sku.inventory > 0 && this.count > this.sku.inventory) {
                this.count = this.sku.inventory
              }
            }
          })
        }
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)

      Row() {
        Button(this.loading ? '加入中...' : '加入购物袋')
          .buyButton($r('[ui_components].color.black'), true)
          .enabled(!this.loading && this.canPurchase())
          .onClick(async () => {
            // 实现加入购物车逻辑
            await this.addToCart()
          })
        Button('立即购买')
          .buyButton($r('[ui_components].color.red'), false)
          .enabled(!this.loading && this.canPurchase())
          .onClick(async () => {
            await this.buyQuickly() // 立刻购买
          })
      }
      .width('100%')
    }
    .height(600)
    .padding({
      left: 16,
      right: 16,
      top: 16,
      bottom: this.safeBottom || 16
    })
    .zIndex(2)
  }

  build() {
    NavDestination() {
      Stack() {
        Column() {
        HDMNavBar({
          showRightIcon: true,
          // customTitle: () => {
          //   this.CustomTitleBuilder()
          // },
          onLeftClick: () => {
            this.stackPath.pop()
          }
        }) {
          this.CustomTitleBuilder()
        }
        if (this.cartAdded) {
          Row({ space: 12 }) {
            Text('已加入购物车').fontSize(14)
            Button('去购物车').fontSize(14).onClick(() => {
              this.stackPath.pushPath({ name: PAGE_PATH.CART_PAGE, param: true })
            })
          }.padding(8).width('100%')
        }
        if (!this.detailReady) {
          Text(this.detailFailed ? '详情更新失败，当前仅供浏览；点击重试' : '正在更新商品详情与规格')
            .fontSize(12)
            .fontColor($r('[ui_components].color.red'))
            .padding(10)
            .onClick(() => {
              if (this.detailFailed) {
                this.getDetailData()
              }
            })
        }
        if (this.detailReady && this.unavailableText()) {
          Text(this.unavailableText()).fontColor('#B34D36').padding(12)
        }

        Column() {
          List({ scroller: this.scroller }) {
            ListItem() {
              // 商品信息
              GoodsInfo({
                goods: this.goods,
                showSheet: this.showSheet,
                onPreview: (urls: string[], activeIndex: number): void => {
                  this.openPreview(urls, activeIndex)
                }
              })
            }

            ListItem() {
              GoodsComment({
                evaluations: this.evaluations,
                totalCount: this.evaluationCount,
                loading: this.evaluationLoading
              })
            }

            ListItem() {
              // 商品详情
              GoodsDetail({ goods: this.goods })
            }

            ListItem() {
              // 猜你喜欢
              HDMGuess({ loader: getGuessLikeAPI })
            }
          }
          .onScrollIndex((index) => {
            this.activeIndex = index
          })
          .scrollBar(BarState.Off)
          .width('100%')
          .height('100%')
        }
        .layoutWeight(1)
        .backgroundColor($r('[ui_components].color.under'))

        Row() {
          Image($r('[ui_components].media.ic_public_like'))
            .iconButton()
            .fillColor(this.isFavorite ? $r('[ui_components].color.red') : $r('[ui_components].color.black'))
            .accessibilityText(this.isFavorite ? '取消收藏' : '收藏商品')
            .enabled(this.detailReady && !this.favoriteSaving)
            .onClick(() => this.toggleFavorite())
          Image($r('[ui_components].media.ic_public_comment'))
            .iconButton()
            .accessibilityText('联系客服')
            .onClick(() => {
              this.stackPath.pushPath({ name: PAGE_PATH.CUSTOMER_SERVICE_PAGE })
            })
          Badge({
            count: this.cartCount,
            style: {},
            position: { x: 30, y: 4 }
          }) {
            Image($r('[ui_components].media.ic_public_cart'))
              .iconButton()
              .onClick(() => {
                this.stackPath.pushPath({
                  name: PAGE_PATH.CART_PAGE,
                  param: true // 显示返回图标
                })
              })
          }

          Row() {
            Button('加入购物袋')
              .buyButton($r('[ui_components].color.black'), true)
              .enabled(this.canPurchase() && !this.loading)
              .onClick(() => this.showSheet = true)
            Button('立即购买')
              .buyButton($r('[ui_components].color.red'), false)
              .enabled(this.canPurchase() && !this.loading)
              .onClick(async () => {
                if (this.sku.id) {
                  await this.buyQuickly()
                } else {
                  this.showSheet = true
                }
              })
          }
          .layoutWeight(1)
          .padding({ right: 16, left: 6 })
        }
        .height(54)
        .width('100%')
        .margin({ bottom: this.safeBottom })
      }
        .height('100%')
        .bindSheet($$this.showSheet, this.AddCartBuilder(),
          {
            height: SheetSize.FIT_CONTENT,
            backgroundColor: $r('[ui_components].color.white'),
            preferType: SheetType.CENTER
          })
        .bindContentCover($$this.showLoadingDialog, this.LoadingDialogBuilder())

        if (this.showPreview) {
          HDMPreviewImage({
            urls: this.previewUrls,
            activeIndex: this.previewIndex,
            onClose: (): void => {
              this.showPreview = false
            }
          })
            .width('100%')
            .height('100%')
            .zIndex(10)
        }
      }
      .width('100%')
      .height('100%')
    }
    .hideTitleBar(true)
    .onShown(() => this.showGoods())
    .onHidden(() => this.hideGoods())
    .padding({
      top: this.safeTop,
    })
  }
}

@Extend(Image)
function iconButton() {
  .width(24)
  .aspectRatio(1)
  .margin(13)
  .fillColor($r('[ui_components].color.black'))
}

@Extend(Button)
function buyButton(color: ResourceStr, isLeft: boolean) {
  .fontSize(14)
  .height(36)
  .type(ButtonType.Normal)
  .layoutWeight(1)
  .backgroundColor(color)
  .borderRadius({
    topLeft: isLeft ? 18 : 0,
    bottomLeft: isLeft ? 18 : 0,
    topRight: isLeft ? 0 : 18,
    bottomRight: isLeft ? 0 : 18
  })
  .pixelRound({
    end: PixelRoundCalcPolicy.FORCE_CEIL,
    start: PixelRoundCalcPolicy.FORCE_FLOOR
  })
}
