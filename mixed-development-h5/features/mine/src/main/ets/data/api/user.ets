import { HDMUser } from 'models'
import { RequestAxios } from 'network'
import { LoginParams } from '../../domain/models'

export interface HuaweiLoginParams {
  code: string
}

export const loginAPI = (data: LoginParams) => {
  return RequestAxios.post<HDMUser>("/login", data)
}

export const huaweiLoginAPI = (data: HuaweiLoginParams) => {
  return RequestAxios.post<HDMUser>("/login/huawei", data)
}
