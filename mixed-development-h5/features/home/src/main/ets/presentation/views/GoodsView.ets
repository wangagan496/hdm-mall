import { BusinessVariable, GlobalVariable, PAGE_PATH } from 'constants'
import { HDMGoodsItem, HDMUser } from 'models'
import { auth, localGoodsStore } from 'storage'
import { HDMGuess, HDMLoading, HDMLoadingDialog, HDMNavBar, HDMPreviewImage, HDMSku, HDMSkuType } from 'ui_components'
import { authCart } from 'storage'
import { Logger } from 'utils'
import { Goods, GoodsEvaluation } from '../../domain/models'
import { GoodsInfo, GoodsComment, GoodsDetail } from '../components'
import { getDetailAPI, getGoodsEvaluationsAPI, getGuessLikeAPI } from '../../data/api'
import { generateFallbackGoods, isFallbackSkuId } from '../../data/api/mockData'
import { normalizeSkuSelection } from '../../data/api/goodsPresentation'
import { canPreserveLoginSelection, PendingLoginSelection, restoreLoginSelection } from '../../data/api/loginSkuSelection'


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
    } else {
      this.loginSelection = undefined
    }
    this.sessionToken = token; this.sessionAccount = account
    this.pageGeneration++; this.detailSequence++; this.evaluationRequestId++
    this.resetInteractions()
    this.goods = {} as Goods
    this.isFavorite = false; this.evaluations = []; this.evaluationCount = 0; this.evaluationLoading = false
    return true
  }
  private resetInteractions(): void {
    this.loading = false; this.favoriteSaving = false; this.detailReady = false; this.detailFailed = false
    this.showSheet = false; this.showLoadingDialog = false; this.showPreview = false
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
    const loginSelection: PendingLoginSelection | undefined = this.loginSelection
    if (!token) this.loginSelection = undefined
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
      this.detailReady = !!detail.skus?.some(item => !isFallbackSkuId(item.id))
      this.detailFailed = !this.detailReady
      if (loginSelection && token && loginSelection.token === token) {
        const restored = restoreLoginSelection(loginSelection, detail)
        this.loginSelection = undefined
        this.sku = restored.sku
        this.count = restored.count
        this.goods.specs = restored.specs
        this.showSheet = this.detailReady
        if (restored.invalid) this.safeToast('原选规格或数量已失效，请重新选择')
      }
      this.isFavorite = localGoodsStore.isFavorite(this.goods.id)
      this.loadEvaluations(this.goods.id)
      try {
        await localGoodsStore.recordHistory(this.goods)
      } catch {
        // 足迹写入失败不应阻断商品详情主流程。
      }
    } catch {
      if (!this.isCurrentGoods(generation, token, sequence, goodsId)) {
        return
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
    const user = auth.getUserInfo()
    if (!user || !user.token) {
      this.loginSelection = { goodsId: this.goods.id, sku: normalizeSkuSelection(this.sku), count: this.count, token: '' }
      this.safeToast('您还未登录')
      this.showSheet = false // 关闭半模态弹窗
      this.stackPath.pushPath({ name: PAGE_PATH.LOGIN_PAGE })
      return undefined
    }
    if (!this.sku.id) {
      this.safeToast('请选择对应的产品规格')
      return undefined
    }
    if (isFallbackSkuId(this.sku.id)) {
      this.safeToast('商品规格加载失败，请返回重试')
      return undefined
    }
    const current: HDMSkuType | undefined = this.goods.skus?.find(item => item.id === this.sku.id)
    if (!current || current.inventory <= 0 || !Number.isInteger(this.count) || this.count < 1 ||
      this.count > 999 || this.count > current.inventory) {
      this.safeToast('请选择有库存的规格和有效购买数量')
      return undefined
    }
    return this.sku.id
  }

  // 只有加入购物车成功，调用方才可以继续结算或立即购买。
  private async submitCartSelection(skuId: string): Promise<boolean> {
    if (this.validateCartSelection() !== skuId) return false
    const generation: number = this.pageGeneration, token: string = this.sessionToken
    const sequence: number = this.detailSequence, goodsId: string = this.goods.id, count: number = this.count
    this.loadingTitle = "加入中..."
    this.loading = true
    this.showLoadingDialog = true
    try {
      await authCart.addCart({ skuId, count }, token)
      if (!this.isCurrentGoods(generation, token, sequence, goodsId)) return false
      this.safeToast('加入购物车成功')
      return true
    } catch {
      if (this.isCurrentGoods(generation, token, sequence, goodsId)) this.safeToast('加入购物车失败，请稍后重试')
      return false
    } finally {
      if (this.isCurrentGoods(generation, token, sequence, goodsId)) {
        this.loading = false
        this.showLoadingDialog = false
      }
    }
  }

  // 加入购物车
  async addToCart(): Promise<boolean> {
    const skuId: string | undefined = this.validateCartSelection()
    if (!skuId) {
      return false
    }
    return this.submitCartSelection(skuId)
  }

  // 快速购买
  async buyQuickly() {
    const generation: number = this.pageGeneration, token: string = this.sessionToken
    const sequence: number = this.detailSequence, goodsId: string = this.goods.id
    const added: boolean = await this.addToCart()
    if (!added || !this.isCurrentGoods(generation, token, sequence, goodsId)) {
      return
    }
    this.showSheet = false // 关闭半模态
    this.stackPath.pushPath({
      name: PAGE_PATH.CHECK_ORDER_PAGE
    }) // 跳转到核对订单页面
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
          .enabled(!this.loading && this.detailReady)
          .onClick(async () => {
            // 实现加入购物车逻辑
            await this.addToCart()
          })
        Button('立即购买')
          .buyButton($r('[ui_components].color.red'), false)
          .enabled(!this.loading && this.detailReady)
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
              .enabled(this.detailReady && !this.loading)
              .onClick(() => this.showSheet = true)
            Button('立即购买')
              .buyButton($r('[ui_components].color.red'), false)
              .enabled(this.detailReady && !this.loading)
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
