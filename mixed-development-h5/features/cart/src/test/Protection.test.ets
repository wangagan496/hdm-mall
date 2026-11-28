import { describe, it, expect } from '@ohos/hypium'
import { OrderItem, PriceProtectionBrief, CompensationDraftBrief } from 'models'
import {
  hasOrderProtection,
  formatOrderProtectionBudget,
  formatOrderProtectionEffective
} from '../main/ets/presentation/utils/OrderPresentation'
import {
  formatCompensationAmount,
  formatCompensationExpiry,
  compensationStatusLabel,
  isCompensationDraftAvailable,
  compensationConfirmErrorMessage
} from '../main/ets/presentation/utils/CompensationPresentation'

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

    it('formatsCompensationDraftsAndChannelStatusesWithoutFakeSettlement', 0, () => {
      const now = 1700000000000
      const pendingDraft: CompensationDraftBrief = {
        draftId: 'd1', orderId: 'o1', policyId: 'p1', policyVersion: 2, windowDays: 7,
        budgetPerOrderCents: 2000, basketDeltaCents: 1500, cappedCents: 1500,
        perLine: [{ order_line_id: 's1', delta_cents: 1500 }],
        createdAt: now - 1000, expiresAt: now + 3600000, status: 'pending'
      }
      const expiredDraft: CompensationDraftBrief = {
        draftId: 'd2', orderId: 'o1', policyId: 'p1', policyVersion: 2, windowDays: 7,
        budgetPerOrderCents: 2000, basketDeltaCents: 1500, cappedCents: 1500,
        perLine: [{ order_line_id: 's1', delta_cents: 1500 }],
        createdAt: now - 5000, expiresAt: now - 1, status: 'pending'
      }
      expect(isCompensationDraftAvailable(pendingDraft, now)).assertTrue()
      expect(isCompensationDraftAvailable(expiredDraft, now)).assertFalse()
      expect(formatCompensationAmount(1500)).assertEqual('¥15.00')
      expect(formatCompensationExpiry(Date.UTC(2026, 10, 22, 4, 0, 0))).assertContain('2026-11-22 12:00')
      expect(compensationStatusLabel('pending')).assertEqual('补差已登记，渠道处理中')
      expect(compensationStatusLabel('unknown')).assertContain('待核实')
      expect(compensationConfirmErrorMessage(403)).assertContain('过期')
      expect(compensationConfirmErrorMessage(400)).assertContain('变化')
      expect(compensationConfirmErrorMessage(409)).assertContain('余额')
      expect(compensationConfirmErrorMessage(409, 'COMPENSATION_CONDITION_CHANGED')).assertContain('重算')
    })
  })
}
