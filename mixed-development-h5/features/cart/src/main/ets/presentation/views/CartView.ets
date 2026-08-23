import { authCart } from 'storage'
import { HDMConfirm, HDMEmpty, HDMGuess, HDMNavBar } from 'ui_components'
import { CartGoods, CartGoodsModel, HDMUser, UpdateCartParams } from 'models'
import { BusinessVariable, GlobalVariable, PAGE_PATH } from 'constants'
import { delCart, getCartListAPI, selectOrUnSelect, updateCart } from '../../data/api'
import { CartItem } from '../components'
import { common } from '@kit.AbilityKit'
import { excludeCartItems } from '../utils/CartPresentation'

@Component
export struct CartView {
  // 用户信息
  @StorageProp(GlobalVariable.USER_INFO_KEY)
  user: HDMUser = {} as HDMUser
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  // 商品信息
  @State
  cartList: CartGoodsModel[] = []
  // 页面栈
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

  // 注册事件
  registerEvent() {
    this.getCartList()
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext
    context.eventHub.on(BusinessVariable.UPDATE_CART_LIST, this.cartUpdateCb)
  }

  calcAllPrice() {
    this.allPrice = this.cartList.filter(item => item.selected)
      .reduce((preValue: number, item: CartGoodsModel) => {
        return preValue + item.price * item.count
      }, 0)
  }

  // 获取购物车列表
  async getCartList() {
    if (this.user.token) {
      const list = await getCartListAPI()
      // 对每个购物车对象进行的new
      // this.cartList = list
      this.cartList = list.map((item: CartGoods) => new CartGoodsModel(item))
      this.refreshCartSummary()
    } else {
      this.cartList = []
      this.isCheckAll = false
      this.allPrice = 0
    }
  }

  checkAllIsSelect() {
    this.isCheckAll = this.cartList.length > 0 && this.cartList.every(item => item.selected)
  }

  refreshCartSummary(): void {
    this.checkAllIsSelect()
    this.calcAllPrice()
  }

  async deleteCartItems(skuIds: string[], clearAll: boolean = false): Promise<void> {
    if (this.isDeleting || skuIds.length === 0) {
      return
    }
    this.isDeleting = true
    try {
      await delCart({ ids: skuIds })
      this.cartList = excludeCartItems(this.cartList, skuIds)
      this.refreshCartSummary()
      await authCart.updateCartCount()
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
      .height(100)
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

        List() {
          if (this.user.token) {


            if (this.cartList.length) {

              ForEach(this.cartList, (cart: CartGoodsModel) => {
                ListItem() {
                  CartItem({
                    cart: cart,
                    onChangeSelected: async selected => {
                      // 更新数据
                      // 更新页面
                      await updateCart(cart.skuId, {
                        selected, //
                        count: cart.count
                      })
                      authCart.updateCartCount()
                    },
                    onChangeCount: async count => {
                      // 更新数据
                      // 更新页面
                      await updateCart(cart.skuId, {
                        selected: cart.selected, //
                        count
                      })
                      // 服务器已经更新成功
                      authCart.updateCartCount()

                    },
                    onDelete: () => {
                      this.deleteCartItems([cart.skuId])
                    }
                  })
                }
                .backgroundColor($r('[ui_components].color.under'))
                .padding({ left: 8, right: 8 })
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
                    // emitter.emit(GlobalVariable.SWITCH_TAB, {
                    //   data: {
                    //     index: 0
                    //   }
                    // })
                    const context = this.getUIContext().getHostContext() as common.UIAbilityContext
                    context.eventHub.emit(GlobalVariable.SWITCH_TAB, 0)
                  }
                })
              }
            }
          } else {
            // 未登录
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
            HDMGuess()
              .margin({ top: 8, bottom: 8 })
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
              .select(this.isCheckAll)
              .onClick(async () => {
                // 点击全选中/全取消
                this.isCheckAll = !this.isCheckAll
                this.cartList.forEach(item => item.selected = this.isCheckAll) // 客户端变化
                this.refreshCartSummary()
                // 服务器也变化
                const selectAllParams: UpdateCartParams = { selected: this.isCheckAll, count: 0 }
                await selectOrUnSelect(selectAllParams)
                authCart.updateCartCount()
                // if(this.isCheckAll) {
                //   // 所有的都选中
                //   this.cartList.forEach(item => item.selected = true)
                // }else {
                //   // 所有的都取消
                //   this.cartList.forEach(item => item.selected = false)
                //
                // }
              })
            Text('全选')
              .fontSize(14)
              .fontColor($r('[ui_components].color.black'))
              .margin({ right: 20 })
            Text('合计:')
              .fontSize(14)
              .fontColor($r('[ui_components].color.black'))
              .margin({ right: 2 })
            Text(this.allPrice.toFixed(2))
              .fontSize(16)
              .fontWeight(500)
              .fontColor($r('[ui_components].color.red'))
              .layoutWeight(1)
            Button('去结算')
              .fontSize(14)
              .height(36)
              .backgroundColor($r('[ui_components].color.red'))// .enabled(this.allPrice > 0)
              .enabled(this.cartList.some(item => item.selected))
              .onClick(() => {
                this.stackPath.pushPath({
                  name: PAGE_PATH.CHECK_ORDER_PAGE
                })
              })
          }
          .height(50)
          .width('100%')
          .backgroundColor($r('[ui_components].color.white'))
          .border({
            width: { top: 0.5, bottom: 0.5 },
            color: '#e4e4e4'
          })
          .padding({ left: 16, right: 16 })
        }
      }
      .height('100%')
      .width('100%')
      .backgroundColor($r('[ui_components].color.under'))
      .padding({
        top: this.topHeight
      })
    }
    .hideTitleBar(true)
  }
}


@Builder
function CartViewBuilder() {
  CartView()
}
