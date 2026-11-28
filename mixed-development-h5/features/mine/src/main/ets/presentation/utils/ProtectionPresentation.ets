import { PriceProtectionPolicy, amountInputCents } from 'models'

export interface ProtectionValidationResult {
  error: string
  windowDays: number
  budgetPerOrderCents: number
  totalBudgetCents: number
  effectiveDays: number
}

const MAX_CENTS = 2147483647

export function validateProtectionFields(
  windowDaysText: string,
  budgetPerOrderText: string,
  totalBudgetText: string,
  effectiveDaysText: string
): ProtectionValidationResult {
  const windowTrimmed = windowDaysText.trim()
  const offsetTrimmed = effectiveDaysText.trim()
  const windowDays = /^\d+$/.test(windowTrimmed) ? Number(windowTrimmed) : -1
  const effectiveDays = /^\d+$/.test(offsetTrimmed) ? Number(offsetTrimmed) : -1
  const budgetPerOrderCents = amountInputCents(budgetPerOrderText)
  const totalBudgetCents = amountInputCents(totalBudgetText)

  if (windowDays < 1 || windowDays > 90) {
    return { error: '保护天数需为 1 到 90 之间的整数', windowDays: 0, budgetPerOrderCents: 0, totalBudgetCents: 0, effectiveDays: 0 }
  }
  if (budgetPerOrderCents < 1 || budgetPerOrderCents > MAX_CENTS) {
    return { error: '单笔补差上限需在 0.01 至 21474836.47 元之间', windowDays: 0, budgetPerOrderCents: 0, totalBudgetCents: 0, effectiveDays: 0 }
  }
  if (totalBudgetCents < budgetPerOrderCents || totalBudgetCents > MAX_CENTS) {
    return { error: '总预算不得低于单笔上限且不超过 21474836.47 元', windowDays: 0, budgetPerOrderCents: 0, totalBudgetCents: 0, effectiveDays: 0 }
  }
  if (effectiveDays < 1 || effectiveDays > 30) {
    return { error: '生效需在 1 到 30 天之后', windowDays: 0, budgetPerOrderCents: 0, totalBudgetCents: 0, effectiveDays: 0 }
  }
  return { error: '', windowDays, budgetPerOrderCents, totalBudgetCents, effectiveDays }
}

export function findActiveProtectionPolicy(policies: PriceProtectionPolicy[], now: number): PriceProtectionPolicy | null {
  for (const policy of policies) {
    if (policy.published && policy.effectiveAt <= now) {
      return policy
    }
  }
  return null
}

export function formatProtectionYuan(cents: number): string {
  return '¥' + (cents / 100).toFixed(2)
}

export function buildProtectionConfirmSummary(windowDays: number, budgetPerOrderCents: number, effectiveDays: number): string {
  return '保护 ' + windowDays + ' 天，单笔最多 ' + formatProtectionYuan(budgetPerOrderCents) + '，' + effectiveDays + ' 天后生效。'
}

export function prepareProtectionErrorMessage(status: number): string {
  if (status === 409) {
    return '政策内容已变化，请重新填写'
  }
  if (status === 403) {
    return '权限或身份已失效，请重新登录'
  }
  return '准备发布失败，请重试'
}

export function publishProtectionErrorMessage(status: number): string {
  if (status === 409) {
    return '该版本已发布或凭据已用，请刷新后重试'
  }
  if (status === 403) {
    return '确认凭据已过期，请重新准备发布'
  }
  return '发布失败，请重试'
}
