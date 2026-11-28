import { OrderSpendingSummary, SpendingPauseDetail, formatBeijingTime } from 'models'

export function formatYuanFromCents(cents: number): string {
  return '¥' + (cents / 100).toFixed(2)
}

export function formatCooldownUntilText(cooldownUntil: number): string {
  return formatBeijingTime(cooldownUntil)
}

export function spendingPauseHeadline(detail: SpendingPauseDetail): string {
  if (detail.limitType === 'per_order') {
    return '本次金额已超过您设定的单笔限额，已暂停下单'
  }
  return '本月已花与在途订单加上本次金额已超出月度预算，已暂停下单'
}

export function spendingPauseSummaryText(detail: SpendingPauseDetail): string {
  const label = detail.limitType === 'per_order' ? '单笔上限' : '月度预算'
  return `本次 ${formatYuanFromCents(detail.amountCents)} · ${label} ${formatYuanFromCents(detail.limitCents)} · 规则 v${detail.ruleVersion}`
}

export function spendingPauseRemainingText(detail: SpendingPauseDetail): string {
  const base = `${detail.monthKey} 已花 ${formatYuanFromCents(detail.spentCents)} · 在途 ${formatYuanFromCents(detail.reservedCents)}`
  if (detail.remainingBudgetCents === null) {
    return base
  }
  return `${base} · 本月剩余 ${formatYuanFromCents(detail.remainingBudgetCents)}`
}

export function spendingOrderSummaryText(spending?: OrderSpendingSummary): string {
  if (!spending || !spending.enabled) {
    return ''
  }
  if (spending.remainingBudgetCents === null) {
    return `${spending.monthKey}（规则 v${spending.ruleVersion}）本月已花 ${formatYuanFromCents(spending.spentCents)}`
  }
  return `${spending.monthKey}（规则 v${spending.ruleVersion}）已花 ${formatYuanFromCents(spending.spentCents)} · 剩余预算 ${formatYuanFromCents(spending.remainingBudgetCents)}`
}

export function wishlistStatusLabel(status: string, readyToConfirm: boolean): string {
  if (status === 'waiting') {
    return readyToConfirm ? '冷静期已结束，待本人确认' : '冷静期等待中'
  }
  if (status === 'cancelled') {
    return '已取消'
  }
  if (status === 'confirmed') {
    return '已确认下单'
  }
  if (status === 'expired') {
    return '已失效'
  }
  return status
}

export function wishlistConfirmErrorMessage(status: number, reason?: string, message?: string): string {
  if (status === 403) {
    return '无权操作他人待买记录'
  }
  if (reason === 'COOLDOWN_ACTIVE') {
    return '冷静期尚未结束，请于到期后再本人确认'
  }
  if (reason === 'PRICE_CHANGED') {
    return '商品价格或满减已更新，已刷新最新报价，请核对后再确认'
  }
  if (reason === 'PRODUCT_UNAVAILABLE') {
    return '部分商品已下架或停售，无法确认下单'
  }
  if (reason === 'SPENDING_PAUSED') {
    return message || '当前消费保护限额已暂停下单，请前往花钱设置核对预算'
  }
  if (reason === 'WISHLIST_ALREADY_CONFIRMED') {
    return '该待买记录已确认下单，请刷新查看'
  }
  return message || '待买确认失败，请稍后重试'
}
