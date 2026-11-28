import { util } from '@kit.ArkTS'
import { GlobalVariable } from 'constants'
import { HDMUser, SpendingRule, SpendingRuleInput, SpendingSummary, formatBeijingTime } from 'models'
import { HDMNavBar } from 'ui_components'
import { getSpendingRulesAPI, getSpendingSummaryAPI, saveSpendingRuleAPI } from '../../data/api'
import {
  DEFAULT_MONTH_DISCLOSURE,
  centsToInputText,
  formatSpendingRuleLine,
  formatSpendingYuan,
  spendingSaveErrorMessage,
  validateSpendingRuleFields
} from '../utils/SpendingSettingPresentation'

interface SpendingFailureBody {
  reason?: string
}

interface SpendingFailureResponse {
  status?: number
  data?: SpendingFailureBody
}

interface SpendingRequestError extends Error {
  httpStatus?: number
  response?: SpendingFailureResponse
}

@Component
export struct SpendingSettingView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = {} as HDMUser

  @State monthlyBudgetText: string = ''
  @State perOrderLimitText: string = ''
  @State cooldownAmountText: string = ''
  @State cooldownHoursText: string = ''
  @State enabledFlag: boolean = false
  @State disclosureAccepted: boolean = false
  @State currentRuleVersion: number = 0
  @State monthDisclosure: string = DEFAULT_MONTH_DISCLOSURE
  @State summary: SpendingSummary | null = null
  @State history: SpendingRule[] = []
  @State loading: boolean = false
  @State busy: boolean = false
  @State message: string = ''

  private active: boolean = false
  private query: number = 0
  private sessionSeq: number = 0
  private pendingSaveKey: string = ''
  private lastSaveSignature: string = ''

  private allowed(): boolean {
    return this.active && this.user.identity !== 'merchant' && !!this.user.id && !!this.user.token
  }

  private sameSession(seq: number, token: string, account: string): boolean {
    return this.allowed() && seq === this.sessionSeq && token === this.user.token && account === this.user.id
  }

  private current(query: number, token: string, account: string): boolean {
    return this.allowed() && query === this.query && token === this.user.token && account === this.user.id
  }

  private accountChanged(): void {
    this.query++
    this.sessionSeq++
    this.monthlyBudgetText = ''
    this.perOrderLimitText = ''
    this.cooldownAmountText = ''
    this.cooldownHoursText = ''
    this.enabledFlag = false
    this.disclosureAccepted = false
    this.currentRuleVersion = 0
    this.summary = null
    this.history = []
    this.loading = false
    this.busy = false
    this.message = ''
    this.pendingSaveKey = ''
    this.lastSaveSignature = ''
    if (this.active) {
      void this.load()
    }
  }

  aboutToDisappear(): void {
    this.active = false
    this.query++
    this.sessionSeq++
    this.loading = false
    this.busy = false
  }

  private shown(): void {
    if (!this.active) {
      this.active = true
    }
    void this.load()
  }

  private applyRule(rule: SpendingRule): void {
    this.currentRuleVersion = rule.version
    this.enabledFlag = rule.enabled
    this.monthlyBudgetText = centsToInputText(rule.monthlyBudgetCents)
    this.perOrderLimitText = centsToInputText(rule.perOrderLimitCents)
    this.cooldownAmountText = centsToInputText(rule.cooldownThresholdCents)
    this.cooldownHoursText = rule.cooldownHours !== null ? String(rule.cooldownHours) : ''
    this.monthDisclosure = rule.monthDisclosure || DEFAULT_MONTH_DISCLOSURE
    if (rule.enabled) {
      this.disclosureAccepted = true
    }
  }

  private async load(preserveMessage: boolean = false): Promise<void> {
    if (!this.allowed()) {
      this.message = '请登录买家账号后设置花钱预算与冷静门槛'
      return
    }
    const query = ++this.query
    const token = this.user.token || ''
    const account = this.user.id || ''
    this.loading = true
    if (!preserveMessage) {
      this.message = ''
    }
    try {
      const rulesRes = await getSpendingRulesAPI(token)
      const summaryRes = await getSpendingSummaryAPI(token)
      if (!this.current(query, token, account)) {
        return
      }
      this.applyRule(rulesRes.current)
      this.history = rulesRes.history || []
      this.summary = summaryRes
    } catch {
      if (this.current(query, token, account) && !preserveMessage) {
        this.message = '花钱设置读取失败，请重试'
      }
    } finally {
      if (this.current(query, token, account)) {
        this.loading = false
      }
    }
  }

  private async save(): Promise<void> {
    if (this.busy || this.loading || !this.allowed()) {
      return
    }
    const checked = validateSpendingRuleFields(
      this.monthlyBudgetText,
      this.perOrderLimitText,
      this.cooldownAmountText,
      this.cooldownHoursText,
      this.enabledFlag,
      this.disclosureAccepted
    )
    if (checked.error) {
      this.message = checked.error
      return
    }
    const signature = JSON.stringify({
      v: this.currentRuleVersion,
      m: checked.monthlyBudgetCents,
      p: checked.perOrderLimitCents,
      c: checked.cooldownThresholdCents,
      h: checked.cooldownHours,
      e: this.enabledFlag,
      d: this.disclosureAccepted
    })
    if (!this.pendingSaveKey || this.lastSaveSignature !== signature) {
      this.pendingSaveKey = util.generateRandomUUID(true)
      this.lastSaveSignature = signature
    }
    const input: SpendingRuleInput = {
      requestKey: this.pendingSaveKey,
      expectedVersion: this.currentRuleVersion,
      monthlyBudgetCents: checked.monthlyBudgetCents,
      perOrderLimitCents: checked.perOrderLimitCents,
      cooldownThresholdCents: checked.cooldownThresholdCents,
      cooldownHours: checked.cooldownHours,
      enabled: this.enabledFlag,
      disclosureAccepted: this.disclosureAccepted
    }
    const sessionSeq = this.sessionSeq
    const token = this.user.token || ''
    const account = this.user.id || ''
    this.busy = true
    this.message = ''
    try {
      const saved = await saveSpendingRuleAPI(input, token)
      if (!this.sameSession(sessionSeq, token, account)) {
        return
      }
      this.pendingSaveKey = ''
      this.lastSaveSignature = ''
      this.applyRule(saved)
      this.message = `已保存规则 v${saved.version}`
      await this.load(true)
    } catch (error) {
      if (!this.sameSession(sessionSeq, token, account)) {
        return
      }
      const err = error as SpendingRequestError
      const status = err.httpStatus || err.response?.status || 0
      const reason = err.response?.data?.reason
      this.message = spendingSaveErrorMessage(status, reason)
      if (status === 409) {
        this.pendingSaveKey = ''
        this.lastSaveSignature = ''
        await this.load(true)
      }
    } finally {
      if (this.sameSession(sessionSeq, token, account)) {
        this.busy = false
      }
    }
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: '花钱设置',
          onLeftClick: () => this.stackPath.pop()
        })
        Scroll() {
          Column({ space: 14 }) {
            // 顶部自然月与跨月退款口径显式说明
            Column({ space: 8 }) {
              Text('自然月额度说明').id('spending-disclosure-title').fontSize(15).fontWeight(FontWeight.Medium).fontColor($r('[ui_components].color.text'))
              Text(this.monthDisclosure).id('spending-disclosure-body').fontSize(13).fontColor($r('[ui_components].color.gray'))
              Row({ space: 8 }) {
                Checkbox().id('spending-disclosure-checkbox').select(this.disclosureAccepted)
                  .selectedColor($r('[ui_components].color.red')).size({ width: 20, height: 20 })
                  .enabled(!this.busy && !this.loading)
                  .onChange((value: boolean) => { this.disclosureAccepted = value })
                Text('我已知晓本月花费按北京时间自然月计算，跨月退款不回补上月额度')
                  .fontSize(13).fontColor($r('[ui_components].color.text')).layoutWeight(1)
                  .onClick(() => { if (!this.busy && !this.loading) this.disclosureAccepted = !this.disclosureAccepted })
              }.width('100%')
            }.width('100%').padding(14).alignItems(HorizontalAlign.Start).backgroundColor($r('[ui_components].color.white')).borderRadius(12)

            if (this.summary) {
              Column({ space: 6 }) {
                Text(`${this.summary.monthKey} 本月花钱情况`).id('spending-summary-title').fontSize(15).fontWeight(FontWeight.Medium).fontColor($r('[ui_components].color.text'))
                Text(`当前生效规则：v${this.summary.ruleVersion}（${this.summary.enabled ? '已启用' : '未启用'}）`).id('spending-summary-rule').fontSize(13).fontColor($r('[ui_components].color.gray'))
                Text(`已付花费：${formatSpendingYuan(this.summary.spentCents)} · 在途占额：${formatSpendingYuan(this.summary.reservedCents)}`).id('spending-summary-spent').fontSize(14).fontColor($r('[ui_components].color.text'))
                Text(`本月剩余预算：${this.summary.remainingBudgetCents === null ? '不限' : formatSpendingYuan(this.summary.remainingBudgetCents)} · 待买清单：${this.summary.waitingWishlistCount} 项`).id('spending-summary-remaining').fontSize(13).fontColor($r('[ui_components].color.text'))
              }.width('100%').padding(14).alignItems(HorizontalAlign.Start).backgroundColor($r('[ui_components].color.white')).borderRadius(12)
            }

            Column({ space: 10 }) {
              Row({ space: 12 }) {
                Text('启用花钱保护规则').fontSize(15).fontWeight(FontWeight.Medium).fontColor($r('[ui_components].color.text')).layoutWeight(1)
                Toggle({ type: ToggleType.Switch, isOn: this.enabledFlag }).id('spending-enabled-toggle')
                  .selectedColor($r('[ui_components].color.red')).enabled(!this.busy && !this.loading)
                  .onChange((value: boolean) => { this.enabledFlag = value })
              }.width('100%')

              Text('月度预算（元，留空表示不限）').fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
              TextInput({ text: this.monthlyBudgetText, placeholder: '例如 500.00' }).id('spending-monthly-input')
                .type(InputType.NUMBER_DECIMAL).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.under'))
                .enabled(!this.busy && !this.loading).onChange((value: string) => { this.monthlyBudgetText = value })

              Text('单笔限额（元，留空表示不限）').fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
              TextInput({ text: this.perOrderLimitText, placeholder: '例如 200.00' }).id('spending-per-order-input')
                .type(InputType.NUMBER_DECIMAL).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.under'))
                .enabled(!this.busy && !this.loading).onChange((value: string) => { this.perOrderLimitText = value })

              Text('冷静触发金额（元，达到或超过时转入待买清单）').fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
              TextInput({ text: this.cooldownAmountText, placeholder: '例如 100.00' }).id('spending-cooldown-amount-input')
                .type(InputType.NUMBER_DECIMAL).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.under'))
                .enabled(!this.busy && !this.loading).onChange((value: string) => { this.cooldownAmountText = value })

              Text('冷静时长（小时，1 至 72 整数）').fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
              TextInput({ text: this.cooldownHoursText, placeholder: '例如 24' }).id('spending-cooldown-hours-input')
                .type(InputType.Number).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.under'))
                .enabled(!this.busy && !this.loading).onChange((value: string) => { this.cooldownHoursText = value })
            }.width('100%').padding(14).alignItems(HorizontalAlign.Start).backgroundColor($r('[ui_components].color.white')).borderRadius(12)

            if (this.message) {
              Text(this.message).id('spending-message').fontSize(14).fontColor($r('[ui_components].color.red')).width('100%')
            }

            Button(this.busy ? '正在保存' : '保存花钱设置').id('spending-save-button')
              .backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary')).width('100%').height(44)
              .enabled(!this.busy && !this.loading).onClick(() => { void this.save() })

            Row({ space: 10 }) {
              Button('查看待买清单').id('spending-open-wishlist').layoutWeight(1).height(42)
                .backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.text'))
                .border({ width: 1, color: $r('[ui_components].color.border') })
                .onClick(() => { this.stackPath.pushPath({ name: 'WishlistView' }) })
              Button('重新加载').id('spending-reload-button').layoutWeight(1).height(42)
                .backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red'))
                .border({ width: 1, color: $r('[ui_components].color.red') })
                .enabled(!this.busy && !this.loading).onClick(() => { void this.load() })
            }.width('100%')

            if (this.history.length > 0) {
              Column({ space: 6 }) {
                Text('规则修改记录').id('spending-history-title').fontSize(15).fontWeight(FontWeight.Medium).fontColor($r('[ui_components].color.text'))
                ForEach(this.history, (rule: SpendingRule) => {
                  Text(`${formatSpendingRuleLine(rule)} · ${formatBeijingTime(rule.createdAt)}`)
                    .id('spending-rule-v' + rule.version).fontSize(12).fontColor($r('[ui_components].color.gray')).width('100%')
                }, (rule: SpendingRule) => rule.id || String(rule.version))
              }.width('100%').padding(14).alignItems(HorizontalAlign.Start).backgroundColor($r('[ui_components].color.white')).borderRadius(12)
            }
          }.width('100%').padding(16)
        }.layoutWeight(1).width('100%')
      }.width('100%').height('100%').padding({ top: this.safeTop, bottom: this.safeBottom }).backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true).onShown(() => this.shown()).onHidden(() => this.aboutToDisappear())
  }
}
