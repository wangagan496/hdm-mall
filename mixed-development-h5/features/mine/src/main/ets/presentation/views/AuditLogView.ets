import { GlobalVariable } from 'constants'
import { HDMUser, formatBeijingTime } from 'models'
import { HDMNavBar } from 'ui_components'
import { RequestAxios } from 'network'
import { AuditItem, AuditPage, AuditFilter } from '../../data/api/audit'
import { auditActionLabel, auditChange, auditFilterLabel, auditObject } from '../utils/AuditPresentation'

@Component
export struct AuditLogView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = { account: '', nickname: '', token: '', avatar: '' }
  @State items: AuditItem[] = []
  @State page: number = 1
  @State pages: number = 0
  @State group: string = 'all'
  @State loading: boolean = false
  @State message: string = ''
  private orderId: string = ''
  private productId: string = ''
  private active: boolean = false
  private query: number = 0
  private allowed(): boolean { return this.active && this.user.role === 'merchant' && !!this.user.id && !!this.user.token }
  private current(query: number, token: string, account: string): boolean { return this.allowed() && query === this.query && token === this.user.token && account === this.user.id }
  private accountChanged(): void { this.query++; this.items = []; this.page = 1; this.pages = 0; this.loading = false; if (this.active) void this.load(1) }
  aboutToDisappear(): void { this.active = false; this.query++; this.loading = false; this.items = [] }
  private shown(): void { if (!this.active) { this.active = true; void this.load(this.page) } }
  private async load(page: number): Promise<void> {
    const query = ++this.query, token = this.user.token, account = this.user.id || ''
    this.items = []; this.message = ''
    if (!this.allowed()) { this.loading = false; this.message = '请使用商家账号登录'; return }
    this.loading = true
    let url = '/merchant/audit-log?page=' + page + '&pageSize=10&group=' + this.group
    if (this.orderId) url += '&orderId=' + encodeURIComponent(this.orderId)
    if (this.productId) url += '&productId=' + encodeURIComponent(this.productId)
    try {
      const result = await RequestAxios.getForSession<AuditPage>(url, token)
      if (!this.current(query, token, account)) return
      this.items = result.items; this.page = result.page; this.pages = result.pages
    } catch {
      if (this.current(query, token, account)) this.message = '操作记录读取失败，请重试'
    } finally { if (this.current(query, token, account)) this.loading = false }
  }
  private chooseGroup(group: string): void { this.group = group; void this.load(1) }
  private filterSelected(group: string): boolean { return this.group === group }
  private open(item: AuditItem): void {
    if (!this.allowed()) return
    if (item.orderId) this.stackPath.pushPath({ name: 'MerchantOrderView', param: item.orderId })
    else if (item.productId) this.stackPath.pushPath({ name: 'ProductEditView', param: item.productId })
  }
  @Builder
  private Card(item: AuditItem) {
    Column({ space: 8 }) {
      Text(formatBeijingTime(item.created) + ' · ' + item.actorAccount).fontSize(12).fontColor($r('[ui_components].color.gray'))
      Text(auditActionLabel(item.action)).id('audit-action-' + item.action).fontSize(18).fontWeight(FontWeight.Medium)
        .fontColor(item.result === 'denied' ? $r('[ui_components].color.red') : $r('[ui_components].color.text'))
      Text(auditObject(item)).fontSize(14).fontColor($r('[ui_components].color.text'))
      Text(auditChange(item)).id('audit-change-' + item.id).fontSize(15).fontColor($r('[ui_components].color.text'))
      if (item.summary.backfilled) { Text('历史记录').fontSize(12).fontColor($r('[ui_components].color.gray')) }
      if (item.orderId || item.productId) { Text(item.orderId ? '查看订单 ›' : '查看商品 ›').fontSize(13).fontColor($r('[ui_components].color.red')) }
    }.width('100%').padding(16).alignItems(HorizontalAlign.Start).backgroundColor($r('[ui_components].color.white')).borderRadius(12).onClick(() => this.open(item))
  }
  build() {
    NavDestination() {
      Column() {
        HDMNavBar({ title: '操作记录' })
        Flex({ wrap: FlexWrap.Wrap }) {
          ForEach(['all','products','inventory','shipping','aftersales','denied'], (group: string) => {
            Button(auditFilterLabel(group) + (this.filterSelected(group) ? ' ✓' : '')).id('audit-filter-' + group)
              .fontSize(14).margin(4).height(40)
              .backgroundColor(this.filterSelected(group) ? $r('[ui_components].color.red') : $r('[ui_components].color.white'))
              .fontColor(this.filterSelected(group) ? Color.White : $r('[ui_components].color.text'))
              .border({ width: 1, color: $r('[ui_components].color.border') }).onClick(() => this.chooseGroup(group))
          }, (group: string) => group + ':' + this.group)
        }.padding(8).width('100%')
        Scroll() {
          Column({ space: 12 }) {
            if (this.loading) { Text('正在读取记录').fontColor($r('[ui_components].color.text')) }
            if (this.message) { Text(this.message).fontColor($r('[ui_components].color.red')); Button('重试').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).onClick(() => this.load(this.page)) }
            if (!this.loading && !this.message && this.items.length === 0) { Text('暂无相关操作记录').fontColor($r('[ui_components].color.text')) }
            ForEach(this.items, (item: AuditItem) => { this.Card(item) }, (item: AuditItem) => String(item.id))
            Row({ space: 12 }) {
              Button('上一页').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).enabled(!this.loading && this.page > 1).onClick(() => this.load(this.page - 1))
              Text(this.page + ' / ' + Math.max(1, this.pages)).fontColor($r('[ui_components].color.text'))
              Button('下一页').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).enabled(!this.loading && this.page < this.pages).onClick(() => this.load(this.page + 1))
            }
          }.width('100%').padding(16)
        }.width('100%').layoutWeight(1).align(Alignment.Top)
      }.width('100%').height('100%').padding({ top: this.safeTop, bottom: this.safeBottom }).backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true).onReady(context => {
      const filter = context.pathInfo.param as AuditFilter
      this.orderId = filter?.orderId || ''; this.productId = filter?.productId || ''; this.active = true; void this.load(1)
    }).onShown(() => this.shown()).onHidden(() => this.aboutToDisappear())
  }
}
