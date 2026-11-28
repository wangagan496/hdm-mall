const goodsLine = {
  skuId: 'sku-1',
  productId: 'prod-1',
  name: '真皮托特包',
  spec: '黑色大号',
  picture: '/assets/bag.jpg',
  unitPriceCents: 60000,
  count: 1
}

const rule = {
  id: 'rule-1',
  version: 1,
  monthlyBudgetCents: 200000,
  perOrderLimitCents: 100000,
  cooldownThresholdCents: 50000,
  cooldownHours: 24,
  enabled: true,
  monthDisclosure: '按北京时间自然月计算，本月已付计已花，待付/待确认计在途占额；同月成功退款回补当月额度，跨月退款不回补上月额度。',
  createdAt: 1700000000000
}

const ruleInput = {
  requestKey: 'req-rule-1',
  expectedVersion: 0,
  monthlyBudgetCents: 200000,
  perOrderLimitCents: 100000,
  cooldownThresholdCents: 50000,
  cooldownHours: 24,
  enabled: true,
  disclosureAccepted: true
}

const summary = {
  monthKey: '2026-11',
  ruleVersion: 1,
  enabled: true,
  monthlyBudgetCents: 200000,
  perOrderLimitCents: 100000,
  cooldownThresholdCents: 50000,
  cooldownHours: 24,
  spentCents: 30000,
  reservedCents: 10000,
  remainingBudgetCents: 160000,
  waitingWishlistCount: 1,
  monthDisclosure: rule.monthDisclosure
}

const pauseDetail = {
  limitType: 'monthly_budget',
  amountCents: 170000,
  limitCents: 200000,
  ruleVersion: 1,
  monthKey: '2026-11',
  spentCents: 30000,
  reservedCents: 10000,
  remainingBudgetCents: 160000
}

const wishlistItem = {
  id: 'wish-1',
  requestKey: 'req-wish-1',
  status: 'waiting',
  goods: [goodsLine],
  addressId: 'addr-1',
  expectedAmountCents: 60000,
  quotedTotalCents: 60000,
  currentQuotedTotalCents: 60000,
  priceChanged: false,
  promotionRevision: 1,
  ruleVersion: 1,
  cooldownUntil: 1700086400000,
  readyToConfirm: false,
  createdAt: 1700000000000
}

export const spendingGuardVectors = [
  { name: 'validRule', kind: 'SpendingRule', valid: true, value: rule },
  { name: 'disabledDefaultRule', kind: 'SpendingRule', valid: true, value: { ...rule, id: null, version: 0, enabled: false, monthlyBudgetCents: null, perOrderLimitCents: null, cooldownThresholdCents: null, cooldownHours: null } },
  { name: 'badCooldownHoursOver72Rejected', kind: 'SpendingRule', valid: false, value: { ...rule, cooldownHours: 73 } },
  { name: 'validRuleInput', kind: 'SpendingRuleInput', valid: true, value: ruleInput },
  { name: 'zeroBudgetInputRejected', kind: 'SpendingRuleInput', valid: false, value: { ...ruleInput, monthlyBudgetCents: 0 } },
  { name: 'validSummary', kind: 'SpendingSummary', valid: true, value: summary },
  { name: 'validPauseMonthly', kind: 'SpendingPauseDetail', valid: true, value: pauseDetail },
  { name: 'invalidLimitTypeRejected', kind: 'SpendingPauseDetail', valid: false, value: { ...pauseDetail, limitType: 'daily_budget' } },
  { name: 'validWishlistItem', kind: 'WishlistItem', valid: true, value: wishlistItem },
  { name: 'emptyGoodsWishlistRejected', kind: 'WishlistItem', valid: false, value: { ...wishlistItem, goods: [] } },
  { name: 'validWishlistConfirmInput', kind: 'WishlistConfirmInput', valid: true, value: { requestKey: 'req-conf-1', expectedAmountCents: 60000 } },
  { name: 'validWishlistConfirmWithPolicyToken', kind: 'WishlistConfirmInput', valid: true, value: { requestKey: 'req-conf-2', expectedAmountCents: 60000, returnPolicyConfirmed: true, expectedReturnPolicyToken: 'a'.repeat(64) } },
  { name: 'badWishlistConfirmTokenLengthRejected', kind: 'WishlistConfirmInput', valid: false, value: { requestKey: 'req-conf-3', expectedAmountCents: 60000, returnPolicyConfirmed: true, expectedReturnPolicyToken: 'short' } },
  { name: 'zeroConfirmAmountRejected', kind: 'WishlistConfirmInput', valid: false, value: { requestKey: 'req-conf-1', expectedAmountCents: 0 } }
]
