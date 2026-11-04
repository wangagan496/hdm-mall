import axios, { AxiosError } from 'axios'

const request = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV && import.meta.env.MODE !== 'mobile' ? 'http://127.0.0.1:3000' : ''),
  timeout: Number(import.meta.env.VITE_API_TIMEOUT || 10000),
})

// 请求拦截器，自动添加token
request.interceptors.request.use(
  (config) => {
    // 内嵌网页与原生共享同一服务，不能让旧网页配置把原生凭证送到另一环境。
    if (window.nativeApp) {
      config.baseURL = window.nativeApp.getApiBaseUrl?.()
    }
    if (!config.baseURL || !/^https?:\/\//i.test(config.baseURL)) {
      return Promise.reject(new Error('服务地址未配置，请检查应用构建配置'))
    }
    try {
      // 读取 App 的当前登录用户，请求带上该用户的登录凭证。
      const loggedInUser = window.nativeApp?.getUser()
      if (loggedInUser?.token && !config.headers.Authorization) {
        config.headers.Authorization = `Bearer ${loggedInUser.token}`
      }
    } catch {
      return Promise.reject(new Error('登录信息读取失败，请重新登录'))
    }
    return config
  },
  (err) => {
    return Promise.reject(err)
  }
)

// 统一的业务错误提示：按状态码映射为可读文案，避免裸错误信息弹出。
const TOAST_BY_STATUS: Record<number, string> = {
  400: '请求参数有误，请检查后重试',
  401: '登录已过期，请重新登录',
  403: '暂无权限执行此操作',
  404: '请求的资源不存在',
  409: '操作冲突，请刷新后重试',
  500: '服务开小差了，请稍后重试',
  502: '网关异常，请稍后重试',
  503: '服务暂时不可用，请稍后重试',
}

export const requestErrorMessage = (error: unknown): string => {
  if (!axios.isAxiosError(error)) return error instanceof Error ? error.message : '资料保存失败，请重试'
  if (error.response?.status) return TOAST_BY_STATUS[error.response.status] || '请求失败，请稍后重试'
  return error.code === 'ECONNABORTED' ? '请求超时，结果待确认，请重试' : '网络异常，请检查网络后重试'
}

request.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const authorization = String(error.config?.headers?.Authorization || '')
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (error.response?.status === 401 && token && window.nativeApp?.getUser()?.token === token) {
      try {
        if (await window.nativeApp.expireSession(token)) window.dispatchEvent(new Event('native-session-expired'))
      } catch { /* 本地清理失败由页面显示。 */ }
    }
    return Promise.reject(error)
  },
)

export { request }
