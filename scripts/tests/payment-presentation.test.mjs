import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf } from './native-harness.mjs'

const source = sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/utils/OrderPresentation.ets')
const { formatBeijingTime } = execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/TimeFormat.ets'))
const presentation = execute(source, {
  models: { OrderState: { ALL_TAB: 0, AWAITING_PAYMENT: 1, AWAITING_SHIPMENT: 2, AWAITING_RECEIPT: 3,
    AWAITING_REVIEW: 4, COMPLETED: 5, CANCELLED: 6 }, formatBeijingTime },
  '@kit.BasicServicesKit': { systemDateTime: { TimeType: { STARTUP: 0 }, getUptime: () => 0 } },
})

test('确认中和核实中仍属待付款，但隐藏倒计时与去支付入口', () => {
  for (const [paymentState, expected] of [['confirming', '确认中'], ['review', '核实中']]) {
    const order = { orderState: 1, serverManaged: true, canPay: true, paymentState }
    assert.equal(presentation.getPaymentDisplayLabel(order), expected)
    assert.equal(presentation.shouldShowPaymentCountdown(order), false)
    assert.equal(presentation.canOpenPayment(order), false)
  }
})

test('可重新付款的待付款订单仍显示倒计时和支付入口', () => {
  const order = { orderState: 1, serverManaged: true, canPay: true, paymentState: 'none' }
  assert.equal(presentation.getPaymentDisplayLabel(order), '待付款')
  assert.equal(presentation.shouldShowPaymentCountdown(order), true)
  assert.equal(presentation.canOpenPayment(order), true)
  assert.equal(presentation.canOpenPayment({ ...order, canPay: false }), false)
})

test('退款展示行包含金额、付款人、付款时间和状态', () => {
  const line = presentation.getRefundDisplayLine({ amount: 24.5, payerAccount: 'payer-a', paidAt: Date.UTC(2026, 10, 5, 8), state: '退款中' })
  assert.match(line, /¥24\.50/)
  assert.match(line, /payer-a/)
  assert.match(line, /2026-11-05 16:00/)
  assert.match(line, /退款中/)
})

test('红点只在订单有未读支付提醒时出现', () => {
  assert.equal(presentation.hasUnreadPaymentNotice({ needsAttention: true }), true)
  assert.equal(presentation.hasUnreadPaymentNotice({ needsAttention: false }), false)
  assert.equal(presentation.hasUnreadPaymentNotice({}), false)
})

test('2026-11-06：已取消只出现在全部栏目，无倒计时和付款入口', () => {
  assert.equal(presentation.isOrderStateInTab(6, 0), true)
  for (const tab of [1, 2, 3, 4, 5]) assert.equal(presentation.isOrderStateInTab(6, tab), false)
  const order = { orderState: 6, canPay: true, paymentState: 'confirming', countdown: 100 }
  assert.equal(presentation.shouldShowPaymentCountdown(order), false)
  assert.equal(presentation.canOpenPayment(order), false)
  assert.equal(presentation.getPaymentDisplayLabel(order), '已取消')
})

test('已取消卡片附带各笔退款状态且逐笔金额付款人时间不丢失', () => {
  const refunds = [
    { id: 'a', amount: 19, payerAccount: 'buyer', paidAt: null, state: '退款中' },
    { id: 'b', amount: 20, payerAccount: 'friend', paidAt: null, state: '已退款' },
    { id: 'c', amount: 21, payerAccount: 'friend', paidAt: null, state: '退款中' },
  ]
  assert.equal(presentation.getPaymentDisplayLabel({ orderState: 6, refunds }), '已取消 · 退款中 · 已退款')
  for (const refund of refunds) assert.equal(presentation.getRefundDisplayLine(refund),
    `¥${refund.amount.toFixed(2)} · ${refund.payerAccount} · 付款时间待确认 · ${refund.state}`)
  for (const state of ['退款中', '已退款', '退款失败重试中']) {
    assert.equal(presentation.getPaymentDisplayLabel({ orderState: 6, refunds: [{ ...refunds[0], state }] }), `已取消 · ${state}`)
  }
})
