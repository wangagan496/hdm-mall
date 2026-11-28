import { CompensationDraftBrief, formatBeijingTime } from 'models'

export function formatCompensationAmount(cents: number): string {
  return '¥' + (cents / 100).toFixed(2)
}

export function formatCompensationExpiry(expiresAt: number): string {
  return formatBeijingTime(expiresAt)
}

export function compensationStatusLabel(channelStatus: string): string {
  if (channelStatus === 'executed') {
    return '补差已到账'
  }
  if (channelStatus === 'failed') {
    return '补差执行失败'
  }
  if (channelStatus === 'unknown') {
    return '待执行（渠道结果待核实）'
  }
  return '补差已登记，渠道处理中'
}

export function isCompensationDraftAvailable(draft: CompensationDraftBrief, now: number): boolean {
  return draft.status === 'pending' && draft.expiresAt > now
}

export function compensationConfirmErrorMessage(status: number, reason?: string): string {
  if (status === 403) {
    return '补差草稿已过期或无权确认，请刷新重算'
  }
  if (status === 400) {
    return '补差金额已变化，请刷新重算'
  }
  if (status === 409) {
    if (reason === 'COMPENSATION_CONDITION_CHANGED') {
      return '订单商品或价格条件已变化，已为您重算，请按新金额重新确认'
    }
    return '该补差已确认或超出订单可退余额，请刷新查看'
  }
  return '确认补差失败，请重试'
}
