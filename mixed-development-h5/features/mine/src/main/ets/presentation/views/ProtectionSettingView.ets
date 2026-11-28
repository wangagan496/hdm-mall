import { util } from '@kit.ArkTS'
import { GlobalVariable } from 'constants'
import {
  HDMUser, PriceProtectionPolicy, PriceProtectionDraftInput, PriceProtectionConfirmInput,
  PriceProtectionPublishInput, PriceProtectionDraftResult, PriceProtectionConfirmResult,
  PriceProtectionPublishResult, formatBeijingTime
} from 'models'
import { HDMNavBar } from 'ui_components'
import { RequestAxios } from 'network'
import {
  validateProtectionFields,
  findActiveProtectionPolicy,
  formatProtectionYuan,
  buildProtectionConfirmSummary,
  prepareProtectionErrorMessage,
  publishProtectionErrorMessage
} from '../utils/ProtectionPresentation'

interface ProtectionFailureResponse { status?: number }
interface ProtectionFailure { httpStatus?: number; response?: ProtectionFailureResponse }

@Component
export struct ProtectionSettingView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = {} as HDMUser
  @State windowDays: string = '7'
  @State budgetPerOrder: string = ''
  @State totalBudget: string = ''
  @State effectiveDays: string = '1'
  @State policies: PriceProtectionPolicy[] = []
  @State busy: boolean = false
  @State loading: boolean = false
  @State message: string = ''
  @State confirmVisible: boolean = false
  @State pendingWindowDays: number = 0
  @State pendingBudgetPerOrderCents: number = 0
  @State pendingEffectiveDays: number = 0
  private active: boolean = false
  private query: number = 0
  private pendingPolicyId: string = ''
  private pendingToken: string = ''

  private allowed(): boolean { return this.active && this.user.identity === 'merchant' && !!this.user.id && !!this.user.token }
  private current(query: number, token: string, account: string): boolean {
    return this.allowed() && query === this.query && token === this.user.token && account === this.user.id
  }
  private resetPending(): void {
    this.pendingPolicyId = ''
    this.pendingToken = ''
    this.pendingWindowDays = 0
    this.pendingBudgetPerOrderCents = 0
    this.pendingEffectiveDays = 0
  }
  private accountChanged(): void {
    this.query++
    this.windowDays = '7'; this.budgetPerOrder = ''; this.totalBudget = ''; this.effectiveDays = '1'
    this.policies = []; this.busy = false; this.loading = false; this.message = ''
    this.confirmVisible = false; this.resetPending()
    if (this.active) void this.load()
  }
  aboutToDisappear(): void { this.active = false; this.query++; this.loading = false; this.busy = false; this.confirmVisible = false; this.resetPending() }
  private shown(): void { if (!this.active) { this.active = true; void this.load() } }

  private activePolicy(): PriceProtectionPolicy | null {
    return findActiveProtectionPolicy(this.policies, Date.now())
  }
  private yuan(cents: number): string { return formatProtectionYuan(cents) }
  private date(ms: number): string { return formatBeijingTime(ms) }

  private async load(preserveMessage: boolean = false): Promise<void> {
    if (this.busy) return
    const query = ++this.query, token = this.user.token || '', account = this.user.id || ''
    if (!this.allowed()) { this.message = '请使用商家账号登录'; return }
    this.loading = true
    if (!preserveMessage) { this.message = '' }
    try {
      const list = await RequestAxios.getForSession<PriceProtectionPolicy[]>('/merchant/settings/protection', token)
      if (!this.current(query, token, account)) return
      this.policies = list || []
    } catch { if (this.current(query, token, account) && !preserveMessage) this.message = '价格保护读取失败，请重试' }
    finally { if (this.current(query, token, account)) this.loading = false }
  }

  private validate(): PriceProtectionDraftInput | null {
    const checked = validateProtectionFields(this.windowDays, this.budgetPerOrder, this.totalBudget, this.effectiveDays)
    if (checked.error) {
      this.message = checked.error
      return null
    }
    return {
      requestKey: util.generateRandomUUID(),
      windowDays: checked.windowDays,
      budgetPerOrderCents: checked.budgetPerOrderCents,
      totalBudgetCents: checked.totalBudgetCents,
      effectiveAtOffset: checked.effectiveDays * 86400
    }
  }

  private async prepare(): Promise<void> {
    if (this.busy || this.loading || this.confirmVisible || !this.allowed()) return
    const checked = validateProtectionFields(this.windowDays, this.budgetPerOrder, this.totalBudget, this.effectiveDays)
    if (checked.error) { this.message = checked.error; return }
    const input: PriceProtectionDraftInput = {
      requestKey: util.generateRandomUUID(),
      windowDays: checked.windowDays,
      budgetPerOrderCents: checked.budgetPerOrderCents,
      totalBudgetCents: checked.totalBudgetCents,
      effectiveAtOffset: checked.effectiveDays * 86400
    }
    const query = this.query, token = this.user.token || '', account = this.user.id || ''
    this.busy = true; this.message = ''
    try {
      const draft = await RequestAxios.postWithSession<PriceProtectionDraftResult>('/merchant/settings/protection/draft', input, token)
      if (!this.current(query, token, account)) return
      const confirmInput: PriceProtectionConfirmInput = { policyId: draft.policyId, policyHash: draft.policyHash }
      const confirmed = await RequestAxios.postWithSession<PriceProtectionConfirmResult>('/merchant/settings/protection/confirm', confirmInput, token)
      if (!this.current(query, token, account)) return
      this.pendingPolicyId = draft.policyId
      this.pendingToken = confirmed.token
      this.pendingWindowDays = checked.windowDays
      this.pendingBudgetPerOrderCents = checked.budgetPerOrderCents
      this.pendingEffectiveDays = checked.effectiveDays
      this.confirmVisible = true
    } catch (error) {
      if (!this.current(query, token, account)) return
      const failure = error as ProtectionFailure
      const status = failure.httpStatus || failure.response?.status || 0
      this.message = prepareProtectionErrorMessage(status)
    } finally { if (this.current(query, token, account)) this.busy = false }
  }

  private async publish(): Promise<void> {
    if (this.busy || !this.pendingToken || !this.allowed()) return
    const query = this.query, token = this.user.token || '', account = this.user.id || ''
    this.busy = true; this.message = ''
    try {
      const publishInput: PriceProtectionPublishInput = { token: this.pendingToken, policyId: this.pendingPolicyId, requestKey: util.generateRandomUUID() }
      await RequestAxios.postWithSession<PriceProtectionPublishResult>('/merchant/settings/protection/publish', publishInput, token)
      if (!this.current(query, token, account)) return
      this.confirmVisible = false
      this.resetPending()
      this.message = '新版本已发布，旧订单继续按原版本保护'
      this.busy = false
      await this.load(true)
    } catch (error) {
      if (!this.current(query, token, account)) return
      const failure = error as ProtectionFailure
      const status = failure.httpStatus || failure.response?.status || 0
      this.message = publishProtectionErrorMessage(status)
      if (status === 403 || status === 409) {
        this.confirmVisible = false
        this.resetPending()
      }
    } finally { if (this.current(query, token, account)) this.busy = false }
  }

  @Builder
  confirmSheet() {
    Column({ space: 12 }) {
      Text('确认发布价保新版本').id('protection-confirm-title').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('[ui_components].color.text'))
      Text(buildProtectionConfirmSummary(this.pendingWindowDays, this.pendingBudgetPerOrderCents, this.pendingEffectiveDays))
        .id('protection-confirm-summary').fontColor($r('[ui_components].color.text'))
      Text('发布后不可修改，只能再发新版本；已下的订单继续按原版本保护。')
        .fontSize(13).fontColor($r('[ui_components].color.gray'))
      Button(this.busy ? '正在发布' : '确认发布').id('protection-confirm-publish')
        .backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary')).width('100%')
        .enabled(!this.busy).onClick(() => { void this.publish() })
      Button('取消').id('protection-confirm-cancel')
        .backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.text'))
        .border({ width: 1, color: $r('[ui_components].color.border') }).width('100%')
        .enabled(!this.busy).onClick(() => { this.confirmVisible = false; this.resetPending() })
    }.width('100%').padding(20)
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({ title: '价格保护' })
        Scroll() {
          Column({ space: 16 }) {
            if (this.activePolicy()) {
              Column({ space: 6 }) {
                Text('当前生效版本').id('protection-active-title').fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('[ui_components].color.text'))
                Text('保护 ' + this.activePolicy()!.windowDays + ' 天 · 单笔最多 ' + this.yuan(this.activePolicy()!.budgetPerOrderCents))
                  .id('protection-active-window').fontColor($r('[ui_components].color.text'))
                Text('生效日期：' + this.date(this.activePolicy()!.effectiveAt)).id('protection-active-effective').fontSize(13).fontColor($r('[ui_components].color.gray'))
              }.width('100%').padding(16).alignItems(HorizontalAlign.Start).backgroundColor($r('[ui_components].color.white')).borderRadius(12)
            } else {
              Text('还没有生效的价格保护，配置后买家下单就能看到本单的保护期限。')
                .id('protection-empty').fontColor($r('[ui_components].color.gray')).width('100%')
            }

            Text('发布新版本后，已过去的订单继续按它下单时那一版保护，不改旧承诺。').fontSize(14).fontColor($r('[ui_components].color.gray')).width('100%')

            Text('保护天数（1–90）').fontColor($r('[ui_components].color.text')).width('100%')
            TextInput({ text: this.windowDays, placeholder: '例如7' }).id('protection-window-days').type(InputType.Number).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.white')).enabled(!this.busy && !this.loading && !this.confirmVisible).onChange((value: string) => this.windowDays = value)
            Text('单笔补差上限（元）').fontColor($r('[ui_components].color.text')).width('100%')
            TextInput({ text: this.budgetPerOrder, placeholder: '例如10.00' }).id('protection-budget-order').type(InputType.NUMBER_DECIMAL).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.white')).enabled(!this.busy && !this.loading && !this.confirmVisible).onChange((value: string) => this.budgetPerOrder = value)
            Text('总预算（元）').fontColor($r('[ui_components].color.text')).width('100%')
            TextInput({ text: this.totalBudget, placeholder: '例如500.00' }).id('protection-total-budget').type(InputType.NUMBER_DECIMAL).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.white')).enabled(!this.busy && !this.loading && !this.confirmVisible).onChange((value: string) => this.totalBudget = value)
            Text('几天后生效（1–30）').fontColor($r('[ui_components].color.text')).width('100%')
            TextInput({ text: this.effectiveDays, placeholder: '例如1' }).id('protection-effective-days').type(InputType.Number).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.white')).enabled(!this.busy && !this.loading && !this.confirmVisible).onChange((value: string) => this.effectiveDays = value)

            if (this.policies.length > 0) {
              Text('版本记录').id('protection-history-title').fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('[ui_components].color.text')).width('100%')
              ForEach(this.policies, (policy: PriceProtectionPolicy) => {
                Text('第 ' + policy.version + ' 版 · ' + policy.windowDays + ' 天 · 单笔 ' + this.yuan(policy.budgetPerOrderCents) + ' · ' +
                  (policy.published ? '已发布' : '未发布'))
                  .id('protection-policy-' + policy.version).fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
              }, (policy: PriceProtectionPolicy) => policy.policyId)
            }

            if (this.message) { Text(this.message).id('protection-message').fontColor($r('[ui_components].color.text')).width('100%') }
            Button(this.busy ? '正在处理' : '预览并发布').id('protection-prepare')
              .backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary')).width('100%')
              .enabled(!this.busy && !this.loading && !this.confirmVisible).onClick(() => { void this.prepare() })
            Button('重新加载').id('protection-reload').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red'))
              .border({ width: 1, color: $r('[ui_components].color.red') }).enabled(!this.busy && !this.loading && !this.confirmVisible).onClick(() => { void this.load() })
          }.width('100%').padding(20)
        }.layoutWeight(1).width('100%')
      }.width('100%').height('100%').padding({ top: this.safeTop, bottom: this.safeBottom }).backgroundColor($r('[ui_components].color.under'))
      .bindSheet($$this.confirmVisible, this.confirmSheet(), {
        height: SheetSize.FIT_CONTENT,
        dragBar: false,
        backgroundColor: $r('[ui_components].color.white'),
        onDisappear: () => {
          if (!this.busy) {
            this.resetPending()
          }
        }
      })
    }.hideTitleBar(true).onShown(() => this.shown()).onHidden(() => this.aboutToDisappear())
  }
}
