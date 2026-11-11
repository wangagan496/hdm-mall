import { util } from '@kit.ArkTS'
import { GlobalVariable } from 'constants'
import { HDMUser, PromotionRule, amountInputCents } from 'models'
import { HDMNavBar } from 'ui_components'
import { RequestAxios } from 'network'
import { storeManager } from 'storage'

interface PromotionEdit { requestKey: string; expectedRevision: number; thresholdCents: number; discountCents: number; enabled: boolean }
interface PromotionFailure { httpStatus?: number; response?: PromotionResponse }
interface PromotionResponse { status?: number }

@Component
export struct PromotionSettingView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = {} as HDMUser
  @State threshold: string = ''
  @State discount: string = ''
  @State promotionEnabled: boolean = false
  @State rule: PromotionRule | null = null
  @State pending: PromotionEdit | null = null
  @State busy: boolean = false
  @State loading: boolean = false
  @State message: string = ''
  private active: boolean = false
  private query: number = 0
  private allowed(): boolean { return this.active && this.user.role === 'merchant' && !!this.user.id && !!this.user.token }
  private current(query: number, token: string, account: string): boolean { return this.allowed() && query === this.query && token === this.user.token && account === this.user.id }
  private accountChanged(): void {
    this.query++; this.threshold = ''; this.discount = ''; this.promotionEnabled = false; this.rule = null; this.pending = null; this.busy = false; this.loading = false; this.message = ''
    if (this.active) void this.load()
  }
  aboutToDisappear(): void { this.active = false; this.query++; this.loading = false; this.busy = false }
  private shown(): void { if (!this.active) { this.active = true; void this.load() } }
  private apply(rule: PromotionRule): void { this.rule = rule; this.threshold = (rule.thresholdCents / 100).toFixed(2); this.discount = (rule.discountCents / 100).toFixed(2); this.promotionEnabled = rule.enabled }
  private async persist(account: string, pending: PromotionEdit | null): Promise<void> {
    const store = storeManager.getStore(), key = 'promotion-setting:' + account, before = store.getSync(key, '') as string
    store.putSync(key, pending ? JSON.stringify(pending) : '')
    try { await store.flush() } catch { store.putSync(key, before); throw new Error('本地记录保存失败，请重试') }
  }
  private async load(): Promise<void> {
    if (this.busy) return
    const query = ++this.query, token = this.user.token || '', account = this.user.id || ''
    if (!this.allowed()) { this.message = '请使用商家账号登录'; return }
    this.loading = true; this.message = ''
    try {
      const saved = storeManager.getStore().getSync('promotion-setting:' + account, '') as string
      const pending = saved ? JSON.parse(saved) as PromotionEdit : null
      const rule = await RequestAxios.getForSession<PromotionRule>('/merchant/settings/promotion', token)
      if (!this.current(query, token, account)) return
      this.apply(rule); this.pending = pending
      if (pending) { this.threshold = (pending.thresholdCents / 100).toFixed(2); this.discount = (pending.discountCents / 100).toFixed(2); this.promotionEnabled = pending.enabled; this.message = '上次修改结果待确认，请重试确认' }
    } catch { if (this.current(query, token, account)) this.message = '满减规则读取失败，请重试' }
    finally { if (this.current(query, token, account)) this.loading = false }
  }
  private async save(): Promise<void> {
    if (this.busy || this.loading || !this.allowed() || !this.rule) return
    const query = this.query, token = this.user.token || '', account = this.user.id || ''
    if (!this.pending) {
      const threshold = amountInputCents(this.threshold), discount = amountInputCents(this.discount)
      if (threshold < 1 || threshold > 2147483647 || discount < 1 || discount >= threshold) { this.message = '门槛至少0.01元，优惠须大于0且小于门槛，金额最多两位小数'; return }
      this.pending = { requestKey: util.generateRandomUUID(), expectedRevision: this.rule.revision, thresholdCents: threshold, discountCents: discount, enabled: this.promotionEnabled }
    }
    const pending = this.pending
    this.busy = true; this.message = ''
    try {
      await this.persist(account, pending)
      if (!this.current(query, token, account)) return
      const result = await RequestAxios.putForSession<PromotionRule>('/merchant/settings/promotion', pending, token)
      if (!this.current(query, token, account)) return
      await this.persist(account, null)
      if (!this.current(query, token, account)) return
      this.pending = null; this.apply(result); this.message = '满减规则已保存'
    } catch (error) {
      if (!this.current(query, token, account)) return
      const failure = error as PromotionFailure, status = failure.httpStatus || failure.response?.status || 0
      if ([400, 403, 409, 422].includes(status)) {
        try { await this.persist(account, null) } catch { this.message = '本地记录未清理，请重试确认'; return }
        if (!this.current(query, token, account)) return
        this.pending = null; this.rule = null; this.message = status === 409 ? '满减规则已更新，请重新加载后再修改' : '保存被拒绝，请重新加载后核对输入'
      } else this.message = '修改结果待确认，请重试确认；不会重复修改'
    } finally { if (this.current(query, token, account)) this.busy = false }
  }
  build() {
    NavDestination() {
      Column() {
        HDMNavBar({ title: '满减设置' })
        Scroll() {
          Column({ space: 16 }) {
            Text('按商品合计计算满减，修改不影响已经下单的优惠。').fontColor($r('[ui_components].color.text')).width('100%')
            Text('满多少元').fontColor($r('[ui_components].color.text')).width('100%')
            TextInput({ text: this.threshold, placeholder: '例如99.00' }).id('promotion-threshold').type(InputType.NUMBER_DECIMAL).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.white')).enabled(!this.busy && !this.loading && !this.pending).onChange((value: string) => this.threshold = value)
            Text('减多少元').fontColor($r('[ui_components].color.text')).width('100%')
            TextInput({ text: this.discount, placeholder: '例如10.00' }).id('promotion-discount').type(InputType.NUMBER_DECIMAL).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.white')).enabled(!this.busy && !this.loading && !this.pending).onChange((value: string) => this.discount = value)
            Row() { Text('启用满减').fontColor($r('[ui_components].color.text')); Blank(); Toggle({ type: ToggleType.Switch, isOn: this.promotionEnabled }).id('promotion-enabled').selectedColor($r('[ui_components].color.red')).enabled(!this.busy && !this.loading && !this.pending).onChange((value: boolean) => this.promotionEnabled = value) }.width('100%')
            Text('优惠金额较大时，低价商品可能被抵扣为 0 元').fontSize(14).fontColor($r('[ui_components].color.gray')).width('100%')
            if (this.message) { Text(this.message).id('promotion-message').fontColor($r('[ui_components].color.text')).width('100%') }
            Button(this.busy ? '正在保存' : this.pending ? '重试确认结果' : '保存满减规则').id('promotion-save').backgroundColor($r('[ui_components].color.red')).fontColor(Color.White).width('100%').enabled(!this.busy && !this.loading && !!this.rule).onClick(() => this.save())
            Button('重新加载').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({ width: 1, color: $r('[ui_components].color.red') }).enabled(!this.busy && !this.loading).onClick(() => this.load())
          }.width('100%').padding(20)
        }.layoutWeight(1).width('100%')
      }.width('100%').height('100%').padding({ top: this.safeTop, bottom: this.safeBottom }).backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true).onShown(() => this.shown()).onHidden(() => this.aboutToDisappear())
  }
}
