import { SpendingRule, WishlistItem, amountInputCents, formatBeijingTime } from 'models'

export const DEFAULT_MONTH_DISCLOSURE =
  '按北京时间自然月计算，本月已付计已花，待付/待确认计在途占额；同月成功退款回补当月额度，跨月退款不回补上月额度。'

export interface SpendingRuleValidation {
  error: string
  monthlyBudgetCents: number | null
  perOrderLimitCents: number | null
  cooldownThresholdCents: number | null
  cooldownHours: number | null
}

const MAX_CENTS = 2147483647

function parseOptionalCents(rawText: string, label: string): number | null {
  const trimmed = rawText.trim()
  if (!trimmed) {
    return null
  }
  const cents = amountInputCents(trimmed)
  if (cents < 1 || cents > MAX_CENTS) {
    return -1
  }
  return cents
}

export function validateSpendingRuleFields(
  monthlyText: string,
  perOrderText: string,
  cooldownAmountText: string,
  cooldownHoursText: string,
  enabled: boolean,
  disclosureAccepted: boolean
): SpendingRuleValidation {
  const monthlyBudgetCents = parseOptionalCents(monthlyText, '月度预算')
  if (monthlyBudgetCents === -1) {
    return { error: '月度预算需在 0.01 至 21474836.47 元之间', monthlyBudgetCents: null, perOrderLimitCents: null, cooldownThresholdCents: null, cooldownHours: null }
  }
  const perOrderLimitCents = parseOptionalCents(perOrderText, '单笔限额')
  if (perOrderLimitCents === -1) {
    return { error: '单笔限额需在 0.01 至 21474836.47 元之间', monthlyBudgetCents: null, perOrderLimitCents: null, cooldownThresholdCents: null, cooldownHours: null }
  }
  const cooldownThresholdCents = parseOptionalCents(cooldownAmountText, '冷静阈值')
  if (cooldownThresholdCents === -1) {
    return { error: '冷静触发金额需在 0.01 至 21474836.47 元之间', monthlyBudgetCents: null, perOrderLimitCents: null, cooldownThresholdCents: null, cooldownHours: null }
  }

  const hoursTrimmed = cooldownHoursText.trim()
  let cooldownHours: number | null = null
  if (cooldownThresholdCents !== null) {
    if (!/^\d+$/.test(hoursTrimmed)) {
      return { error: '设置冷静阈值时请填写 1 到 72 小时的整数时长', monthlyBudgetCents: null, perOrderLimitCents: null, cooldownThresholdCents: null, cooldownHours: null }
    }
    const parsedHours = Number(hoursTrimmed)
    if (parsedHours < 1 || parsedHours > 72) {
      return { error: '冷静时长需在 1 到 72 小时之间', monthlyBudgetCents: null, perOrderLimitCents: null, cooldownThresholdCents: null, cooldownHours: null }
    }
    cooldownHours = parsedHours
  } else if (hoursTrimmed) {
    return { error: '设置冷静时长前请先填写冷静触发金额', monthlyBudgetCents: null, perOrderLimitCents: null, cooldownThresholdCents: null, cooldownHours: null }
  }

  if (enabled) {
    if (!disclosureAccepted) {
      return { error: '启用前请先勾选并确认自然月与跨月退款口径说明', monthlyBudgetCents: null, perOrderLimitCents: null, cooldownThresholdCents: null, cooldownHours: null }
    }
    if (monthlyBudgetCents === null && perOrderLimitCents === null && cooldownThresholdCents === null) {
      return { error: '请至少设置月度预算、单笔限额或冷静阈值中的一项', monthlyBudgetCents: null, perOrderLimitCents: null, cooldownThresholdCents: null, cooldownHours: null }
    }
  }

  return { error: '', monthlyBudgetCents, perOrderLimitCents, cooldownThresholdCents, cooldownHours }
}

export function centsToInputText(cents: number | null): string {
  if (cents === null) {
    return ''
  }
  return (cents / 100).toFixed(2)
}

export function formatSpendingYuan(cents: number | null): string {
  if (cents === null) {
    return '未设'
  }
  return '¥' + (cents / 100).toFixed(2)
}

export function formatSpendingRuleLine(rule: SpendingRule): string {
  const status = rule.enabled ? '启用' : '停用'
  return `v${rule.version}（${status}）· 月度 ${formatSpendingYuan(rule.monthlyBudgetCents)} · 单笔 ${formatSpendingYuan(rule.perOrderLimitCents)}`
}

export function formatWishlistCooldownTime(cooldownUntil: number): string {
  return formatBeijingTime(cooldownUntil)
}

export function wishlistItemHeadline(item: WishlistItem): string {
  if (item.goods.length === 0) {
    return '待买商品'
  }
  const first = item.goods[0]
  if (item.goods.length === 1) {
    return `${first.name}（${first.spec}）×${first.count}`
  }
  return `${first.name} 等 ${item.goods.length} 项`
}

export function wishlistStateLabel(item: WishlistItem): string {
  if (item.status === 'waiting') {
    return item.readyToConfirm ? '冷静期已结束，待本人确认' : '冷静期等待中'
  }
  if (item.status === 'cancelled') {
    return '已取消'
  }
  if (item.status === 'confirmed') {
    return '已确认下单'
  }
  if (item.status === 'expired') {
    return '已失效'
  }
  return item.status
}

export function spendingSaveErrorMessage(status: number, reason?: string): string {
  if (status === 409) {
    if (reason === 'SPENDING_RULE_VERSION_CHANGED') {
      return '规则版本已更新，已为您刷新最新设置，请核对后再保存'
    }
    return '保存请求冲突，请刷新后重试'
  }
  if (status === 403 || status === 401) {
    return '当前账号无权或登录已失效，请重新登录买家账号'
  }
  return '保存失败，请检查参数后重试'
}

export function wishlistActionErrorMessage(status: number, reason?: string, message?: string): string {
  if (status === 403) {
    return '无权操作他人待买记录'
  }
  if (reason === 'COOLDOWN_ACTIVE') {
    return '冷静期尚未结束，请于到期后再本人确认'
  }
  if (reason === 'PRICE_CHANGED') {
    return '商品价格或满减已更新，请核对新报价后点击重新核价确认'
  }
  if (reason === 'RETURN_POLICY_CHANGED') {
    return '商品退货规则已更新，请阅读下方新规则并勾选确认后提交'
  }
  if (reason === 'RETURN_POLICY_CONFIRM_REQUIRED') {
    return '请先了解并勾选商品退货限制后再确认下单'
  }
  if (reason === 'PRODUCT_UNAVAILABLE') {
    return '部分商品已下架或停售，无法确认下单'
  }
  if (reason === 'SPENDING_PAUSED') {
    return message || '当前超出花钱限制，已暂停确认下单'
  }
  return message || '操作失败，请刷新重试'
}
