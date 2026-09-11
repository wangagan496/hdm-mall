import { DemoOrderOverlay, LocalEvaluationItem, OrderItem } from 'models'

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

/**
 * 把服务端的订单状态与本地演示叠加层合并。规则：
 * 1. 服务端取消（6）永远最高优先级，不被本地演示覆盖。
 * 2. 本地演示只能在订单仍处于"待付款 → 待发货 → 待收货 → 待评价 → 已完成"这条链上单向推进，
 *    不允许把状态向前回退。
 * 3. 如果服务端已经先推进到比本地演示更靠后的状态，保留服务端结果。
 */
export function mergeOrderState(
  order: OrderItem,
  overlay: DemoOrderOverlay | null,
  evaluation: LocalEvaluationItem | null
): number {
  const serverState: number = order.orderState
  if (serverState === 6) {
    return 6
  }
  let merged: number = serverState
  if (overlay && overlay.advancedState > merged && overlay.advancedState >= 2 && overlay.advancedState <= 5) {
    merged = overlay.advancedState
  }
  if (evaluation && merged >= 4) {
    merged = 5
  }
  return merged
}

export function isDemoOverlayApplied(
  order: OrderItem,
  overlay: DemoOrderOverlay | null,
  evaluation: LocalEvaluationItem | null
): boolean {
  return mergeOrderState(order, overlay, evaluation) !== order.orderState
}
