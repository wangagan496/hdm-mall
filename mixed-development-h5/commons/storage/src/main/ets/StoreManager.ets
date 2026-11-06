import { preferences } from "@kit.ArkData"
import { common } from "@kit.AbilityKit"
import { GlobalVariable } from "constants"
import { HDMUser, PendingOrderRequest, PendingTradeInfo } from "models"

export class StoreManager {
  ctx?: common.UIAbilityContext
  private userFlush: Promise<void> = Promise.resolve()

  getStore() {
    try {
      if (!this.ctx) {
        throw new Error('StoreManager: ctx 未初始化，请在 UIAbility.onCreate 中设置 storeManager.ctx')
      }
      return preferences.getPreferencesSync(this.ctx, {
        name: GlobalVariable.USER_INFO_KEY
      })
    } catch {
      throw new Error('本地存储初始化失败')
    }
  }

  async saveUserInfo(user: HDMUser): Promise<void> {
    try {
      const store = this.getStore()
      const pendingTrade = this.getPendingTrade()
      if (pendingTrade && user.id) {
        try {
          const intent = JSON.parse(pendingTrade) as PendingTradeInfo
          if ((intent.accountId && intent.accountId !== user.id) || !Number.isFinite(intent.created) ||
            intent.created > Date.now() || Date.now() - intent.created > 30 * 60_000) {
            store.deleteSync('pendingGuestTrade')
          } else {
            intent.accountId = user.id
            store.putSync('pendingGuestTrade', JSON.stringify(intent))
          }
        } catch {
          store.deleteSync('pendingGuestTrade')
        }
      }
      store.putSync(GlobalVariable.USER_INFO_KEY, user)
      // 内存写入立即生效，磁盘 flush 按调用顺序完成，避免旧资料最后落盘。
      const pending = this.userFlush.then(() => store.flush())
      this.userFlush = pending.catch(() => {})
      await pending
    } catch {
      throw new Error('用户信息保存失败')
    }
  }

  async saveProfileForSession(user: HDMUser, expectedToken: string): Promise<void> {
    // 登录可能已写入新账号但仍在等待落盘，不能只核对 AppStorage 的旧账号。
    if (!expectedToken || this.getUserInfo()?.token !== expectedToken) {
      throw new Error('登录状态已变化，请重新打开资料页')
    }
    await this.saveUserInfo(user)
  }

  getUserInfo(): HDMUser | null {
    try {
      const store = this.getStore()
      const raw = store.getSync(GlobalVariable.USER_INFO_KEY, null)
      if (raw === null || raw === undefined) {
        return null
      }
      return raw as HDMUser
    } catch {
      return null
    }
  }

  async setFormId(formId: string): Promise<void> {
    try {
      const store = this.getStore()
      const formIdList = this.getFormId()
      formIdList.push(formId)
      store.putSync(GlobalVariable.FORM_ID_LIST, formIdList)
      await store.flush()
    } catch {
      throw new Error('卡片信息保存失败')
    }
  }

  getPendingOrder(accountId: string): PendingOrderRequest | null {
    if (!accountId) return null
    const raw = this.getStore().getSync('pendingOrder:' + accountId, '') as string
    if (!raw) return null
    const record = JSON.parse(raw) as PendingOrderRequest
    return record.accountId === accountId && record.requestKey.length > 0 ? record : null
  }

  getPendingTrade(): string {
    return this.getStore().getSync('pendingGuestTrade', '') as string
  }

  async savePendingTrade(record: string): Promise<void> {
    const store = this.getStore()
    store.putSync('pendingGuestTrade', record)
    const pending = this.userFlush.then(() => store.flush())
    this.userFlush = pending.catch(() => {})
    await pending
  }

  async clearPendingTrade(requestKey: string): Promise<void> {
    const store = this.getStore()
    const raw = this.getPendingTrade()
    if (!raw || (JSON.parse(raw) as PendingTradeInfo).requestKey !== requestKey) return
    store.deleteSync('pendingGuestTrade')
    const pending = this.userFlush.then(() => store.flush())
    this.userFlush = pending.catch(() => {})
    await pending
  }

  async savePendingOrder(record: PendingOrderRequest): Promise<void> {
    const store = this.getStore()
    const previous = this.getPendingOrder(record.accountId)
    if (previous && previous.requestKey !== record.requestKey) throw new Error('正在确认订单')
    store.putSync('pendingOrder:' + record.accountId, JSON.stringify(record))
    const pending = this.userFlush.then(() => store.flush())
    this.userFlush = pending.catch(() => {})
    await pending
  }

  async clearPendingOrder(accountId: string, requestKey: string): Promise<void> {
    const store = this.getStore()
    if (this.getPendingOrder(accountId)?.requestKey !== requestKey) return
    store.deleteSync('pendingOrder:' + accountId)
    const pending = this.userFlush.then(() => store.flush())
    this.userFlush = pending.catch(() => {})
    await pending
  }

  getFormId(): string[] {
    try {
      const store = this.getStore()
      return store.getSync(GlobalVariable.FORM_ID_LIST, []) as string[]
    } catch {
      return []
    }
  }
}

export const storeManager = new StoreManager()
