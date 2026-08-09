import axios, { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from '@ohos/axios'
import { GlobalVariable } from '../constants'
import { promptAction } from '@kit.ArkUI'
import { auth } from '.'

const SILENT_HEADER = 'x-silent-error'

const instance = axios.create({
  baseURL: GlobalVariable.BASE_URL,
  timeout: 10000
})

// 无拦截器的原始实例，用于访问格式不兼容的外部接口
const rawInstance = axios.create({ timeout: 10000 })

instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const user = auth.getUserInfo()
  if (user && user.token) {
    config.headers.Authorization = `Bearer ${user.token}`
  }
  return config
}, (error: AxiosError) => {
  return Promise.reject(error)
})

instance.interceptors.response.use((response: AxiosResponse) => {
  if (response.data.code === GlobalVariable.SUCCESS_CODE) {
    return response.data.result
  }
  if (!response.config.headers?.[SILENT_HEADER]) {
    promptAction.showToast({ message: response.data.msg })
  }
  return Promise.reject(new Error(response.data.msg))
}, (error: AxiosError) => {
  if (!error.config?.headers?.[SILENT_HEADER]) {
    const res = error.response?.data as object
    if (res) {
      promptAction.showToast({ message: res["msg"] })
    }
  }
  return Promise.reject(error)
})

export class RequestAxios {
  static get<T>(url: string, params?: object): Promise<T> {
    return instance.get<null, T>(url, { params })
  }

  /** 静默请求：失败时不弹 Toast，由调用方自行处理错误 */
  static getSilent<T>(url: string, params?: object): Promise<T> {
    return instance.get<null, T>(url, { params, headers: { [SILENT_HEADER]: '1' } })
  }

  /** 原始请求：绕过响应拦截器，适用于格式不兼容的外部接口 */
  static getRaw<T>(url: string, params?: object): Promise<T> {
    return rawInstance.get<null, T>(url, { params })
  }

  static post<T>(url: string, data?: object): Promise<T> {
    return instance.post<null, T>(url, data)
  }

  static put<T>(url: string, data?: object): Promise<T> {
    return instance.put<null, T>(url, data)
  }

  static delete<T>(url: string, data?: object): Promise<T> {
    return instance.delete<null, T>(url, { data })
  }
}
