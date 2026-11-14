import { GlobalVariable } from 'constants'
import { HDMUser, formatBeijingTime } from 'models'
import { HDMNavBar } from 'ui_components'
import { RequestAxios } from 'network'
import { reconciliationDay, validReconciliationDate } from '../utils/ReconciliationDate'

interface ReconciliationOrderItem { name: string; count: number }
interface ReconciliationDifference { id: string; kind: string; businessId: string; category: string; description: string; state: string; reason?: string; handledAt?: number; handlerAccount?: string; orderId?: string | null; buyerAccount?: string | null; orderCreatedAt?: number | null; orderItems: ReconciliationOrderItem[] }
interface ReconciliationReport { date: string; paymentCount: number; paymentAmountCents: number; refundCount: number; refundAmountCents: number; differenceCount: number; pendingCount: number; checkedAt?: number; state: string; differences: ReconciliationDifference[] }
interface ReconciliationDateBody { date: string }
interface ReconciliationReasonBody { reason: string }
interface ReconciliationReceipt { id: string; state: string }

@Component
export struct ReconciliationView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = { account: '', nickname: '', token: '', avatar: '' }
  @State date: string = reconciliationDay(Date.now() - 86400000)
  @State report: ReconciliationReport | null = null
  @State selectedId: string = ''
  @State reason: string = ''
  @State working: boolean = false
  @State message: string = ''
  private active: boolean = false
  private query: number = 0
  private allowed(): boolean { return this.active && this.user.role === 'merchant' && !!this.user.id && !!this.user.token }
  private current(query: number, token: string, account: string): boolean { return this.allowed() && query === this.query && token === this.user.token && account === this.user.id }
  private accountChanged(): void {
    this.query++; this.report = null; this.selectedId = ''; this.reason = ''; this.working = false
    if (this.active) void this.load()
  }
  aboutToDisappear(): void { this.active = false; this.query++; this.report = null; this.selectedId = ''; this.reason = ''; this.working = false }
  private shown(): void { if (!this.active) { this.active = true; void this.load() } }
  private changeDate(value: string): void {
    if (this.working || value === this.date) return
    this.date = value; this.query++; this.report = null; this.selectedId = ''; this.reason = ''
  }
  private async load(run: boolean = false): Promise<void> {
    if (!this.allowed()) { this.message = '请使用商家账号登录'; return }
    if (!validReconciliationDate(this.date)) { this.message = '请填写有效日期，例如2026-11-13'; return }
    if (this.working) return
    const query: number = ++this.query, token: string = this.user.token, account: string = this.user.id || '', date: string = this.date
    this.working = true; this.message = ''; this.report = null
    try {
      const body: ReconciliationDateBody = { date }
      const result: ReconciliationReport = run ? await RequestAxios.postWithSession<ReconciliationReport>('/merchant/reconciliation/run', body, token) :
        await RequestAxios.getForSession<ReconciliationReport>('/merchant/reconciliation?date=' + encodeURIComponent(date), token)
      if (this.current(query, token, account)) this.report = result
    } catch {
      if (this.current(query, token, account)) this.message = run ? '对账结果未确认，请重新查询；系统会保留失败任务重试' : '对账记录读取失败，请重试'
    } finally { if (this.current(query, token, account)) this.working = false }
  }
  private orderSummary(item: ReconciliationDifference): string {
    if (!item.orderId) return '系统内无对应订单'
    const goods: string = item.orderItems.map((goods: ReconciliationOrderItem) => goods.name + ' × ' + goods.count).join('、')
    return (item.buyerAccount || '买家账号暂无') + ' · ' + formatBeijingTime(item.orderCreatedAt || 0) + ' · ' + goods
  }
  private openOrder(item: ReconciliationDifference): void {
    if (!this.allowed() || this.working || !item.orderId || !this.report?.differences.some(row => row.id === item.id && row.orderId === item.orderId)) return
    this.stackPath.pushPath({ name: 'MerchantOrderView', param: item.orderId })
  }
  private choose(item: ReconciliationDifference): void {
    if (!this.allowed() || this.working || item.state !== 'pending') return
    this.selectedId = item.id; this.reason = ''; this.message = ''
  }
  private async resolve(): Promise<void> {
    if (!this.allowed() || this.working || !this.selectedId || !this.report?.differences.some(item => item.id === this.selectedId && item.state === 'pending')) return
    const reason: string = this.reason.trim()
    if (reason.length < 5 || reason.length > 200) { this.message = '请填写5到200字的处理原因'; return }
    const query: number = ++this.query, token: string = this.user.token, account: string = this.user.id || '', id: string = this.selectedId
    this.working = true; this.message = ''
    try {
      const body: ReconciliationReasonBody = { reason }
      await RequestAxios.postWithSession<ReconciliationReceipt>('/merchant/reconciliation/differences/' + encodeURIComponent(id) + '/resolve', body, token)
      if (!this.current(query, token, account)) return
      this.selectedId = ''; this.reason = ''; this.working = false
      await this.load()
    } catch {
      if (this.current(query, token, account)) this.message = '处理结果未确认，请重新查询后再操作'
    } finally { if (this.current(query, token, account)) this.working = false }
  }
  @Builder
  private Difference(item: ReconciliationDifference) {
    Column({ space: 8 }) {
      Text(item.state === 'resolved' ? '已处理' : '待处理').fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('[ui_components].color.text'))
      Text(item.description).id('reconciliation-description-' + item.id).fontSize(15).fontColor($r('[ui_components].color.text'))
      Text(this.orderSummary(item)).id('reconciliation-order-summary-' + item.id).fontSize(13).fontColor($r('[ui_components].color.gray'))
      if (item.orderId) {
        Button('查看订单详情').id('reconciliation-order-' + item.id).enabled(!this.working).backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).onClick(() => this.openOrder(item))
      }
      if (item.state === 'resolved') {
        Text('处理原因：' + (item.reason || '')).fontSize(14).fontColor($r('[ui_components].color.text'))
        Text((item.handlerAccount || '') + ' · ' + formatBeijingTime(item.handledAt || 0)).fontSize(12).fontColor($r('[ui_components].color.gray'))
      } else if (this.selectedId === item.id) {
        TextArea({ text: $$this.reason, placeholder: '处理原因（5到200字）' }).id('reconciliation-reason').maxLength(200).height(100).enabled(!this.working)
        Button('保存处理结果').id('reconciliation-save').enabled(!this.working).backgroundColor($r('[ui_components].color.red')).fontColor(Color.White).onClick(() => this.resolve())
      } else {
        Button('标记已处理').id('reconciliation-resolve-' + item.id).enabled(!this.working).backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({ width: 1, color: $r('[ui_components].color.red') }).onClick(() => this.choose(item))
      }
    }.width('100%').padding(16).alignItems(HorizontalAlign.Start).backgroundColor($r('[ui_components].color.white')).borderRadius(12)
  }
  build() {
    NavDestination() {
      Column({ space: 8 }) {
        HDMNavBar({ title: '对账' })
        Text('按北京时间自然日核对支付和退款').fontSize(13).fontColor($r('[ui_components].color.gray'))
        Text('当前使用模拟渠道账单').fontSize(13).fontColor($r('[ui_components].color.gray'))
        TextInput({ text: this.date, placeholder: '日期 YYYY-MM-DD' }).id('reconciliation-date').enabled(!this.working).onChange((value: string) => this.changeDate(value)).width('90%')
        Row({ space: 12 }) {
          Button('查询记录').id('reconciliation-query').enabled(!this.working).backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({ width: 1, color: $r('[ui_components].color.red') }).onClick(() => this.load())
          Button('开始对账').id('reconciliation-run').enabled(!this.working).backgroundColor($r('[ui_components].color.red')).fontColor(Color.White).onClick(() => this.load(true))
        }
        if (this.message) { Text(this.message).fontSize(14).fontColor($r('[ui_components].color.red')).padding(8) }
        Scroll() {
          Column({ space: 12 }) {
            if (this.working) { Text('正在处理，请稍候').fontColor($r('[ui_components].color.text')) }
            if (this.report) {
              Text('已支付 ' + this.report.paymentCount + ' 笔 · ¥' + (this.report.paymentAmountCents / 100).toFixed(2)).fontColor($r('[ui_components].color.text'))
              Text('已退款 ' + this.report.refundCount + ' 笔 · ¥' + (this.report.refundAmountCents / 100).toFixed(2)).fontColor($r('[ui_components].color.text'))
              Text('差异 ' + this.report.differenceCount + ' 条 · 待处理 ' + this.report.pendingCount + ' 条').id('reconciliation-summary').fontWeight(FontWeight.Medium).fontColor($r('[ui_components].color.text'))
              if (this.report.state === 'not-started') { Text('这一天还未对账，请点击开始对账').fontColor($r('[ui_components].color.gray')) }
              if (this.report.state === 'failed') { Text('上次对账失败，系统保留重试，也可手动重试').fontColor($r('[ui_components].color.red')) }
              if (this.report.checkedAt) { Text('核对时间：' + formatBeijingTime(this.report.checkedAt)).fontSize(12).fontColor($r('[ui_components].color.gray')) }
              ForEach(this.report.differences, (item: ReconciliationDifference) => { this.Difference(item) }, (item: ReconciliationDifference) => item.id + item.state)
            }
          }.width('100%').padding(16)
        }.layoutWeight(1).width('100%').align(Alignment.Top)
      }.width('100%').height('100%').padding({ top: this.safeTop, bottom: this.safeBottom }).backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true).onReady(() => this.shown()).onShown(() => this.shown()).onHidden(() => this.aboutToDisappear())
  }
}
