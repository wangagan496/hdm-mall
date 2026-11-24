import { describe, it, expect } from '@ohos/hypium'
import { PriceProtectionPolicy } from 'models'
import {
  validateProtectionFields,
  findActiveProtectionPolicy,
  formatProtectionYuan,
  buildProtectionConfirmSummary,
  prepareProtectionErrorMessage,
  publishProtectionErrorMessage
} from '../main/ets/presentation/utils/ProtectionPresentation'

export default function protectionTests(): void {
  describe('protectionPresentation', () => {
    it('validatesProtectionBoundaries', 0, () => {
      expect(validateProtectionFields('0', '10.00', '500.00', '1').error.length > 0).assertTrue()
      expect(validateProtectionFields('91', '10.00', '500.00', '1').error.length > 0).assertTrue()
      expect(validateProtectionFields('7.5', '10.00', '500.00', '1').error.length > 0).assertTrue()
      expect(validateProtectionFields('7', '0', '500.00', '1').error.length > 0).assertTrue()
      expect(validateProtectionFields('7', '20.00', '10.00', '1').error.length > 0).assertTrue()
      expect(validateProtectionFields('7', '10.00', '500.00', '0').error.length > 0).assertTrue()
      expect(validateProtectionFields('7', '10.00', '500.00', '31').error.length > 0).assertTrue()

      const valid = validateProtectionFields('7', '10.50', '500.00', '2')
      expect(valid.error).assertEqual('')
      expect(valid.windowDays).assertEqual(7)
      expect(valid.budgetPerOrderCents).assertEqual(1050)
      expect(valid.totalBudgetCents).assertEqual(50000)
      expect(valid.effectiveDays).assertEqual(2)
    })

    it('picksLatestPublishedEffectivePolicyAndFormatsSummary', 0, () => {
      const policies: PriceProtectionPolicy[] = [
        {
          policyId: 'p3', version: 3, windowDays: 15, budgetPerOrderCents: 2000, totalBudgetCents: 100000,
          announcedAt: 1000, effectiveAt: 5000, published: false, receiptId: null
        },
        {
          policyId: 'p2', version: 2, windowDays: 14, budgetPerOrderCents: 1500, totalBudgetCents: 80000,
          announcedAt: 1000, effectiveAt: 3000, published: true, receiptId: 'r2'
        },
        {
          policyId: 'p1', version: 1, windowDays: 7, budgetPerOrderCents: 1000, totalBudgetCents: 50000,
          announcedAt: 100, effectiveAt: 500, published: true, receiptId: 'r1'
        }
      ]
      expect(findActiveProtectionPolicy(policies, 2000)?.policyId).assertEqual('p1')
      expect(findActiveProtectionPolicy(policies, 4000)?.policyId).assertEqual('p2')
      expect(findActiveProtectionPolicy(policies, 200)).assertNull()
      expect(formatProtectionYuan(1050)).assertEqual('¥10.50')
      expect(buildProtectionConfirmSummary(7, 1000, 1)).assertEqual('保护 7 天，单笔最多 ¥10.00，1 天后生效。')
    })

    it('mapsPrepareAndPublishFailuresToChineseMessages', 0, () => {
      expect(prepareProtectionErrorMessage(409)).assertContain('变化')
      expect(prepareProtectionErrorMessage(403)).assertContain('权限')
      expect(prepareProtectionErrorMessage(500)).assertContain('失败')
      expect(publishProtectionErrorMessage(403)).assertContain('过期')
      expect(publishProtectionErrorMessage(409)).assertContain('已发布')
      expect(publishProtectionErrorMessage(500)).assertContain('失败')
    })
  })
}
