import { UIContext } from '@kit.ArkUI'
import { util } from '@kit.ArkTS'
import { RequestAxios } from 'network'
import { storeManager } from './StoreManager'
import { showConsentDialog } from './ConsentDialog'

export const CONSENT_VERSION: string = '2026-11-10'
export interface ConsentRecord {
  version: string
  agreedAt: number
  source: string
  requestKey: string
}
interface WithdrawalRequest { version: string; requestKey: string }

export class ConsentManager {
  private pending?: Promise<boolean>

  record(): ConsentRecord | null {
    const raw = storeManager.getStore().getSync('privacyConsent', '') as string
    if (!raw) return null
    try { return JSON.parse(raw) as ConsentRecord } catch { return null }
  }

  accepted(): boolean {
    const record = this.record()
    return record !== null && record.version === CONSENT_VERSION && record.agreedAt > 0
  }

  async accept(source: string): Promise<void> {
    const store = storeManager.getStore()
    const record: ConsentRecord = { version: CONSENT_VERSION, agreedAt: Date.now(), source, requestKey: util.generateRandomUUID() }
    store.putSync('privacyConsent', JSON.stringify(record))
    try { await store.flush() } catch { store.deleteSync('privacyConsent'); throw new Error('同意记录保存失败，请重试') }
    AppStorage.setOrCreate('privacyConsentAccepted', true)
  }

  async report(token: string, accountId: string): Promise<void> {
    const record = this.record()
    if (record && this.accepted() && token && accountId) {
      const store = storeManager.getStore()
      const storageKey = 'consentReport:' + accountId + ':' + record.requestKey
      let key = store.getSync(storageKey, '') as string
      if (!key) { key = util.generateRandomUUID(); store.putSync(storageKey, key); await store.flush() }
      const body: ConsentRecord = { version: record.version, agreedAt: record.agreedAt, source: record.source, requestKey: key }
      await RequestAxios.postWithSession<object>('/member/consents', body, token)
    }
  }

  async clear(): Promise<void> {
    const store = storeManager.getStore()
    store.deleteSync('privacyConsent')
    AppStorage.setOrCreate('privacyConsentAccepted', false)
    await store.flush()
  }

  async withdraw(token: string): Promise<void> {
    const store = storeManager.getStore()
    if (token) {
      let key = store.getSync('consentWithdrawalKey', '') as string
      if (!key) { key = util.generateRandomUUID(); store.putSync('consentWithdrawalKey', key); await store.flush() }
      const body: WithdrawalRequest = { version: this.record()?.version || CONSENT_VERSION, requestKey: key }
      await RequestAxios.postWithSession<object>('/member/consents/withdraw', body, token)
      store.deleteSync('consentWithdrawalKey')
    }
    await this.clear()
  }

  async openDocument(ui: UIContext, kind: string): Promise<void> {
    const context = ui.getHostContext()!.createModuleContext('mine')
    const bytes = await context.resourceManager.getRawFileContent(kind === 'privacy' ? 'privacy-policy.txt' : 'user-agreement.txt')
    await ui.getPromptAction().showDialog({ title: kind === 'privacy' ? '隐私政策' : '用户协议',
      message: util.TextDecoder.create('utf-8').decodeToString(bytes), buttons: [{ text: '返回', color: '#333333' }] })
  }

  request(ui: UIContext, source: string): Promise<boolean> {
    if (this.accepted()) { AppStorage.setOrCreate('privacyConsentAccepted', true); return Promise.resolve(true) }
    if (!this.pending) this.pending = this.ask(ui, source).finally(() => { this.pending = undefined })
    return this.pending
  }

  private async ask(ui: UIContext, source: string): Promise<boolean> {
    while (!this.accepted()) {
      const update = this.record() !== null
      const index = await showConsentDialog(ui, (update ? '协议有更新\n' : '') + '我们使用账号资料完成登录，使用收货地址和交易信息完成配送、退款与售后；语音搜索仅在你同意权限后使用麦克风。收藏、足迹与游客购物车保存在本机。不同意也能浏览及使用游客购物车，登录前需同意。请阅读以下协议全文。')
      if (index === 0 || index === 1) {
        try { await this.openDocument(ui, index === 0 ? 'privacy' : 'terms') }
        catch { ui.getPromptAction().showToast({ message: '协议读取失败，请重试' }) }
        continue
      }
      if (index !== 3) { AppStorage.setOrCreate('privacyConsentAccepted', false); return false }
      await this.accept(source)
    }
    return true
  }
}

export const consentManager = new ConsentManager()
