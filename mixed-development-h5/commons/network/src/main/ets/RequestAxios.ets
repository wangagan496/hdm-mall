import axios, { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from '@ohos/axios'
import { GlobalVariable } from 'constants'
import { window } from '@kit.ArkUI'
import { common } from '@kit.AbilityKit'
import { HDMUser } from 'models'

function showToast(message: string): void {
  // 直接从 AppStorage 读取 context，避免与 storage 模块产生循环依赖
  const ctx = AppStorage.get<common.UIAbilityContext>(GlobalVariable.ABILITY_CONTEXT_KEY)
  if (!ctx) {
    return
  }
  window.getLastWindow(ctx).then((win) => {
    try {
      win.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }).catch(() => {
  })
}

const GET_RETRY_DELAYS: number[] = [350, 1000]

export function isRetryableStatus(status?: number): boolean {
  return status === undefined || status === 408 || status === 429 || status >= 500
}

function isRetryableError(error: AxiosError): boolean {
  // A business error created by the response interceptor has no Axios code
  // or response; do not replay it as if it were a transport failure.
  if (!error.code && !error.response) {
    return false
  }
  return isRetryableStatus(error.response?.status)
}

function waitForRetry(delay: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delay)
  })
}

async function getWithRetry<T>(request: () => Promise<T>): Promise<T> {
  let lastError: AxiosError | null = null
  for (let attempt = 0; attempt <= GET_RETRY_DELAYS.length; attempt++) {
    try {
      return await request()
    } catch (error) {
      lastError = error as AxiosError
      if (!isRetryableError(lastError) || attempt >= GET_RETRY_DELAYS.length) {
        throw new Error(lastError.message || '网络请求失败')
      }
      await waitForRetry(GET_RETRY_DELAYS[attempt])
    }
  }
  throw new Error(lastError?.message || '网络请求失败')
}

export function executeGetWithRetry<T>(request: () => Promise<T>): Promise<T> {
  return getWithRetry(request)
}

const instance = axios.create({
  baseURL: GlobalVariable.BASE_URL,
  timeout: 10000
})

const rawInstance = axios.create({ timeout: 10000 })

instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const user = AppStorage.get<HDMUser>(GlobalVariable.USER_INFO_KEY)
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
  if (!response.config.headers?.xSilentError) {
    showToast(response.data.msg)
  }
  return Promise.reject(new Error(response.data.msg))
}, (error: AxiosError) => {
  if (!error.config?.headers?.xSilentError) {
    const res = error.response?.data as object
    if (res) {
      showToast(res["msg"])
    }
  }
  return Promise.reject(error)
})

export class RequestAxios {
  static get<T>(url: string, params?: object): Promise<T> {
    return executeGetWithRetry<T>(() => instance.get<null, T>(url, { params }))
  }

  static getSilent<T>(url: string, params?: object): Promise<T> {
    return executeGetWithRetry<T>(() => instance.get<null, T>(url, { params, headers: { xSilentError: '1' } }))
  }

  static getRaw<T>(url: string, params?: object): Promise<T> {
    return executeGetWithRetry<T>(() => rawInstance.get<null, T>(url, { params }))
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
