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
  400: '填写内容有误，请检查后重试',
  401: '登录已过期，请重新登录后继续',
  403: '暂无权限执行此操作',
  404: '暂时找不到这份资料，请返回后重试',
  409: '资料已更新，请核对后重试，输入已保留',
  500: '还在确认保存结果，输入已保留，请稍后重试',
  502: '还在确认保存结果，输入已保留，请稍后重试',
  503: '还在确认保存结果，输入已保留，请稍后重试',
}

export const requestErrorMessage = (error: unknown): string => {
  if (!axios.isAxiosError(error)) {
    const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined
    return typeof message === 'string' && message ? message : '暂时连不上服务，输入已保留'
  }
  if (error.response && error.response.status >= 500) return '还在确认保存结果，输入已保留，请稍后重试'
  if (error.response?.status) return TOAST_BY_STATUS[error.response.status] || '请求失败，请稍后重试'
  return '暂时连不上服务，输入已保留，请检查网络后重试'
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
