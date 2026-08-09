import { HDMUser, RequestAxios } from 'basic'
import { LoginParams } from '../viewmodels'


export const loginAPI = (data: LoginParams) => {
  return RequestAxios.post<HDMUser>("/login", data)
}