import { describe, it, expect } from '@ohos/hypium'
import { OrderSpendingSummary, SpendingPauseDetail } from 'models'
import {
  formatYuanFromCents,
  formatCooldownUntilText,
  spendingPauseHeadline,
  spendingPauseSummaryText,
  spendingPauseRemainingText,
  spendingOrderSummaryText,
  wishlistStatusLabel,
  wishlistConfirmErrorMessage
} from '../main/ets/presentation/utils/SpendingPresentation'

export default function spendingPresentationTest(): void {
  describe('spendingPresentation', () => {
    it('formatsPauseDetailsForPerOrderAndMonthlyBudget', 0, () => {
      const perOrder: SpendingPauseDetail = {
        limitType: 'per_order',
        amountCents: 12000,
        limitCents: 10000,
        ruleVersion: 3,
        monthKey: '2026-11',
        spentCents: 5000,
        reservedCents: 2000,
        remainingBudgetCents: 13000
      }
      expect(formatYuanFromCents(12000)).assertEqual('¥120.00')
      expect(spendingPauseHeadline(perOrder)).assertContain('单笔限额')
      expect(spendingPauseSummaryText(perOrder)).assertContain('单笔上限 ¥100.00')
      expect(spendingPauseSummaryText(perOrder)).assertContain('v3')
      expect(spendingPauseRemainingText(perOrder)).assertContain('本月剩余 ¥130.00')

      const monthly: SpendingPauseDetail = {
        limitType: 'monthly_budget',
        amountCents: 8000,
        limitCents: 20000,
        ruleVersion: 4,
        monthKey: '2026-11',
        spentCents: 15000,
        reservedCents: 0,
        remainingBudgetCents: 5000
      }
      expect(spendingPauseHeadline(monthly)).assertContain('月度预算')
      expect(spendingPauseSummaryText(monthly)).assertContain('月度预算 ¥200.00')
    })

    it('formatsReadonlyOrderSpendingSummaryAndCooldownBeijingTimeWithoutCountdown', 0, () => {
      expect(spendingOrderSummaryText(undefined)).assertEqual('')
      const disabled: OrderSpendingSummary = {
        monthKey: '2026-11',
        ruleVersion: 0,
        enabled: false,
        monthlyBudgetCents: null,
        spentCents: 0,
        remainingBudgetCents: null
      }
      expect(spendingOrderSummaryText(disabled)).assertEqual('')

      const enabled: OrderSpendingSummary = {
        monthKey: '2026-11',
        ruleVersion: 2,
        enabled: true,
        monthlyBudgetCents: 30000,
        spentCents: 6000,
        remainingBudgetCents: 24000
      }
      const line = spendingOrderSummaryText(enabled)
      expect(line).assertContain('2026-11')
      expect(line).assertContain('v2')
      expect(line).assertContain('¥60.00')
      expect(line).assertContain('¥240.00')

      // 冷静截至时间固定格式化为北京时间具体时刻，不显示倒计时
      const cooldownText = formatCooldownUntilText(Date.UTC(2026, 10, 24, 4, 30, 0))
      expect(cooldownText).assertContain('2026-11-24 12:30')
    })

    it('formatsWishlistStatusLabelsAndConfirmErrorMessages', 0, () => {
      expect(wishlistStatusLabel('waiting', false)).assertEqual('冷静期等待中')
      expect(wishlistStatusLabel('waiting', true)).assertEqual('冷静期已结束，待本人确认')
      expect(wishlistStatusLabel('cancelled', false)).assertEqual('已取消')
      expect(wishlistStatusLabel('confirmed', true)).assertEqual('已确认下单')
      expect(wishlistConfirmErrorMessage(403)).assertContain('无权')
      expect(wishlistConfirmErrorMessage(409, 'COOLDOWN_ACTIVE')).assertContain('冷静期')
      expect(wishlistConfirmErrorMessage(409, 'PRICE_CHANGED')).assertContain('报价')
      expect(wishlistConfirmErrorMessage(409, 'SPENDING_PAUSED', '已超出单笔限额')).assertContain('单笔限额')
    })
  })
}
