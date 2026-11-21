const rule = { enabled: true, revision: 1, thresholdCents: 9900, discountCents: 1000 }
const line = { skuId: 'a', productName: '蓝牙耳机', spec: '黑色', count: 1, unitPriceCents: 9900, subtotalCents: 9900, productRevision: 1, observedAt: 123 }
const response = {
  quoteId: 'ABC123', observedAt: 123, receipt: 'signed-fixture', lines: [line],
  promotion: { rule, hit: true, appliedDiscountCents: 1000, remainingCents: 0 },
  subtotalCents: 9900, amountCents: 8900,
  details: [{ label: '实付', rule: 'quote-v1', ruleVersion: 1, moneyCents: 8900 }],
  removals: [{ skuId: 'a', removedCount: 1, amountWithoutCents: 0, decreaseCents: 8900, losesPromotion: true, remainingCents: 9900 }], comparison: null
}
export const quoteVectors = [
  { name: 'cartSelection', kind: 'request', valid: true, value: {} },
  { name: 'explicitSelection', kind: 'request', valid: true, value: { items: [{ skuId: 'a', count: 2 }], previousReceipt: 'opaque' } },
  { name: 'emptyBasket', kind: 'request', valid: true, value: { items: [] } },
  { name: 'missingSku', kind: 'request', valid: false, value: { items: [{ count: 1 }] } },
  { name: 'emptySku', kind: 'request', valid: false, value: { items: [{ skuId: '', count: 1 }] } },
  { name: 'zeroCount', kind: 'request', valid: false, value: { items: [{ skuId: 'a', count: 0 }] } },
  { name: 'negativeCount', kind: 'request', valid: false, value: { items: [{ skuId: 'a', count: -1 }] } },
  { name: 'fractionCount', kind: 'request', valid: false, value: { items: [{ skuId: 'a', count: 1.1 }] } },
  { name: 'stringCount', kind: 'request', valid: false, value: { items: [{ skuId: 'a', count: '1' }] } },
  { name: 'tooManyCount', kind: 'request', valid: false, value: { items: [{ skuId: 'a', count: 1000 }] } },
  { name: 'extraOldPrice', kind: 'request', valid: false, value: { items: [{ skuId: 'a', count: 1, price: 1 }] } },
  { name: 'nullItems', kind: 'request', valid: false, value: { items: null } },
  { name: 'unknownRoot', kind: 'request', valid: false, value: { oldAmount: 1 } },
  { name: 'nullRequest', kind: 'request', valid: false, value: null },
  { name: 'readyQuote', kind: 'response', valid: true, value: response },
  { name: 'comparedQuote', kind: 'response', valid: true, value: { ...response, comparison: {
    previousQuoteId: 'OLD123', previousAmountCents: 8800, deltaCents: 100, beforeRule: rule, afterRule: rule,
    reasons: [{ kind: 'unit-price', skuId: 'a', message: '『蓝牙耳机 黑色』单价从 ¥98.00 调到 ¥99.00', beforeCents: 9800, afterCents: 9900 }]
  } } },
  { name: 'unsafeMoney', kind: 'response', valid: false, value: { ...response, amountCents: 9007199254740992 } },
  { name: 'fractionMoney', kind: 'response', valid: false, value: { ...response, amountCents: 0.1 } },
  { name: 'missingObservation', kind: 'response', valid: false, value: { ...response, observedAt: undefined } },
  { name: 'badNestedLine', kind: 'response', valid: false, value: { ...response, lines: [{ ...line, count: 0 }] } },
  { name: 'missingProductName', kind: 'response', valid: false, value: { ...response, lines: [{ ...line, productName: undefined }] } },
  { name: 'emptySpec', kind: 'response', valid: false, value: { ...response, lines: [{ ...line, spec: '' }] } },
  { name: 'extraFee', kind: 'response', valid: false, value: { ...response, shipping: 0 } },
  { name: 'nullResponse', kind: 'response', valid: false, value: null }
]
