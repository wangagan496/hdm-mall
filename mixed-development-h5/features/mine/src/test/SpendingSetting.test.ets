import { describe, it, expect } from '@ohos/hypium'
import { SpendingRule, WishlistItem } from 'models'
import {
  validateSpendingRuleFields,
  centsToInputText,
  formatSpendingYuan,
  formatSpendingRuleLine,
  formatWishlistCooldownTime,
  wishlistItemHeadline,
  wishlistStateLabel,
  spendingSaveErrorMessage,
  wishlistActionErrorMessage
} from '../main/ets/presentation/utils/SpendingSettingPresentation'

export default function spendingSettingTest(): void {
  describe('spendingSettingPresentation', () => {
    it('validatesRuleFieldsPairingDisclosureAndBounds', 0, () => {
      const noDisclosure = validateSpendingRuleFields('500', '', '', '', true, false)
      expect(noDisclosure.error).assertContain('勾选')

      const allEmpty = validateSpendingRuleFields('', '', '', '', true, true)
      expect(allEmpty.error).assertContain('至少设置')

      const badHours = validateSpendingRuleFields('', '', '100', '73', true, true)
      expect(badHours.error).assertContain('72')

      const orphanHours = validateSpendingRuleFields('500', '', '', '12', true, true)
      expect(orphanHours.error).assertContain('冷静触发金额')

      const valid = validateSpendingRuleFields('500.00', '200.50', '100', '24', true, true)
      expect(valid.error).assertEqual('')
      expect(valid.monthlyBudgetCents).assertEqual(50000)
      expect(valid.perOrderLimitCents).assertEqual(20050)
      expect(valid.cooldownThresholdCents).assertEqual(10000)
      expect(valid.cooldownHours).assertEqual(24)

      const disabledAllEmpty = validateSpendingRuleFields('', '', '', '', false, false)
      expect(disabledAllEmpty.error).assertEqual('')
    })

    it('formatsSummaryRulesAndWishlistWithoutCountdown', 0, () => {
      expect(centsToInputText(null)).assertEqual('')
      expect(centsToInputText(1250)).assertEqual('12.50')
      expect(formatSpendingYuan(null)).assertEqual('未设')
      expect(formatSpendingYuan(6000)).assertEqual('¥60.00')

      const rule: SpendingRule = {
        id: 'r1', version: 2, monthlyBudgetCents: 30000, perOrderLimitCents: 10000,
        cooldownThresholdCents: 5000, cooldownHours: 24, enabled: true,
        monthDisclosure: '按北京时间', createdAt: 1700000000000
      }
      expect(formatSpendingRuleLine(rule)).assertContain('v2（启用）')

      const item: WishlistItem = {
        id: 'w1', requestKey: 'rk1', status: 'waiting',
        goods: [{ skuId: 's1', productId: 'p1', name: '真皮包', spec: '黑色', picture: '/a.jpg', unitPriceCents: 60000, count: 1 }],
        addressId: 'a1', expectedAmountCents: 60000, quotedTotalCents: 60000,
        currentQuotedTotalCents: 55000, priceChanged: true, promotionRevision: 1,
        ruleVersion: 2, cooldownUntil: Date.UTC(2026, 10, 24, 6, 0, 0), readyToConfirm: true, createdAt: 1700000000000
      }
      expect(wishlistItemHeadline(item)).assertEqual('真皮包（黑色）×1')
      expect(wishlistStateLabel(item)).assertEqual('冷静期已结束，待本人确认')
      expect(formatWishlistCooldownTime(item.cooldownUntil)).assertContain('2026-11-24 14:00')
      expect(spendingSaveErrorMessage(409, 'SPENDING_RULE_VERSION_CHANGED')).assertContain('版本已更新')
      expect(wishlistActionErrorMessage(409, 'PRICE_CHANGED')).assertContain('重新核价确认')
    })
  })
}
