import { HDMCell, HDMNavBar } from 'ui_components'
import { AddressItem, CreateOrderParams, CreateOrderParamsGoods, HDMUser, OrderGoodsItem, Summary } from 'models'
import { BusinessVariable, GlobalVariable, PAGE_PATH } from 'constants'
import { authCart } from 'storage'
import { emitter } from '@kit.BasicServicesKit'
import { util } from '@kit.ArkTS'
import { createOrderAPI, getPreOrderAPI } from '../../data/api'
import { normalizeCheckoutAddress } from '../utils/CartPresentation'

// 用业务名称区分弹层，避免读者猜测 1、2 各代表什么。
enum CheckoutSheet {
  None = 0,
  Payment = 1,
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
  @Consume
  stackPath: NavPathStack

  private readonly reloadCheckoutAfterAddressChange: () => void = () => {
    this.loadCheckoutPreview()
  }
  // 同账号、同一个结算页实例的下单重试沿用此编号，切换会话才重新生成。
  // 服务端按“用户 + 编号”找回原订单，并核对商品和地址是否与首次提交一致。
  private orderRequestKey: string = util.generateRandomUUID(true)
  private checkoutQuerySequence: number = 0
  private checkoutToken: string = ''
  private pageGeneration: number = 0
  private pageActive: boolean = true
  @State checkoutLoading: boolean = true
  @State checkoutRefreshFailed: boolean = false

  payChannels = ['模拟支付（可邀请亲友代付）']

  aboutToAppear(): void {
    this.pageActive = true
    emitter.on(BusinessVariable.UPDATE_ADDRESS_LIST, this.reloadCheckoutAfterAddressChange)
    this.loadCheckoutPreview()
  }

  aboutToDisappear(): void {
    this.pageActive = false
    this.pageGeneration++
    this.isSubmittingOrder = false
    this.checkoutQuerySequence++
    this.checkoutLoading = true
    this.showSheet = false
    emitter.off(BusinessVariable.UPDATE_ADDRESS_LIST, this.reloadCheckoutAfterAddressChange)
  }

  private reloadForCurrentAccount(): void {
    if ((this.user.token || '') !== this.checkoutToken) {
      this.loadCheckoutPreview()
    }
  }

  private synchronizeCheckoutAccount(): void {
    const token: string = this.user.token || ''
    if (token === this.checkoutToken) {
      return
    }
    this.checkoutToken = token
    this.pageGeneration++
    this.checkoutQuerySequence++
    this.goodsList = []
    this.addressList = []
    this.addressId = ''
    this.addressManuallySelected = false
    this.summary = { discountPrice: 0, goodsCount: 0, postFee: 0, totalPayPrice: 0, totalPrice: 0 }
    this.showSheet = false
    this.activeSheet = CheckoutSheet.None
    this.isSubmittingOrder = false
    this.checkoutRefreshFailed = false
    this.checkoutLoading = false
    this.orderRequestKey = util.generateRandomUUID(true)
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
    const token: string = this.checkoutToken
    const generation: number = this.pageGeneration
    if (!this.isCurrentCheckout(generation, token)) {
      this.checkoutLoading = false
      return
    }
    const sequence: number = ++this.checkoutQuerySequence
    this.checkoutLoading = true
    this.checkoutRefreshFailed = false
    // 金额或商品可能变化，关闭旧支付确认；地址选择仍允许保留。
    if (this.activeSheet === CheckoutSheet.Payment) {
      this.showSheet = false
    }
    try {
      const checkoutPreview = await getPreOrderAPI(token)
      if (sequence !== this.checkoutQuerySequence || !this.isCurrentCheckout(generation, token)) {
        return
      }
      this.checkoutRefreshFailed = false
      if (!checkoutPreview.goods || checkoutPreview.goods.length === 0) {
        this.goodsList = []
        this.summary = { discountPrice: 0, goodsCount: 0, postFee: 0, totalPayPrice: 0, totalPrice: 0 }
        this.showSheet = false
        this.safeToast('购物车中没有选中的商品')
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

  // 第二步：用户在支付方式弹层确认购买，才校验并提交订单。
  private async createOrderAndOpenCashier(): Promise<void> {
    if (!this.canSubmitOrder()) {
      return
    }
    this.isSubmittingOrder = true
    const token: string = this.checkoutToken
    const generation: number = this.pageGeneration
    try {
      const createdOrder = await createOrderAPI(this.buildOrderRequest(), token)
      if (!this.isCurrentCheckout(generation, token)) {
        return
      }
      // 下单后服务端会移除对应购物袋商品；角标刷新不阻塞进入收银台。
      void authCart.updateCartCount()
      this.openCashier(createdOrder.id)
    } catch {
      // 没收到成功回应时仍保留 orderRequestKey，原样重试可找回已创建的订单。
      if (this.isCurrentCheckout(generation, token)) {
        this.safeToast('提交订单失败，请稍后重试')
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
    return true
  }

  private isCheckoutReady(): boolean {
    return this.isCurrentCheckout(this.pageGeneration, this.checkoutToken) &&
      !this.checkoutLoading && !this.checkoutRefreshFailed && this.goodsList.length > 0
  }

  private openPaymentSheet(): void {
    if (!this.canSubmitOrder()) {
      return
    }
    this.activeSheet = CheckoutSheet.Payment
    this.showSheet = true
  }

  // 只提交商品规格、数量和地址等下单信息；金额由服务端核算。
  private buildOrderRequest(): CreateOrderParams {
    return {
      requestKey: this.orderRequestKey,
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

  // 以下只负责页面展示和把用户操作交给上述业务方法。
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
      color: $r('[ui_components].color.border')
    })
  }

  // 支付方式弹层：“立即支付”先创建订单，随后进入收银台。
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
        Button(this.isSubmittingOrder ? '提交中...' : '立即支付')
          .width('100%')
          .height(36)
          .fontSize(14)
          .backgroundColor($r('[ui_components].color.red'))
          .enabled(!this.isSubmittingOrder && this.isCheckoutReady())
          .onClick(() => {
            this.createOrderAndOpenCashier()
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
            color: $r('[ui_components].color.border')
          })
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
        List() {
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
            .enabled(!this.isSubmittingOrder && this.isCheckoutReady())
            .fontSize(14)
            .height(36)
            .backgroundColor($r('[ui_components].color.red'))
            .onClick(() => {
              // 先展示支付方式；用户在弹层确认后才请求创建订单。
              this.openPaymentSheet()
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
          title: this.activeSheet === CheckoutSheet.Payment ? '支付方式' : '选择收货地址',
          subtitle: this.activeSheet === CheckoutSheet.Payment ? '请选择一种支付方式进行付款' : ''
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
    if (this.activeSheet === CheckoutSheet.Payment) {
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
      Button('管理收货地址')
        .width('100%')
        .height(40)
        .fontSize(14)
        .backgroundColor($r('[ui_components].color.under'))
        .fontColor($r('[ui_components].color.text'))
        .onClick(() => {
          this.showSheet = false
          this.addressManuallySelected = false
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
