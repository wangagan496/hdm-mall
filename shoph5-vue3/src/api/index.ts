import axios from 'axios'
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

request.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      showToast({ message: '登录已过期，请重新登录' })
    } else if (error.code === 'ECONNABORTED') {
      showToast({ message: '请求超时，请稍后重试' })
    } else if (!error.response) {
      showToast({ message: '网络异常，请检查网络后重试' })
    }
    return Promise.reject(error)
  },
)

export { request }
