import { HDMCell, HDMNavBar } from 'ui_components'
import { AddressItem, OrderGoodsItem, Summary } from 'models'
import { BusinessVariable, GlobalVariable, PAGE_PATH } from 'constants'
import { authCart } from 'storage'
import { emitter } from '@kit.BasicServicesKit'
import { createOrderAPI, getPreOrderAPI } from '../../data/api'
import { normalizeCheckoutAddress } from '../utils/CartPresentation'

@Builder
function CheckViewBuilder() {
  CheckView()
}

@Component
export struct CheckView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  // 商品列表
  @State goodsList: OrderGoodsItem[] = []
  // 地址
  @State addressList: AddressItem[] = []
  // 摘要
  @State summary: Summary = {
    discountPrice: 0,
    goodsCount: 0,
    postFee: 0,
    totalPayPrice: 0,
    totalPrice: 0
  }
  // 结算页弹层
  @State showSheet: boolean = false
  @State sheetMode: number = 0
  // 支付渠道
  @State payChannel: number = 1
  // 地址 id
  @State addressId: string = ''
  // 是否 loading
  @State loading: boolean = false
  @Consume
  stackPath: NavPathStack

  private readonly addressUpdatedCb: () => void = () => {
    this.getPreOrder()
  }

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  async submitOrder() {
    if (this.payChannel !== 1) {
      this.safeToast('暂不支持该支付方式')
      return
    }
    if (!this.addressId) {
      this.safeToast('未选择收货地址')
      return
    }
    this.loading = true
    try {
      // 创建订单
      const result = await createOrderAPI({
        payChannel: this.payChannel,
        payType: 1,
        buyerMessage: '',
        addressId: this.addressId,
        goods: this.goodsList,
        deliveryTimeType: 1
      })
      authCart.updateCartCount()
      this.showSheet = false
      this.stackPath.pushPath({
        name: PAGE_PATH.PAY_PAGE,
        param: result.id
      })
    } catch {
      this.safeToast('提交订单失败，请稍后重试')
    } finally {
      this.loading = false
    }
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
      }
      .layoutWeight(1)
    }
    .padding({ top: 10, bottom: 10 })
    .border({
      width: { bottom: 0.5 },
      color: '#e4e4e4'
    })
  }

  payChannels = ['支付宝', '微信支付', '华为支付']

  aboutToAppear(): void {
    emitter.on(BusinessVariable.UPDATE_ADDRESS_LIST, this.addressUpdatedCb)
    this.getPreOrder()
  }

  aboutToDisappear(): void {
    emitter.off(BusinessVariable.UPDATE_ADDRESS_LIST, this.addressUpdatedCb)
  }

  async getPreOrder() {
    try {
      const previousAddressId: string = this.addressId
      const result = await getPreOrderAPI()

      // 检查是否有商品数据
      if (!result.goods || result.goods.length === 0) {
        this.safeToast('购物车中没有选中的商品')
        this.stackPath.pop()
        return
      }

      this.addressList = result.userAddresses.map((address: AddressItem) => normalizeCheckoutAddress(address))
      const defaultAddress: AddressItem | undefined = this.addressList.find((address: AddressItem) => address.isDefault === 0)
      const previousAddress: AddressItem | undefined = this.addressList.find((address: AddressItem) => address.id === previousAddressId)
      this.addressId = previousAddress?.id || defaultAddress?.id || this.addressList[0]?.id || ''
      this.summary = result.summary || {
        discountPrice: 0,
        goodsCount: 0,
        postFee: 0,
        totalPayPrice: 0,
        totalPrice: 0
      }
      this.goodsList = result.goods || []
    } catch {
      this.safeToast('订单信息加载失败，请稍后重试')
    }
  }

  // 半模态
  @Builder
  PaySheetBuilder() {
    Column() {
      Text('¥' + (this.summary.totalPayPrice || 0).toFixed(2))
        .fontSize(20)
        .fontWeight(500)
        .fontColor($r('[ui_components].color.black'))
        .height(50)
        .width('100%')
        .border({
          width: { bottom: 0.5 },
          color: $r('[ui_components].color.under')
        })
      ForEach(this.payChannels, (label: string, index) => {
        CheckCell({
          label: label, checked: this.payChannel === index + 1, onClickBox: () => {
            this.payChannel = index + 1
          }
        })
          .onClick(() => {
            this.payChannel = index + 1
          })
      })
      Row() {
        Button(this.loading ? '提交中...' : '立即支付')
          .width('100%')
          .height(36)
          .fontSize(14)
          .backgroundColor($r('[ui_components].color.red'))
          .enabled(!this.loading)
          .onClick(() => {
            this.submitOrder()
          })
      }
      .height(50)
    }
    .padding({ left: 16, right: 16, bottom: this.safeBottom })
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
            color: '#e4e4e4'
          })
        List() {
          ListItem() {
            ChangeAddressComp({
              addressList: this.addressList,
              selectedAddressId: this.addressId,
              onAddressClick: () => {
                this.sheetMode = 2
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
          Button('提交订单')
            .fontSize(14)
            .height(36)
            .backgroundColor($r('[ui_components].color.red'))
            .onClick(() => {
              this.sheetMode = 1
              this.showSheet = true
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
      .bindSheet($$this.showSheet, this.SheetBuilder(), {
        title: {
          title: this.sheetMode === 1 ? '支付方式' : '选择收货地址',
          subtitle: this.sheetMode === 1 ? '请选择一种支付方式进行付款' : ''
        }, height: SheetSize.FIT_CONTENT, backgroundColor: $r('[ui_components].color.white')
      })
      .padding({
        top: this.safeTop,
      })
    }
    .hideTitleBar(true)
  }

  @Builder
  SheetBuilder() {
    if (this.sheetMode === 1) {
      this.PaySheetBuilder()
    } else {
      this.AddressSelectBuilder()
    }
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
              }
              .width('100%')
              .padding(12)
              .backgroundColor(address.id === this.addressId ? '#FFF5F2' : $r('[ui_components].color.under'))
              .borderRadius(6)
            }
            .onClick(() => {
              this.addressId = address.id
              this.showSheet = false
            })
          }, (address: AddressItem) => address.id)
        }
        .width('100%')
        .height(260)
        .scrollBar(BarState.Off)
      }
      Button('管理收货地址')
        .width('100%')
        .height(40)
        .fontSize(14)
        .backgroundColor($r('[ui_components].color.under'))
        .fontColor($r('[ui_components].color.text'))
        .onClick(() => {
          this.showSheet = false
          this.stackPath.pushPathByName(PAGE_PATH.ADDRESS_PAGE, null)
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
