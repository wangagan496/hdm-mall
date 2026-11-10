import { GlobalVariable } from 'constants'
import { HDMUser, OrderItem, OrderSku } from 'models'
import { HDMNavBar } from 'ui_components'
import { RequestAxios } from 'network'
import { AuditFilter } from '../../data/api/audit'

@Component
export struct MerchantOrderView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = { account: '', nickname: '', token: '', avatar: '' }
  @State order: OrderItem | null = null
  @State message: string = ''
  @State loading: boolean = false
  private orderId: string = ''
  private active: boolean = false
  private query: number = 0
  private accountChanged(): void { this.order = null; this.query++; if (this.active) void this.load() }
  aboutToDisappear(): void { this.active = false; this.query++; this.order = null; this.loading = false }
  private shown(): void { if (!this.active) { this.active = true; void this.load() } }
  private async load(): Promise<void> {
    const query = ++this.query, token = this.user.token
    this.order = null; this.message = ''; this.loading = false
    if (!this.active || this.user.role !== 'merchant' || !token || !this.orderId) { this.message = '请使用商家账号查看订单'; return }
    this.loading = true
    try {
      const order = await RequestAxios.getForSession<OrderItem>('/merchant/orders/' + encodeURIComponent(this.orderId), token)
      if (this.active && query === this.query && token === this.user.token && this.user.role === 'merchant') this.order = order
    } catch { if (this.active && query === this.query && token === this.user.token) this.message = '订单读取失败，请重试' }
    finally { if (query === this.query) this.loading = false }
  }
  private stateText(): string {
    const labels: string[] = ['', '待付款', '待发货', '已发货', '已收货', '已评价', '已取消']
    return this.order ? labels[this.order.orderState] : ''
  }
  build() {
    NavDestination() {
      Column() {
        HDMNavBar({ title: '商家订单详情' })
        Scroll() {
          Column({ space: 16 }) {
            if (this.loading) { Text('正在读取订单').fontColor($r('[ui_components].color.text')) }
            if (this.message) { Text(this.message).fontColor($r('[ui_components].color.red')); Button('重试').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).onClick(() => this.load()) }
            if (this.order) {
              Text(this.stateText()).fontSize(22).fontColor($r('[ui_components].color.text'))
              Text(this.order.createTime + '下单').fontColor($r('[ui_components].color.gray'))
              ForEach(this.order.skus, (sku: OrderSku) => {
                Text(sku.name + ' · ' + sku.attrsText + ' × ' + sku.quantity).fontColor($r('[ui_components].color.text'))
              })
              Text('实付 ¥' + this.order.payMoney.toFixed(2)).fontColor($r('[ui_components].color.text'))
              Button('操作记录').id('merchant-order-audit').onClick(() => this.stackPath.pushPath({ name: 'AuditLogView', param: { orderId: this.orderId } as AuditFilter }))
            }
          }.padding(20).width('100%').alignItems(HorizontalAlign.Start)
        }.width('100%').layoutWeight(1).align(Alignment.Top)
      }.width('100%').height('100%').padding({ top: this.safeTop, bottom: this.safeBottom }).backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true).onReady(context => { this.orderId = context.pathInfo.param as string || ''; this.active = true; void this.load() })
      .onShown(() => this.shown()).onHidden(() => this.aboutToDisappear())
  }
}
