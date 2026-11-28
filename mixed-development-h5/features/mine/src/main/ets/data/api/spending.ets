import { SpendingRule, SpendingRuleInput, SpendingSummary, WishlistConfirmInput, WishlistItem } from 'models'
import { RequestAxios } from 'network'

export interface SpendingRulesPayload {
  current: SpendingRule
  history: SpendingRule[]
}

export interface WishlistConfirmResult {
  id: string
  orderId: string
  wishlistItemId: string
}

interface EmptyBody {}

const EMPTY_BODY: EmptyBody = {}

export const getSpendingRulesAPI = (token: string): Promise<SpendingRulesPayload> => {
  return RequestAxios.getForSession<SpendingRulesPayload>('/member/spending/rules', token)
}

export const saveSpendingRuleAPI = (input: SpendingRuleInput, token: string): Promise<SpendingRule> => {
  return RequestAxios.putForSession<SpendingRule>('/member/spending/rules', input, token)
}

export const getSpendingSummaryAPI = (token: string): Promise<SpendingSummary> => {
  return RequestAxios.getForSession<SpendingSummary>('/member/spending/summary', token)
}

export const getWishlistAPI = (token: string): Promise<WishlistItem[]> => {
  return RequestAxios.getForSession<WishlistItem[]>('/member/spending/wishlist', token)
}

export const cancelWishlistAPI = (id: string, token: string): Promise<WishlistItem> => {
  return RequestAxios.postWithSession<WishlistItem>(`/member/spending/wishlist/${id}/cancel`, EMPTY_BODY, token)
}

export const confirmWishlistAPI = (id: string, input: WishlistConfirmInput, token: string): Promise<WishlistConfirmResult> => {
  return RequestAxios.postWithSession<WishlistConfirmResult>(`/member/spending/wishlist/${id}/confirm`, input, token)
}
