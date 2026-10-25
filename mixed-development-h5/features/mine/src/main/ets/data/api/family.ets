import { FamilyRelation, OrderItem } from 'models'
import { RequestAxios } from 'network'

interface InvitePayload { account: string }
interface RelationPayload { action: string }
interface PaymentPayload { amountCents: number }
interface FamilyActionResult { id: string }

export const getFamilyRelationsAPI = (): Promise<FamilyRelation[]> => {
  return RequestAxios.get<FamilyRelation[]>('/member/relations')
}

export const inviteRelationAPI = (account: string): Promise<FamilyActionResult> => {
  const data: InvitePayload = { account }
  return RequestAxios.post<FamilyActionResult>('/member/relations', data)
}

export const updateRelationAPI = (id: string, action: string): Promise<FamilyActionResult> => {
  const data: RelationPayload = { action }
  return RequestAxios.put<FamilyActionResult>(`/member/relations/${id}`, data)
}

export const getFamilyOrdersAPI = (): Promise<OrderItem[]> => {
  return RequestAxios.get<OrderItem[]>('/member/family-orders')
}

export const getMerchantOrdersAPI = (): Promise<OrderItem[]> => {
  return RequestAxios.get<OrderItem[]>('/merchant/orders')
}

export const receiveOrderAPI = (id: string): Promise<FamilyActionResult> => {
  return RequestAxios.put<FamilyActionResult>(`/member/order/${id}/receipt`)
}

export const familyPayAPI = (id: string, amount: number): Promise<FamilyActionResult> => {
  const data: PaymentPayload = { amountCents: Math.round(amount * 100) }
  return RequestAxios.post<FamilyActionResult>(`/member/order/${id}/mock-pay`, data)
}

export const shipOrderAPI = (id: string): Promise<FamilyActionResult> => {
  return RequestAxios.post<FamilyActionResult>(`/merchant/orders/${id}/ship`)
}
