import { HDMUser } from 'models'
import { RequestAxios } from 'network'
import { LoginParams } from '../../domain/models'


export const loginAPI = (data: LoginParams) => {
  return RequestAxios.post<HDMUser>("/login", data)
}