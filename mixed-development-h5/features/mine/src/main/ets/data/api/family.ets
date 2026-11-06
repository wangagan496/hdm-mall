import { FamilyRelation, FamilyRelationPage, OrderAttentionCount, OrderItem, OrderPage, PaymentStartResult } from 'models'
import { RequestAxios } from 'network'

interface InvitePayload { account: string }
interface RelationPayload { action: string }
interface FamilyActionResult { id: string }
interface EmptyPayload {}
interface PaymentPayload { amountCents: number }
const EMPTY_PAYLOAD: EmptyPayload = {}

export const getFamilyRelationsAPI = (): Promise<FamilyRelation[]> => {
  return RequestAxios.get<FamilyRelation[]>('/member/relations')
}

export const inviteRelationAPI = (account: string, token: string): Promise<FamilyActionResult> => {
  const data: InvitePayload = { account }
  return RequestAxios.postWithSession<FamilyActionResult>('/member/relations', data, token)
}

export const updateRelationAPI = (id: string, action: string, token: string): Promise<FamilyActionResult> => {
  const data: RelationPayload = { action }
  return RequestAxios.putForSession<FamilyActionResult>(`/member/relations/${id}`, data, token)
}

export const getFamilyOrdersAPI = (): Promise<OrderItem[]> => {
  return RequestAxios.get<OrderItem[]>('/member/family-orders')
}

export const getMerchantOrdersAPI = (): Promise<OrderItem[]> => {
  return RequestAxios.get<OrderItem[]>('/merchant/orders')
}

export const getFamilyRelationsForSessionAPI = (token: string): Promise<FamilyRelation[]> => {
  return RequestAxios.getForSession<FamilyRelation[]>('/member/relations', token)
}

export const getFamilyRelationsPageAPI = (page: number, token: string): Promise<FamilyRelationPage> => {
  return RequestAxios.getForSession<FamilyRelationPage>('/member/relations/page?page=' + page + '&pageSize=10', token)
}

export const getFamilyOrdersPageAPI = (page: number, token: string): Promise<OrderPage> => {
  return RequestAxios.getForSession<OrderPage>('/member/family-orders/page?page=' + page + '&pageSize=10', token)
}

export const getMerchantOrdersPageAPI = (page: number, token: string): Promise<OrderPage> => {
  return RequestAxios.getForSession<OrderPage>('/merchant/orders/page?page=' + page + '&pageSize=10', token)
}

export const receiveOrderAPI = (id: string, token: string): Promise<FamilyActionResult> => {
  return RequestAxios.putForSession<FamilyActionResult>(`/member/order/${id}/receipt`, EMPTY_PAYLOAD, token)
}

export const startFamilyPaymentAPI = (id: string, amount: number, token: string): Promise<PaymentStartResult> => {
  const data: PaymentPayload = { amountCents: Math.round(amount * 100) }
  return RequestAxios.postWithSession<PaymentStartResult>(`/member/order/${id}/payments`, data, token)
}

export const getOrderAttentionCountAPI = (token: string): Promise<OrderAttentionCount> => {
  return RequestAxios.getForSession<OrderAttentionCount>('/member/order/attention', token)
}

export const shipOrderAPI = (id: string, token: string): Promise<FamilyActionResult> => {
  return RequestAxios.postWithSession<FamilyActionResult>(`/merchant/orders/${id}/ship`, EMPTY_PAYLOAD, token)
}
