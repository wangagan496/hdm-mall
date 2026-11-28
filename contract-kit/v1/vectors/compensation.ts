const line = { order_line_id: 'sku-1', delta_cents: 500 }
const draft = {
  draftId: 'draft-1',
  orderId: 'order-1',
  policyId: 'policy-1',
  policyVersion: 1,
  windowDays: 7,
  budgetPerOrderCents: 1000,
  basketDeltaCents: 500,
  cappedCents: 500,
  perLine: [line],
  createdAt: 1700000000000,
  expiresAt: 1700172800000,
  status: 'pending'
}
const receipt = {
  receiptId: 'receipt-1',
  draftId: 'draft-1',
  orderId: 'order-1',
  policyId: 'policy-1',
  policyVersion: 1,
  windowDays: 7,
  confirmedCents: 500,
  confirmedAt: 1700001000000,
  channelStatus: 'pending',
  channelRef: null,
  statusLabel: '补差已登记，渠道处理中'
}

export const compensationVectors = [
  { name: 'validDraftBrief', kind: 'CompensationDraftBrief', valid: true, value: draft },
  { name: 'pendingBudgetDraft', kind: 'CompensationDraftBrief', valid: true, value: { ...draft, status: 'pending_budget' } },
  { name: 'zeroCappedDraftRejected', kind: 'CompensationDraftBrief', valid: false, value: { ...draft, cappedCents: 0 } },
  { name: 'emptyPerLineRejected', kind: 'CompensationDraftBrief', valid: false, value: { ...draft, perLine: [] } },
  { name: 'validConfirmInput', kind: 'CompensationConfirmInput', valid: true, value: { draftId: 'draft-1', requestKey: 'req-1', confirmedCents: 500 } },
  { name: 'zeroConfirmCentsRejected', kind: 'CompensationConfirmInput', valid: false, value: { draftId: 'draft-1', requestKey: 'req-1', confirmedCents: 0 } },
  { name: 'validPendingReceipt', kind: 'CompensationReceipt', valid: true, value: receipt },
  { name: 'validUnknownReceipt', kind: 'CompensationReceipt', valid: true, value: { ...receipt, channelStatus: 'unknown', statusLabel: '待执行（渠道结果待核实）' } },
  { name: 'invalidChannelStatusRejected', kind: 'CompensationReceipt', valid: false, value: { ...receipt, channelStatus: 'settled' } },
  { name: 'extraFieldReceiptRejected', kind: 'CompensationReceipt', valid: false, value: { ...receipt, extra: 1 } }
]
