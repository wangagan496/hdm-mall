import { GlobalVariable } from 'constants'
import { HDMUser, OrderItem, OrderSku } from 'models'
import { HDMNavBar } from 'ui_components'
import { RequestAxios } from 'network'
import { AuditFilter } from '../../data/api/audit'
import { InvoiceDetail, formatBeijingTime } from 'models'
import { util } from '@kit.ArkTS'

interface IssueInvoiceBody { requestKey: string; number: string }

@Component
export struct MerchantOrderView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = { account: '', nickname: '', token: '', avatar: '' }
  @State order: OrderItem | null = null
  @State message: string = ''
  @State messageOk: boolean = false
  @State loading: boolean = false
  @State issuing: boolean = false
  @State invoiceNumber: string = ''
  private issueKey: string = ''
  private issueNumber: string = ''
  private orderId: string = ''
  private active: boolean = false
  private query: number = 0
  private accountChanged(): void { this.order = null; this.query++; this.issuing = false; this.issueKey = ''; this.invoiceNumber = ''; if (this.active) void this.load() }
  private messageColor(): ResourceColor { return this.messageOk ? $r('[ui_components].color.text') : $r('[ui_components].color.red') }
  aboutToDisappear(): void { this.active = false; this.query++; this.order = null; this.loading = false; this.issuing = false }
  private async issueInvoice(): Promise<void> {
    if (!this.active || this.issuing || this.user.role !== 'merchant' || !this.user.token || !this.order?.invoice || this.order.invoice.status !== 'requested' || ![2, 3, 4, 5].includes(this.order.orderState)) return
    const token = this.user.token, query = this.query, orderId = this.orderId
    if (!this.issueKey) { this.issueKey = util.generateRandomUUID(true); this.issueNumber = this.invoiceNumber.trim() }
    this.issuing = true; this.message = ''; this.messageOk = false
    try {
      const invoice = await RequestAxios.postWithSession<InvoiceDetail>('/merchant/orders/' + encodeURIComponent(orderId) + '/invoice/issued', { requestKey: this.issueKey, number: this.issueNumber } as IssueInvoiceBody, token)
      if (this.active && query === this.query && token === this.user.token && this.order?.id === orderId) {
        const updated = JSON.parse(JSON.stringify(this.order)) as OrderItem
        updated.invoice = invoice; this.order = updated; this.messageOk = true; this.message = '已标记开票，买家可以查看'; this.issueKey = ''
      }
    } catch { if (this.active && query === this.query && token === this.user.token) this.message = '暂未确认结果，请重试标记；不会重复开票' }
    finally { if (query === this.query && token === this.user.token) this.issuing = false }
  }
  private shown(): void { if (!this.active) { this.active = true; void this.load() } }
  private async load(): Promise<void> {
    const query = ++this.query, token = this.user.token
    this.order = null; this.message = ''; this.messageOk = false; this.loading = false
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
            if (this.message) { Text(this.message).fontColor(this.messageColor()) }
            if (this.message && !this.order) { Button('重试').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).enabled(!this.loading).onClick(() => this.load()) }
            if (this.order) {
              Text(this.stateText()).fontSize(22).fontColor($r('[ui_components].color.text'))
              Text(formatBeijingTime(this.order.createTime) + ' 下单').fontColor($r('[ui_components].color.gray'))
              ForEach(this.order.skus, (sku: OrderSku) => {
                Text(sku.name + ' · ' + sku.attrsText + ' × ' + sku.quantity).fontColor($r('[ui_components].color.text'))
              })
              Text('实付 ¥' + this.order.payMoney.toFixed(2)).fontColor($r('[ui_components].color.text'))
              if (this.order.invoice) {
                Text('开票信息 · ' + (this.order.invoice.status === 'issued' ? '已开票' : '待开票')).id('merchant-invoice-status').fontColor($r('[ui_components].color.red'))
                Text(this.order.invoice.titleType === 'company' ? '单位抬头：' + this.order.invoice.title : '个人抬头：' + this.order.invoice.title).fontColor($r('[ui_components].color.text'))
                if (this.order.invoice.taxId) { Text('税号：' + this.order.invoice.taxId).fontColor($r('[ui_components].color.text')) }
                Text('接收邮箱：' + this.order.invoice.email).fontColor($r('[ui_components].color.text'))
                Text('发票由商家线下开具').fontColor($r('[ui_components].color.gray'))
                if (this.order.invoice.status === 'requested' && this.order.orderState >= 2 && this.order.orderState <= 5) {
                  TextInput({ text: this.invoiceNumber, placeholder: '发票号码（选填）' }).id('invoice-number').maxLength(100).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.white')).enabled(!this.issuing && !this.issueKey).onChange(value => { this.invoiceNumber = value })
                  Button(this.issuing ? '标记中' : this.issueKey ? '重试标记已开票' : '标记已开票').id('invoice-issue').backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary')).enabled(!this.issuing).onClick(() => this.issueInvoice())
                } else if (this.order.invoice.number) { Text('发票号码：' + this.order.invoice.number).fontColor($r('[ui_components].color.text')) }
              }
              Button('操作记录').id('merchant-order-audit').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).onClick(() => this.stackPath.pushPath({ name: 'AuditLogView', param: { orderId: this.orderId } as AuditFilter }))
            }
          }.padding(20).width('100%').alignItems(HorizontalAlign.Start)
        }.width('100%').layoutWeight(1).align(Alignment.Top)
      }.width('100%').height('100%').padding({ top: this.safeTop, bottom: this.safeBottom }).backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true).onReady(context => { this.orderId = context.pathInfo.param as string || ''; this.active = true; void this.load() })
      .onShown(() => this.shown()).onHidden(() => this.aboutToDisappear())
  }
}
