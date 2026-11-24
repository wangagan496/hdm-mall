import { describe, it, expect } from '@ohos/hypium'
import { OrderItem, PriceProtectionBrief } from 'models'
import {
  hasOrderProtection,
  formatOrderProtectionBudget,
  formatOrderProtectionEffective
} from '../main/ets/presentation/utils/OrderPresentation'

function sampleOrder(brief: PriceProtectionBrief | null | undefined): OrderItem {
  return {
    id: 'order-1',
    createTime: '2026-11-23 12:00:00',
    orderState: 2,
    payChannel: 1,
    payLatestTime: '',
    payType: 1,
    postFee: 0,
    payMoney: 99,
    totalMoney: 99,
    totalNum: 1,
    countdown: 0,
    skus: [],
    protectionBrief: brief
  }
}

export default function protectionCartTest(): void {
  describe('orderProtectionPresentation', () => {
    it('hidesProtectionBlockWhenBriefIsNullOrAbsent', 0, () => {
      expect(hasOrderProtection(null)).assertFalse()
      expect(hasOrderProtection(sampleOrder(null))).assertFalse()
      expect(hasOrderProtection(sampleOrder(undefined))).assertFalse()
    })

    it('formatsReadonlyProtectionBriefWhenPresent', 0, () => {
      const brief: PriceProtectionBrief = {
        policyId: 'policy-1',
        windowDays: 7,
        budgetPerOrderCents: 1250,
        effectiveAt: Date.UTC(2026, 10, 20, 4, 30, 0),
        announcedAt: Date.UTC(2026, 10, 19, 4, 30, 0),
        receiptId: 'receipt-1'
      }
      expect(hasOrderProtection(sampleOrder(brief))).assertTrue()
      expect(formatOrderProtectionBudget(brief)).assertEqual('单笔最多补 ¥12.50')
      expect(formatOrderProtectionEffective(brief)).assertContain('2026-11-20 12:30')
    })
  })
}
