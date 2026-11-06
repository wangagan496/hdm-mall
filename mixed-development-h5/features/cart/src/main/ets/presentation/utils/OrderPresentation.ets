import { DemoOrderOverlay, LocalEvaluationItem, OrderItem, OrderRefund, OrderState, formatBeijingTime } from 'models'
import { systemDateTime } from '@kit.BasicServicesKit'

/**
 * 订单状态码与倒计时的展示口径。
 * 列表页、详情页和支付结果页共用同一套映射，避免各页面各写一份导致状态文案不一致。
 */

// 保留原导出位置，现有订单页面继续使用同一套状态名称。
export { OrderState } from 'models'

export function getOrderStateText(orderState: number): string {
  if (orderState === OrderState.AWAITING_PAYMENT) {
    return '待付款'
  }
  if (orderState === OrderState.AWAITING_SHIPMENT) {
    return '待发货'
  }
  if (orderState === OrderState.AWAITING_RECEIPT) {
    return '待收货'
  }
  if (orderState === OrderState.AWAITING_REVIEW) {
    return '待评价'
  }
  if (orderState === OrderState.COMPLETED) {
    return '已完成'
  }
  if (orderState === OrderState.CANCELLED) {
    return '已取消'
  }
  return '订单处理中'
}

/** 列表/详情展示口径：已提交评价时，完成态显示「已评价」而不是笼统的「已完成」。 */
export function getDisplayOrderStateText(orderState: number, evaluated: boolean): string {
  if (evaluated && orderState === OrderState.COMPLETED) {
    return '已评价'
  }
  return getOrderStateText(orderState)
}

export function getPaymentDisplayLabel(order: OrderItem): string {
  if (order.cancelRequest?.state === 'pending') return '取消申请审核中'
  if (order.orderState === OrderState.CANCELLED) {
    const states: string[] = []
    order.refunds?.forEach((refund: OrderRefund) => {
      if (!states.includes(refund.state)) states.push(refund.state)
    })
    return '已取消' + (states.length > 0 ? ' · ' + states.join(' · ') : '')
  }
  if (order.orderState === OrderState.AWAITING_PAYMENT) {
    if (order.paymentState === 'confirming') return '确认中'
    if (order.paymentState === 'review') return '核实中'
  }
  return getDisplayOrderStateText(order.orderState, !!order.evaluation)
}

export function shouldShowPaymentCountdown(order: OrderItem): boolean {
  return order.orderState === OrderState.AWAITING_PAYMENT &&
    order.paymentState !== 'confirming' && order.paymentState !== 'review'
}

export function canOpenPayment(order: OrderItem): boolean {
  return order.orderState === OrderState.AWAITING_PAYMENT &&
    (order.serverManaged ? order.canPay === true : true) &&
    order.paymentState !== 'confirming' && order.paymentState !== 'review'
}

export function hasUnreadPaymentNotice(order: OrderItem): boolean {
  return order.needsAttention === true
}

export function getRefundDisplayLine(refund: OrderRefund): string {
  const paidAt: string = refund.paidAt === null ? '付款时间待确认' : formatBeijingTime(refund.paidAt)
  return '¥' + refund.amount.toFixed(2) + ' · ' + refund.payerAccount + ' · ' + paidAt + ' · ' + refund.state
}

/**
 * 这笔订单该不该出现在当前栏目里。
 * “全部”栏目包含已取消订单；其他栏目只显示状态相同的订单。
 */
export function isOrderStateInTab(orderState: number, tabState: number): boolean {
  return tabState === OrderState.ALL_TAB || orderState === tabState
}

/** 待发货、待收货、待评价、已完成都说明已经付过款。 */
export function isPaidOrderState(orderState: number): boolean {
  return orderState >= OrderState.AWAITING_SHIPMENT && orderState <= OrderState.COMPLETED
}

/**
 * 系统启动后经过的毫秒数，包含睡眠时间，不受用户修改日期影响。
 */
export function readPhoneClockMillis(): number {
  return systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false)
}

/**
 * 待付款还剩几秒 = 服务端给的剩余秒数 − 拿到订单后过去的秒数，最少是 0。
 * receivedAt 是拿到订单那一刻读的手机时钟。
 */
export function secondsLeftToPay(serverCountdown: number, receivedAt: number): number {
  const elapsedSeconds: number = Math.max(0, Math.floor((readPhoneClockMillis() - receivedAt) / 1000))
  return Math.max(serverCountdown - elapsedSeconds, 0)
}

export function formatOrderCountdown(countdown: number): string {
  if (countdown <= 0) {
    return '已超时，等待系统取消'
  }
  const minutes: number = Math.floor(countdown / 60)
  const seconds: number = countdown % 60
  const minuteText: string = minutes < 10 ? '0' + minutes.toString() : minutes.toString()
  const secondText: string = seconds < 10 ? '0' + seconds.toString() : seconds.toString()
  return '剩 ' + minuteText + ':' + secondText + ' 自动取消'
}

/**
 * 把服务端的订单状态与本地演示叠加层合并。规则：
 * 1. 服务端取消（6）永远最高优先级，不被本地演示覆盖。
 * 2. 本地演示只能在订单仍处于"待付款 → 待发货 → 待收货 → 待评价 → 已评价"这条链上单向推进，
 *    不允许把状态向前回退。
 * 3. 如果服务端已经先推进到比本地演示更靠后的状态，保留服务端结果。
 */
export function mergeOrderState(
  order: OrderItem,
  overlay: DemoOrderOverlay | null,
  evaluation: LocalEvaluationItem | null
): number {
  const serverState: number = order.orderState
  if (order.serverManaged) {
    return serverState
  }
  if (serverState === OrderState.CANCELLED) {
    return OrderState.CANCELLED
  }
  let merged: number = serverState
  if (overlay && overlay.advancedState > merged && isPaidOrderState(overlay.advancedState)) {
    merged = overlay.advancedState
  }
  if (evaluation && merged >= OrderState.AWAITING_REVIEW) {
    merged = OrderState.COMPLETED
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
