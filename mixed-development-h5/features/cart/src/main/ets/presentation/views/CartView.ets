import { HDMConfirm, HDMEmpty, HDMGuess, HDMNavBar } from 'ui_components'
import { CartGoods, CartGoodsModel, HDMUser } from 'models'
import { BusinessVariable, GlobalVariable, PAGE_PATH } from 'constants'
import { getCartListAPI, getGuessLikeAPI } from '../../data/api'
import { CartItem } from '../components'
import { common } from '@kit.AbilityKit'
import { excludeCartItems } from '../utils/CartPresentation'
import { CartOperationHelper as CartOperations } from '../utils/CartOperations'

@Component
export struct CartView {
  // 购物袋流程：加载商品 → 勾选／改数量／删除 → 重算合计 → 进入结算页确认。
  // 本页的“去结算”只打开确认页；真正创建订单在 CheckView.ets。
  @StorageProp(GlobalVariable.USER_INFO_KEY)
  @Watch('reloadForCurrentAccount')
  user: HDMUser = {} as HDMUser
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @State
  cartList: CartGoodsModel[] = []
  @State private cartListRevision: number = 0
  @Consume
  stackPath: NavPathStack
  @State
  showBackIcon: boolean = false
  @State
  isCheckAll: boolean = false
  @State
  allPrice: number = 0
  @State
  deleting: boolean = false
  @State
  updating: boolean = false
  @State
  loading: boolean = false
  @State
  loadFailed: boolean = false
  private loadRequestId: number = 0
  private isPageActive: boolean = true
  private cartToken: string = ''
  private pageVersion: number = 0

  private reloadCartAfterChange: () => void = () => {
    this.loadCartList()
  }

  aboutToAppear(): void {
    this.isPageActive = true
    const params = this.stackPath.getParamByName(PAGE_PATH.CART_PAGE) as boolean[]
    if (params[params.length - 1]) {
      this.showBackIcon = true
    }
    this.loadCartAndListenForChanges()
  }

  aboutToDisappear(): void {
    this.isPageActive = false
    this.loadRequestId++
    this.pageVersion++
    this.loading = false
    this.updating = false
    this.deleting = false
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext
    context.eventHub.off(BusinessVariable.UPDATE_CART_LIST, this.reloadCartAfterChange)
  }

  private loadCartAndListenForChanges(): void {
    this.loadCartList()
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext
    context.eventHub.on(BusinessVariable.UPDATE_CART_LIST, this.reloadCartAfterChange)
  }

  private reloadForCurrentAccount(): void {
    if ((this.user.token || '') !== this.cartToken) {
      void this.loadCartList()
    }
  }

  private isCurrentPage(version: number, token: string): boolean {
    return this.isPageActive && version === this.pageVersion && token === this.user.token
  }

  private isCurrentQuery(requestId: number, token: string): boolean {
    return this.isPageActive && requestId === this.loadRequestId && token === this.user.token
  }

  // 只接收当前账号的最新查询；刷新失败保留已有商品，换账号立即清除旧资料。
  private async loadCartList(): Promise<void> {
    const requestId = ++this.loadRequestId
    const token = this.user.token || ''
    if (token !== this.cartToken) {
      this.cartToken = token
      this.pageVersion++
      this.cartList = []
      this.recalculateCartSummary()
      this.loading = false
      this.loadFailed = false
      this.updating = false
      this.deleting = false
      this.showClearCartConfirm = false
    }
    if (!this.isPageActive || !token) {
      return
    }
    this.loading = true
    this.loadFailed = false
    try {
      const list = await getCartListAPI(token)
      if (!this.isCurrentQuery(requestId, token)) {
        return
      }
      this.cartListRevision++
      this.cartList = list.map((item: CartGoods) => new CartGoodsModel(item))
      this.recalculateCartSummary()
    } catch {
      if (this.isCurrentQuery(requestId, token)) {
        this.loadFailed = true
      }
    } finally {
      if (this.isCurrentQuery(requestId, token)) {
        this.loading = false
      }
    }
  }

  // 合计只计算已勾选商品，供购物袋展示；结算页会重新读取服务端金额。
  private recalculateCartSummary(): void {
    this.isCheckAll = CartOperations.checkIsAllSelected(this.cartList)
    this.allPrice = CartOperations.calculateTotalPrice(this.cartList)
  }

  // 单件勾选：先保存到服务端，成功后由 CartOperations 回写页面状态。
  private async changeGoodsSelection(cart: CartGoodsModel, selected: boolean): Promise<void> {
    if (this.updating || this.deleting || this.loading || this.loadFailed) {
      return
    }
    const version = this.pageVersion
    const token = this.user.token
    this.updating = true
    try {
      await CartOperations.updateCartSelection(cart, selected)
    } catch {
      if (this.isCurrentPage(version, token)) {
        this.getUIContext().getPromptAction().showToast({ message: '选中状态更新失败，请重试' })
      }
    } finally {
      if (this.isCurrentPage(version, token)) {
        this.updating = false
        this.recalculateCartSummary()
      }
    }
  }

