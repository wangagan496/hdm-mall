import axios from 'axios'
import { showToast } from 'vant'

const request = axios.create({
  baseURL: 'https://meikou-api.itheima.net/'
})

// 请求拦截器，自动添加token
request.interceptors.request.use(
  (config) => {
    try {
      const user = window.mk?.queryUser()
      if (user?.token) {
        config.headers.Authorization = `Bearer ${user.token}`
      }
    } catch (e) {
      showToast({ message: 'SDK异常'+ e })
    }
    return config
  },
  (err) => {
    return Promise.reject(err)
  }
)

export { request }
