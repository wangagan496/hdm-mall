import { BusinessVariable, GlobalVariable, PAGE_PATH } from 'constants'
import { HDMGoodsItem } from 'models'
import { auth, localGoodsStore } from 'storage'
import { HDMGuess, HDMLoading, HDMLoadingDialog, HDMNavBar, HDMPreviewImage, HDMSku, HDMSkuType } from 'ui_components'
import { authCart } from 'storage'
import { Logger } from 'utils'
import { Goods, GoodsEvaluation } from '../../domain/models'
import { GoodsInfo, GoodsComment, GoodsDetail } from '../components'
import { getDetailAPI, getGoodsEvaluationsAPI } from '../../data/api'
import { isFallbackSkuId } from '../../data/api/mockData'
import { normalizeSkuSelection } from '../../data/api/goodsPresentation'


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
  @State goods: Goods = {} as Goods
  @State activeIndex: number = 0
  @State showSheet: boolean = false
  @State count: number = 1
  @State loading: boolean = false
  @State isFavorite: boolean = false
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
    // 接收并解析数据
    this.getDetailData() // 获取详情数据
  }

  // 生命周期- 父组件 aboutToAppear(同步已经完成/异步) => 父组件的build => 子组件的aboutToAppear（已经有了之前同步设置的数据了-第一次渲染） => 子组件的build =>
  // 同步代码和异步代码 先把异步代码挂起来-先把所有同步的代码执行完毕- 再去执行异步

  // 获取详情
  async getDetailData() {
    this.showLoadingDialog = true
    try {
      const params = this.stackPath.getParamByName(PAGE_PATH.GOODS_PAGE) as Array<Goods | Array<Goods>>
      const lastParam = params.length > 0 ? params[params.length - 1] : undefined
      const source = Array.isArray(lastParam) ? lastParam[0] : lastParam
      if (source && source.id) {
        this.goods = source // 接收上一次的数据
        this.isFavorite = localGoodsStore.isFavorite(source.id)
      } else {
        this.safeToast('商品信息加载失败，请返回重试')
        return
      }
      this.goods = await getDetailAPI(this.goods)
      this.isFavorite = localGoodsStore.isFavorite(this.goods.id)
      this.loadEvaluations(this.goods.id)
      try {
        await localGoodsStore.recordHistory(this.goods)
      } catch {
        // 足迹写入失败不应阻断商品详情主流程。
      }
    } catch {
      this.safeToast('商品信息加载失败，请返回重试')
    } finally {
      this.showLoadingDialog = false
    }
  }

  private openPreview(urls: string[], activeIndex: number): void {
    this.previewUrls = urls.slice()
    this.previewIndex = activeIndex
    this.showPreview = true
  }

  private async loadEvaluations(goodsId: string): Promise<void> {
    if (!goodsId) {
      return
    }
    const requestId: number = ++this.evaluationRequestId
    this.evaluationLoading = true
    this.evaluations = []
    this.evaluationCount = 0
    try {
      const result = await getGoodsEvaluationsAPI(goodsId)
      if (requestId !== this.evaluationRequestId || goodsId !== this.goods.id) {
        return
      }
      this.evaluations = result.items || []
      this.evaluationCount = result.counts || this.evaluations.length
      Logger.info(`[GoodsView] loadEvaluations goodsId=${goodsId} counts=${this.evaluationCount} items=${this.evaluations.length}`)
    } catch {
      if (requestId === this.evaluationRequestId) {
        this.evaluations = []
        this.evaluationCount = 0
      }
    } finally {
      if (requestId === this.evaluationRequestId) {
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

  // 加入购物车
  async addToCart(): Promise<boolean> {
    const user = auth.getUserInfo()
    if (!user || !user.token) {
      this.safeToast('您还未登录')
      this.showSheet = false // 关闭半模态弹窗
      // 到底跳转不跳转登录 取决于产品的运营逻辑
      this.stackPath.pushPath({ name: PAGE_PATH.LOGIN_PAGE })
      return false
    }
    // 此时说明用户是有的
    if (!this.sku.id) {
      this.safeToast('请选择对应的产品规格')
      return false
    }
    if (isFallbackSkuId(this.sku.id)) {
      this.safeToast('商品规格加载失败，请返回重试')
      return false
    }
    this.loadingTitle = "加入中..."
    this.loading = true
    this.showLoadingDialog = true
    try {
      await authCart.addCart({ skuId: this.sku.id, count: this.count })
      this.safeToast('加入购物车成功')
      return true
    } catch {
      this.safeToast('加入购物车失败，请稍后重试')
      return false
    } finally {
      this.loading = false
      this.showLoadingDialog = false
    }
  }

  // 快速购买
  async buyQuickly() {
    const added: boolean = await this.addToCart()
    if (!added) {
      return
    }
    this.showSheet = false // 关闭半模态
    this.stackPath.pushPath({
      name: PAGE_PATH.CHECK_ORDER_PAGE
    }) // 跳转到核对订单页面
  }

  async toggleFavorite(): Promise<void> {
    if (!this.goods.id) {
      return
    }
    try {
      this.isFavorite = await localGoodsStore.toggleFavorite(this.goods)
      this.safeToast(this.isFavorite ? '收藏成功' : '已取消收藏')
    } catch {
      this.safeToast('收藏操作失败，请稍后重试')
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
            .enableDec(this.count > 1) // 小于1不能减
            .enableInc(this.sku.id.length > 0 && this.count < this.getSelectedInventory())
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
          .enabled(!this.loading)
          .onClick(async () => {
            // 实现加入购物车逻辑
            await this.addToCart()
          })
        Button('立即购买')
          .buyButton($r('[ui_components].color.red'), false)
          .enabled(!this.loading)
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
              HDMGuess()
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
              .onClick(() => this.showSheet = true)
            Button('立即购买')
              .buyButton($r('[ui_components].color.red'), false)
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