  // 修改数量：先保存到服务端；成功才显示新数量，失败保留原数量并提示。
  private async changeGoodsQuantity(cart: CartGoodsModel, requestedQuantity: number): Promise<void> {
    if (this.updating || this.deleting || this.loading || this.loadFailed) {
      return
    }
    const version = this.pageVersion
    const token = this.user.token
    this.updating = true
    try {
      await CartOperations.updateCartCount(cart, requestedQuantity)
    } catch {
      if (this.isCurrentPage(version, token)) {
        this.getUIContext().getPromptAction().showToast({ message: '数量更新失败，请重试' })
      }
    } finally {
      if (this.isCurrentPage(version, token)) {
        this.updating = false
        this.recalculateCartSummary()
      }
    }
  }

  // 保存成功后再更新全选和金额；保存期间不并发修改或进入结算。
  private async toggleAllGoodsSelection(): Promise<void> {
    if (this.updating || this.deleting || this.loading || this.loadFailed || !this.user.token || this.cartList.length === 0) {
      return
    }
    const selected = !this.isCheckAll
    const token = this.user.token
    const version = this.pageVersion
    const list = this.cartList
    this.updating = true
    try {
      await CartOperations.toggleSelectAll(selected)
      // 角标刷新会通知列表重载，已替换的列表以服务端结果为准。
      if (this.isCurrentPage(version, token) && this.cartList === list) {
        this.cartList.forEach(item => item.selected = selected)
        this.recalculateCartSummary()
      }
    } catch {
      if (this.isCurrentPage(version, token)) {
        this.getUIContext().getPromptAction().showToast({ message: '全选状态更新失败，请重试' })
      }
    } finally {
      if (this.isCurrentPage(version, token)) {
        this.updating = false
      }
    }
  }

  // 有选中商品才能去确认地址和金额；这里只跳转，不创建订单、不扣款。
  private openCheckoutPage(): void {
    if (this.updating || this.deleting || this.loading || this.loadFailed) {
      return
    }
    const selectedGoodsCount = this.cartList.filter(item => item.selected).length
    if (selectedGoodsCount === 0) {
      this.getUIContext().getPromptAction().showToast({
        message: '请选择要结算的商品'
      })
      return
    }
    this.stackPath.pushPath({ name: PAGE_PATH.CHECK_ORDER_PAGE })
  }

  // 删除成功后移除页面商品并重算合计；单件删除和清空购物袋共用此流程。
  async deleteCartItems(skuIds: string[], clearAll: boolean = false): Promise<void> {
    if (this.updating || this.deleting || this.loading || this.loadFailed || skuIds.length === 0) {
      return
    }
    const version = this.pageVersion
    const token = this.user.token
    this.deleting = true
    try {
      await CartOperations.deleteCartItems(skuIds)
      if (!this.isCurrentPage(version, token)) {
        return
      }
      this.cartList = excludeCartItems(this.cartList, skuIds)
      this.recalculateCartSummary()
      this.getUIContext().getPromptAction().showToast({
        message: clearAll ? '购物车已清空' : '商品已删除'
      })
    } catch {
      if (!this.isCurrentPage(version, token)) {
        return
      }
      try {
        this.getUIContext().getPromptAction().showToast({
          message: clearAll ? '清空失败，请稍后重试' : '删除失败，请稍后重试'
        })
      } catch {
      }
    } finally {
      if (this.isCurrentPage(version, token)) {
        this.deleting = false
      }
    }
  }

  @Builder
  DeleteBuilder(skuId: string) {
    Text('删除')
      .fontSize(14)
      .width(60)
      .height(112)
      .backgroundColor($r('[ui_components].color.red'))
      .fontColor($r('[ui_components].color.white'))
      .textAlign(TextAlign.Center)
      .onClick(() => {
        this.deleteCartItems([skuId])
      })
  }

  @State showClearCartConfirm: boolean = false

