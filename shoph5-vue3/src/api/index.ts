import axios, { AxiosError } from 'axios'
import { showToast } from 'vant'

const request = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'https://meikou-api.itheima.net/',
  timeout: Number(import.meta.env.VITE_API_TIMEOUT || 10000),
})

// 请求拦截器，自动添加token
request.interceptors.request.use(
  (config) => {
    try {
      const user = window.mk?.queryUser()
      if (user?.token) {
        config.headers.Authorization = `Bearer ${user.token}`
      }
    } catch {
      showToast({ message: '登录信息读取失败，请重新登录' })
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

request.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    const status = error.response?.status
    if (status && TOAST_BY_STATUS[status]) {
      showToast({ message: TOAST_BY_STATUS[status] })
    } else if (error.code === 'ECONNABORTED') {
      showToast({ message: '请求超时，请检查网络后重试' })
    } else if (!error.response) {
      showToast({ message: '网络异常，请检查网络后重试' })
    }
    return Promise.reject(error)
  },
)

export { request }
