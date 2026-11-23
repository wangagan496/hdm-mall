import { auth } from './Auth'
import { authCart } from './AuthCart'
import { storeManager } from './StoreManager'
import { RequestAxios } from 'network'
import { HDMUser, Identity, IdentityContext, IdentitySwitch, parseIdentityContext, sameIdentitySession } from 'models'

export class UserSession {
  serverLogoutConfirmed: boolean = true

  constructor() {
    // 网络层只调用注入的回调，不反向依赖 storage 模块。
    RequestAxios.setSessionExpiredHandler((token: string) => this.expireSession(token))
    RequestAxios.setIdentityChangedHandler((token: string, context: IdentityContext) => {
      void this.applyIdentity(token, context).catch(() => {})
    })
  }

  private async applyIdentity(token: string, context: IdentityContext): Promise<void> {
    const current = auth.getUserInfo()
    if (!current || current.token !== token || storeManager.getUserInfo()?.token !== token ||
      (current.identityRevision !== undefined && current.identityRevision >= context.identityRevision) ||
      !context.identities.includes(context.identity)) return
    const updated: HDMUser = {
      status: current.status,
      deletionDueAt: current.deletionDueAt,
      id: current.id,
      identity: context.identity,
      identities: context.identities,
      identityRevision: context.identityRevision,
      birthday: current.birthday,
      cityCode: current.cityCode,
      gender: current.gender,
      mobile: current.mobile,
      profession: current.profession,
      provinceCode: current.provinceCode,
      countyCode: current.countyCode,
      fullLocation: current.fullLocation,
      token: current.token,
      nickname: current.nickname,
      avatar: current.avatar,
      account: current.account
    }
    const saving = storeManager.saveUserInfo(updated)
    auth.updateCurrentUser(updated)
    authCart.clearCartCount()
    if (updated.identity === 'buyer') void authCart.updateCartCount()
    await saving
  }

  async refreshIdentity(): Promise<void> {
    const token = auth.getUserInfo()?.token
    if (!token) return
    // 409 带回签发方确认的身份，网络层同步当前身份并丢弃旧响应。
    await RequestAxios.getForSession<HDMUser>('/member/profile', token)
  }

  async switchIdentity(identity: Identity): Promise<void> {
    const current = auth.getUserInfo()
    if (!current?.token || !current.identities?.includes(identity) || identity === current.identity) return
    const payload: IdentitySwitch = { identity }
    const token = current.token
    try {
      const response = await RequestAxios.postWithSession<Object>('/member/identity/switch', payload, token)
      if (!sameIdentitySession(auth.getUserInfo(), current)) return
      const context = parseIdentityContext(JSON.stringify(response))
      if (!context || context.identity !== identity || context.identityRevision <= (current.identityRevision ?? -1)) {
        throw new Error('切换结果暂时无法确认')
      }
      await this.applyIdentity(token, context)
    } catch {
      if (sameIdentitySession(auth.getUserInfo(), current)) {
        // 请求可能已经生效，只读确认结果，避免自动重发写请求。
        try { await this.refreshIdentity() } catch {}
      }
      const latest = auth.getUserInfo()
      if (latest?.token === token && latest.identity !== identity) throw new Error('暂时无法确认是否已切换，请重试')
    }
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
    const user = auth.getUserInfo()
    const token: string = user?.token || ''
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
        await RequestAxios.postForSession<null>('/logout', token, user)
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