  @Builder
  ClearCartConfirmBuilder() {
    HDMConfirm({
      message: '确定清空购物车中的全部商品吗？',
      onConfirm: async () => {
        if (this.updating || this.deleting || this.loading || this.loadFailed) {
          return
        }
        await this.deleteCartItems(this.cartList.map((item: CartGoodsModel) => item.skuId), true)
        this.showClearCartConfirm = false
      },
      onCancel: () => {
        if (!this.deleting) {
          this.showClearCartConfirm = false
        }
      }
    })
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: '购物袋',
          showLeftIcon: this.showBackIcon,
          onLeftClick: () => {
            this.stackPath.pop()
          }
        })
          .border({
            width: { bottom: 0.5 },
            color: $r('[ui_components].color.border')
          })

        if (this.user.token && this.cartList.length) {
          Row() {
            Text(`共${this.cartList.length}种商品`)
              .fontSize(13)
              .fontColor($r('[ui_components].color.gray'))
            Blank()
            Text(this.deleting ? '处理中…' : '清空购物车')
              .enabled(!this.updating && !this.deleting && !this.loading && !this.loadFailed)
              .fontSize(13)
              .fontColor(this.deleting ? $r('[ui_components].color.gray') : $r('[ui_components].color.red'))
              .height(36)
              .padding({ left: 12, right: 4 })
              .onClick(() => {
                if (!this.deleting) {
                  this.showClearCartConfirm = true
                }
              })
          }
          .height(40)
          .width('100%')
          .padding({ left: 16, right: 16 })
          .backgroundColor($r('[ui_components].color.white'))
        }

        List({ space: 8 }) {
          if (this.user.token) {
            if (this.loading && this.cartList.length === 0) {
              ListItem() {
                LoadingProgress().width(48).color($r('[ui_components].color.red'))
              }
            } else if (this.loadFailed && this.cartList.length === 0) {
              ListItem() {
                HDMEmpty({
                  buttonText: '重新加载',
                  tip: '购物袋加载失败，请稍后重试',
                  onBtnClick: (): void => {
                    void this.loadCartList()
                  }
                })
              }
            } else if (this.cartList.length) {
              if (this.loading || this.loadFailed) {
                ListItem() {
                  Row({ space: 8 }) {
                    Text(this.loading ? '正在刷新购物袋…' : '刷新失败，已保留商品，请重试')
                      .fontSize(13)
                      .layoutWeight(1)
                    if (this.loadFailed) {
                      Button('重新加载')
                        .fontSize(13)
                        .onClick(() => { void this.loadCartList() })
                    }
                  }
                  .padding(12)
                  .width('100%')
                }
              }
              ForEach(this.cartList, (cart: CartGoodsModel) => {
                ListItem() {
                  CartItem({
                    cart: cart,
                    onChangeSelected: async selected => {
                      await this.changeGoodsSelection(cart, selected)
                    },
                    onChangeCount: async count => {
                      await this.changeGoodsQuantity(cart, count)
                    },
                    onDelete: () => {
                      this.deleteCartItems([cart.skuId])
                    }
                  })
                  .enabled(!this.updating && !this.deleting && !this.loading && !this.loadFailed)
                }
                .backgroundColor($r('[ui_components].color.under'))
                .padding({ left: 12, right: 12 })
                .transition({ type: TransitionType.Delete, opacity: 0 })
                .swipeAction({
                  end: this.DeleteBuilder(cart.skuId)
                })
                // 重新加载时绑定新对象；本地勾选和数量变化仍由 @ObjectLink 更新。
              }, (cart: CartGoodsModel) => `${cart.skuId}:${this.cartListRevision}`)
            } else {
              ListItem() {
                HDMEmpty({
                  buttonText: '去逛逛',
                  tip: '购物车空空哒',
                  onBtnClick: () => {
                    const context = this.getUIContext().getHostContext() as common.UIAbilityContext
                    context.eventHub.emit(GlobalVariable.SWITCH_TAB, 0)
                  }
                })
              }
            }
          } else {
            ListItem() {
              HDMEmpty({
                buttonText: '去登录',
                tip: "您当前未登录",
                onBtnClick: () => {
                  this.stackPath.pushPath({
                    name: PAGE_PATH.LOGIN_PAGE
                  })
                }
              })
            }
          }
          ListItem() {
            HDMGuess({ inset: true, loader: getGuessLikeAPI })
              .margin({ top: 4, bottom: 8 })
          }
        }
        .contentStartOffset(8)
        .cachedCount(4)
        .width('100%')
        .layoutWeight(1)
        .scrollBar(BarState.Off)

        if (this.cartList.length) {
          Row() {
            Checkbox()
              .selectedColor($r('[ui_components].color.red'))
              .size({ width: 20, height: 20 })
              .select(this.isCheckAll)
              .enabled(!this.updating && !this.deleting && !this.loading && !this.loadFailed)
              .accessibilityText(this.isCheckAll ? '取消全选' : '全选商品')
              .onClick(async () => {
                await this.toggleAllGoodsSelection()
              })
            Text('全选')
              .fontSize(14)
              .fontColor($r('[ui_components].color.black'))
              .margin({ right: 12 })
            Text('合计')
              .fontSize(14)
              .fontColor($r('[ui_components].color.black'))
              .margin({ right: 4 })
            Text(`¥${this.allPrice.toFixed(2)}`)
              .fontSize(16)
              .fontWeight(500)
              .fontColor($r('[ui_components].color.red'))
              .layoutWeight(1)
            Button('去结算')
              .enabled(!this.updating && !this.deleting && !this.loading && !this.loadFailed)
              .fontSize(14)
              .width(88)
              .height(36)
              .backgroundColor($r('[ui_components].color.red'))
              .onClick(() => {
                this.openCheckoutPage()
              })
          }
          .width('100%')
          .height(50)
          .padding({ left: 16, right: 16 })
          .backgroundColor($r('[ui_components].color.white'))
          .border({
            width: { top: 0.5 },
            color: '#e4e4e4'
          })
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('[ui_components].color.under'))
    }
    .hideTitleBar(true)
    .bindContentCover($$this.showClearCartConfirm, this.ClearCartConfirmBuilder())
  }
}

@Builder
function CartViewBuilder() {
  CartView()
}
