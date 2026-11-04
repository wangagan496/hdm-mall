import { AddressItem } from 'models'
import { RequestAxios } from 'network'

export interface AddressMutationPayload {
  requestKey?: string
  revision?: number
  fullLocation: string
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

interface AddressCreatePayload extends AddressMutationPayload {
  requestKey?: string
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

export async function getAddressListAPI(token: string): Promise<AddressItem[]> {
  const result: AddressItem[] = await RequestAxios.getForSession<AddressItem[]>('/member/address', token)
  return (result || []).map((address: AddressItem) => normalizeAddress(address))
}

export async function getAddressDetailAPI(id: string, token: string): Promise<AddressItem> {
  const result: AddressItem = await RequestAxios.getForSession<AddressItem>(`/member/address/${id}`, token)
  return normalizeAddress(result)
}

export function createAddressAPI(data: AddressMutationPayload, requestKey: string, token: string, revision: number): Promise<AddressMutationResult> {
  const requestData: AddressCreatePayload = {
    fullLocation: data.fullLocation,
    receiver: data.receiver,
    contact: data.contact,
    provinceCode: data.provinceCode,
    cityCode: data.cityCode,
    countyCode: data.countyCode,
    address: data.address,
    isDefault: data.isDefault,
    requestKey: requestKey,
    revision: revision
  }
  // 自动保存的失败由编辑框显示，避免输入过程中反复弹提示。
  return RequestAxios.postWithSession<AddressMutationResult>('/member/address', requestData, token)
}

export function updateAddressAPI(
  id: string,
  data: AddressMutationPayload | AddressDefaultPayload,
  token: string
): Promise<AddressMutationResult> {
  return RequestAxios.putForSession<AddressMutationResult>(`/member/address/${id}`, data, token)
}

export function deleteAddressAPI(id: string, token: string): Promise<AddressMutationResult> {
  return RequestAxios.deleteForSession<AddressMutationResult>(`/member/address/${id}`, token)
}
