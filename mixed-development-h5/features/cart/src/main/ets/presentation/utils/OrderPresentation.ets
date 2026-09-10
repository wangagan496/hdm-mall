/**
 * 订单状态码与倒计时的展示口径。
 * 列表页、详情页和支付结果页共用同一套映射，避免各页面各写一份导致状态文案不一致。
 */

export function getOrderStateText(orderState: number): string {
  if (orderState === 1) {
    return '待付款'
  }
  if (orderState === 2) {
    return '待发货'
  }
  if (orderState === 3) {
    return '待收货'
  }
  if (orderState === 4) {
    return '待评价'
  }
  if (orderState === 5) {
    return '已完成'
  }
  if (orderState === 6) {
    return '已取消'
  }
  return '订单处理中'
}

/** 服务端 orderState 2-4 视为已付款。 */
export function isPaidOrderState(orderState: number): boolean {
  return orderState >= 2 && orderState <= 4
}

export function formatOrderCountdown(countdown: number): string {
  if (countdown <= 0) {
    return '已超时，等待系统取消'
  }
  const minutes: number = Math.floor(countdown / 60)
  const seconds: number = countdown % 60
  const mm: string = minutes < 10 ? '0' + minutes.toString() : minutes.toString()
  const ss: string = seconds < 10 ? '0' + seconds.toString() : seconds.toString()
  return '剩 ' + mm + ':' + ss + ' 自动取消'
}
