import { HDMUser } from 'models'
import { RequestAxios, BusinessError } from 'network'
import { LoginParams } from '../../domain/models'

export interface HuaweiLoginParams {
  code: string
}

interface AuthRequestError extends Error {
  name: string
  response?: object
}

interface RegisterResult {
  id: string
}

export const isAuthNetworkError = (error: Error): boolean => {
  const requestError: AuthRequestError = error as AuthRequestError
  return !(error instanceof BusinessError) && requestError.name === 'AxiosError' && !requestError.response
}

// 请求阶段的错误（服务端业务失败或 axios 错误）；其余为本地保存等非请求错误。
export const isAuthRequestError = (error: Error): boolean => {
  return error instanceof BusinessError || (error as AuthRequestError).name === 'AxiosError'
}

export const registerAPI = (data: LoginParams): Promise<RegisterResult> => {
  const payload: LoginParams = { account: data.account, password: data.password }
  return RequestAxios.post<RegisterResult>("/register", payload)
}

export const loginAPI = (data: LoginParams) => {
  return RequestAxios.post<HDMUser>("/login", data)
}

export const huaweiLoginAPI = (data: HuaweiLoginParams) => {
  return RequestAxios.post<HDMUser>("/login/huawei", data)
}
