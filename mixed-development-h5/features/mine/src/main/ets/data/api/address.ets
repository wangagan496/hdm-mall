import { AddressItem } from 'models'
import { RequestAxios } from 'network'

export interface AddressMutationPayload {
  receiver: string
  contact: string
  provinceCode: string
  cityCode: string
  countyCode: string
  address: string
  isDefault: 0 | 1
}

export interface AddressMutationResult {
  id?: string
}

export interface AddressDefaultPayload {
  isDefault: 0 | 1
}

function normalizeCode(value: number | string | undefined): number {
  const code: number = Number(value)
  return Number.isFinite(code) ? code : 0
}

function normalizeAddress(address: AddressItem): AddressItem {
  return {
    address: address.address || '',
    contact: address.contact || '',
    fullLocation: address.fullLocation || '',
    id: address.id || '',
    isDefault: address.isDefault === 0 ? 0 : 1,
    receiver: address.receiver || '',
    provinceCode: normalizeCode(address.provinceCode),
    cityCode: normalizeCode(address.cityCode),
    countyCode: normalizeCode(address.countyCode)
  }
}

export async function getAddressListAPI(): Promise<AddressItem[]> {
  const result: AddressItem[] = await RequestAxios.get<AddressItem[]>('/member/address')
  return (result || []).map((address: AddressItem) => normalizeAddress(address))
}

export async function getAddressDetailAPI(id: string): Promise<AddressItem> {
  const result: AddressItem = await RequestAxios.get<AddressItem>(`/member/address/${id}`)
  return normalizeAddress(result)
}

export function createAddressAPI(data: AddressMutationPayload): Promise<AddressMutationResult> {
  return RequestAxios.post<AddressMutationResult>('/member/address', data)
}

export function updateAddressAPI(
  id: string,
  data: AddressMutationPayload | AddressDefaultPayload
): Promise<AddressMutationResult> {
  return RequestAxios.put<AddressMutationResult>(`/member/address/${id}`, data)
}

export function deleteAddressAPI(id: string): Promise<AddressMutationResult> {
  return RequestAxios.delete<AddressMutationResult>(`/member/address/${id}`)
}
