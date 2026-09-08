import { HDMConfirm, HDMEmpty, HDMGuess, HDMNavBar } from 'ui_components'
import { CartGoods, CartGoodsModel, HDMUser } from 'models'
import { BusinessVariable, GlobalVariable, PAGE_PATH } from 'constants'
import { getCartListAPI } from '../../data/api'
import { CartItem } from '../components'
import { common } from '@kit.AbilityKit'
import { excludeCartItems } from '../utils/CartPresentation'
import { CartOperationHelper as CartOperations } from '../utils/CartOperations'

@Component
export struct CartView {
  @StorageProp(GlobalVariable.USER_INFO_KEY)
  user: HDMUser = {} as HDMUser
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @State
  cartList: CartGoodsModel[] = []
  @Consume
  stackPath: NavPathStack
  @State
  showBackIcon: boolean = false
  @State
  isCheckAll: boolean = false
  @State
  allPrice: number = 0
  @State
  isDeleting: boolean = false
  @State
  loading: boolean = false
  @State
  loadFailed: boolean = false

  private cartUpdateCb: () => void = () => {
    this.getCartList()
  }

  aboutToAppear(): void {
    const params = this.stackPath.getParamByName(PAGE_PATH.CART_PAGE) as boolean[]
    if (params[params.length - 1]) {
      this.showBackIcon = true
    }
    this.registerEvent()
  }

  aboutToDisappear(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext
    context.eventHub.off(BusinessVariable.UPDATE_CART_LIST, this.cartUpdateCb)
  }

  registerEvent() {
    this.getCartList()
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext
    context.eventHub.on(BusinessVariable.UPDATE_CART_LIST, this.cartUpdateCb)
  }

  async getCartList() {
    if (this.user.token) {
      this.loading = true
      this.loadFailed = false
      try {
        const list = await getCartListAPI()
        this.cartList = list.map((item: CartGoods) => new CartGoodsModel(item))
        this.refreshCartSummary()
      } catch {
        this.cartList = []
        this.isCheckAll = false
        this.allPrice = 0
        this.loadFailed = true
      } finally {
        this.loading = false
      }
    } else {
      this.cartList = []
      this.isCheckAll = false
      this.allPrice = 0
    }
  }

  refreshCartSummary(): void {
    this.isCheckAll = CartOperations.checkIsAllSelected(this.cartList)
    this.allPrice = CartOperations.calculateTotalPrice(this.cartList)
  }

  async deleteCartItems(skuIds: string[], clearAll: boolean = false): Promise<void> {
    if (this.isDeleting || skuIds.length === 0) {
      return
    }
    this.isDeleting = true
    try {
      await CartOperations.deleteCartItems(skuIds)
      this.cartList = excludeCartItems(this.cartList, skuIds)
      this.refreshCartSummary()
      this.getUIContext().getPromptAction().showToast({
        message: clearAll ? '购物车已清空' : '商品已删除'
      })
    } catch {
      try {
        this.getUIContext().getPromptAction().showToast({
          message: clearAll ? '清空失败，请稍后重试' : '删除失败，请稍后重试'
        })
      } catch {
      }
    } finally {
      this.isDeleting = false
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

  clearCartDialog: CustomDialogController = new CustomDialogController({
    builder: HDMConfirm({
      message: '确定清空购物车中的全部商品吗？',
      onConfirm: () => {
        this.deleteCartItems(this.cartList.map((item: CartGoodsModel) => item.skuId), true)
      }
    }),
    customStyle: true,
    alignment: DialogAlignment.Center
  })

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
            color: '#e4e4e4'
          })

        if (this.user.token && this.cartList.length) {
          Row() {
            Text(`共${this.cartList.length}种商品`)
              .fontSize(13)
              .fontColor($r('[ui_components].color.gray'))
            Blank()
            Text(this.isDeleting ? '处理中…' : '清空购物车')
              .fontSize(13)
              .fontColor(this.isDeleting ? $r('[ui_components].color.gray') : $r('[ui_components].color.red'))
              .height(36)
              .padding({ left: 12, right: 4 })
              .onClick(() => {
                if (!this.isDeleting) {
                  this.clearCartDialog.open()
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
            if (this.loading) {
              ListItem() {
                LoadingProgress().width(48).color($r('[ui_components].color.red'))
              }
            } else if (this.loadFailed) {
              ListItem() {
                HDMEmpty({
                  buttonText: '重新加载',
                  tip: '购物袋加载失败，请稍后重试',
                  onBtnClick: (): void => {
                    void this.getCartList()
                  }
                })
              }
            } else if (this.cartList.length) {
              ForEach(this.cartList, (cart: CartGoodsModel) => {
                ListItem() {
                  CartItem({
                    cart: cart,
                    onChangeSelected: async selected => {
                      try {
                        await CartOperations.updateCartSelection(cart, selected)
                      } catch {
                        // 更新失败：本地状态未变，仅提示，界面与服务端保持一致
                        this.getUIContext().getPromptAction().showToast({ message: '选中状态更新失败，请重试' })
                      }
                      this.refreshCartSummary()
                    },
                    onChangeCount: async count => {
                      try {
                        await CartOperations.updateCartCount(cart, count)
                      } catch {
                        this.getUIContext().getPromptAction().showToast({ message: '数量更新失败，请重试' })
                      }
                      this.refreshCartSummary()
                    },
                    onDelete: () => {
                      this.deleteCartItems([cart.skuId])
                    }
                  })
                }
                .backgroundColor($r('[ui_components].color.under'))
                .padding({ left: 12, right: 12 })
                .transition({ type: TransitionType.Delete, opacity: 0 })
                .swipeAction({
                  end: this.DeleteBuilder(cart.skuId)
                })
              }, (cart: CartGoods) => cart.skuId + "_" + cart.selected)
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
            HDMGuess({ inset: true })
              .margin({ top: 4, bottom: 8 })
          }
        }
        .contentStartOffset(8)
        .width('100%')
        .layoutWeight(1)
        .scrollBar(BarState.Off)

        if (this.cartList.length) {
          Row() {
            Checkbox()
              .selectedColor($r('[ui_components].color.red'))
              .size({ width: 20, height: 20 })
              .select(this.isCheckAll)
              .accessibilityText(this.isCheckAll ? '取消全选' : '全选商品')
              .onClick(async () => {
                this.isCheckAll = !this.isCheckAll
                this.cartList.forEach(item => item.selected = this.isCheckAll)
                this.refreshCartSummary()
                await CartOperations.toggleSelectAll(this.isCheckAll)
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
              .fontSize(14)
              .width(88)
              .height(36)
              .backgroundColor($r('[ui_components].color.red'))
              .onClick(() => {
                const selectedCount = this.cartList.filter(item => item.selected).length
                if (selectedCount === 0) {
                  this.getUIContext().getPromptAction().showToast({
                    message: '请选择要结算的商品'
                  })
                  return
                }
                this.stackPath.pushPath({
                  name: PAGE_PATH.CHECK_ORDER_PAGE
                })
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
  }
}

@Builder
function CartViewBuilder() {
  CartView()
}
