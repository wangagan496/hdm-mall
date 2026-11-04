import { auth } from './Auth'
import { authCart } from './AuthCart'
import { storeManager } from './StoreManager'
import { RequestAxios } from 'network'

export class UserSession {
  serverLogoutConfirmed: boolean = true

  constructor() {
    // 网络层只调用注入的回调，不反向依赖 storage 模块。
    RequestAxios.setSessionExpiredHandler((token: string) => this.expireSession(token))
  }

  async expireSession(expectedToken: string): Promise<boolean> {
    if (!expectedToken || auth.getUserInfo()?.token !== expectedToken) {
      return false
    }
    const storedToken: string = storeManager.getUserInfo()?.token || ''
    if (storedToken && storedToken !== expectedToken) {
      // 新登录已写入持久层、仍在等待 flush 时，旧请求也不能清除它。
      return false
    }
    auth.clearUserInfo()
    authCart.clearCartCount()
    await storeManager.saveUserInfo(auth.createEmptyUser())
    return !auth.getUserInfo()?.token
  }

  async logout(): Promise<void> {
    const token: string = auth.getUserInfo()?.token || ''
    auth.clearUserInfo()
    authCart.clearCartCount()
    let localSaved: boolean = true
    try {
      await storeManager.saveUserInfo(auth.createEmptyUser())
    } catch {
      localSaved = false
    }
    this.serverLogoutConfirmed = !token
    if (token) {
      try {
        await RequestAxios.postForSession<null>('/logout', token)
        this.serverLogoutConfirmed = true
      } catch {
        // 离线也完成本地退出；服务端未确认的状态单独交给界面提示。
      }
    }
    if (!localSaved) {
      throw new Error('本机已退出，但登录资料清理失败，请重试')
    }
  }
}

export const userSession = new UserSession()
