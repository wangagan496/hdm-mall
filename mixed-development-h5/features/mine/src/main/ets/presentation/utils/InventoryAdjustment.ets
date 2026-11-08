import { util } from '@kit.ArkTS'
import { RequestAxios } from 'network'
import { auth, storeManager } from 'storage'
import { StockAdjustmentDraft, StockAdjustmentReceipt } from '../../data/api/inventory'

interface ErrorBody { msg?: string }
interface ErrorResponse { status: number; data?: ErrorBody }
interface AdjustmentError extends Error { httpStatus?: number; response?: ErrorResponse }

export class InventoryAdjustment {
  private running: Map<string, Promise<StockAdjustmentReceipt>> = new Map<string, Promise<StockAdjustmentReceipt>>()

  pending(userId: string): StockAdjustmentDraft | null {
    if (!userId) return null
    const raw = storeManager.getStore().getSync('stock-adjustment:' + userId, '') as string
    if (!raw) return null
    const draft = JSON.parse(raw) as StockAdjustmentDraft
    if (!draft.requestKey || !draft.skuId || !Number.isInteger(draft.delta) || draft.delta === 0 ||
      !Number.isInteger(draft.expectedStock) || draft.expectedStock < 0 || !draft.reason || draft.reason.trim().length < 5) {
      throw new Error('本地待确认记录异常，请先核查库存记录')
    }
    return draft
  }

  start(skuId: string, delta: number, expectedStock: number, reason: string, token: string): Promise<StockAdjustmentReceipt> {
    const user = auth.getUserInfo()
    if (!user?.id || !user.token || user.role !== 'merchant') return Promise.reject(new Error('请使用商家账号登录'))
    if (user.token !== token) return Promise.reject(new Error('登录状态已变化，请重新登录后确认库存调整结果'))
    const active = this.running.get(user.id)
    if (active) return active
    if (this.pending(user.id)) return Promise.reject(new Error('请先确认上一笔库存调整结果'))
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1000000 || !Number.isInteger(expectedStock) ||
      expectedStock < 0 || expectedStock + delta < 0 || expectedStock + delta > 2147483647 || reason.trim().length < 5 || reason.trim().length > 200) {
      return Promise.reject(new Error('请填写有效数量和至少5个字的调整原因'))
    }
    const draft: StockAdjustmentDraft = { requestKey: util.generateRandomUUID(), skuId, delta, expectedStock, reason: reason.trim() }
    return this.run(user.id, user.token, draft, false)
  }

  resume(token: string): Promise<StockAdjustmentReceipt> {
    const user = auth.getUserInfo()
    if (!user?.id || !user.token || user.role !== 'merchant') return Promise.reject(new Error('请使用商家账号登录'))
    if (user.token !== token) return Promise.reject(new Error('登录状态已变化，请重新登录后确认库存调整结果'))
    const active = this.running.get(user.id)
    if (active) return active
    const draft = this.pending(user.id)
    if (!draft) return Promise.reject(new Error('没有待确认的库存调整'))
    return this.run(user.id, user.token, draft, true)
  }

  private run(userId: string, token: string, draft: StockAdjustmentDraft, resume: boolean): Promise<StockAdjustmentReceipt> {
    const task = this.execute(userId, token, draft, resume).finally(() => this.running.delete(userId))
    this.running.set(userId, task)
    return task
  }

  private assertSession(token: string): void {
    if (auth.getUserInfo()?.token !== token || storeManager.getUserInfo()?.token !== token) {
      throw new Error('登录状态已变化，请重新登录后确认库存调整结果')
    }
  }

  private async save(userId: string, draft: StockAdjustmentDraft | null): Promise<void> {
    const store = storeManager.getStore()
    const key = 'stock-adjustment:' + userId
    const before = store.getSync(key, '') as string
    store.putSync(key, draft ? JSON.stringify(draft) : '')
    try { await store.flush() }
    catch {
      store.putSync(key, before)
      throw new Error('本地记录保存失败，请重试确认结果')
    }
  }

  private status(error: Error): number {
    const failure = error as AdjustmentError
    return failure.httpStatus || failure.response?.status || 0
  }

  private async find(token: string, draft: StockAdjustmentDraft): Promise<StockAdjustmentReceipt | null> {
    this.assertSession(token)
    try {
      const receipt = await RequestAxios.getForSession<StockAdjustmentReceipt>('/merchant/inventory/adjustments/' + draft.requestKey, token)
      this.assertSession(token)
      return receipt
    } catch (error) {
      this.assertSession(token)
      if (this.status(error as Error) === 404) return null
      throw error as Error
    }
  }

  private async confirm(userId: string, token: string, draft: StockAdjustmentDraft, receipt: StockAdjustmentReceipt): Promise<StockAdjustmentReceipt> {
    this.assertSession(token)
    if (receipt.skuId !== draft.skuId || receipt.delta !== draft.delta || receipt.reason !== draft.reason ||
      receipt.balance !== draft.expectedStock + draft.delta) throw new Error('返回记录与提交内容不一致，请核查库存流水')
    await this.save(userId, null)
    this.assertSession(token)
    return receipt
  }

  private async execute(userId: string, token: string, draft: StockAdjustmentDraft, resume: boolean): Promise<StockAdjustmentReceipt> {
    this.assertSession(token)
    // 先落盘再写服务端；退出重进仍沿用同一个编号和同一份内容。
    await this.save(userId, draft)
    this.assertSession(token)
    if (resume) {
      const known = await this.find(token, draft)
      if (known) return this.confirm(userId, token, draft, known)
    }
    let receipt: StockAdjustmentReceipt
    try {
      receipt = await RequestAxios.putForSession<StockAdjustmentReceipt>('/merchant/inventory/' + encodeURIComponent(draft.skuId) + '/adjustments', draft, token)
    } catch (error) {
      this.assertSession(token)
      const status = this.status(error as Error)
      const known = await this.find(token, draft).catch((): null => null)
      this.assertSession(token)
      if (known) return this.confirm(userId, token, draft, known)
      if (status === 400 || status === 403 || status === 404 || status === 409 || status === 422) {
        await this.save(userId, null)
        throw new Error(status === 409 ? '库存已变化，请刷新后重新确认' : '调整未完成，请刷新库存后核对再提交')
      }
      throw new Error('调整结果待确认，请使用“查询并重试本次调整”')
    }
    return this.confirm(userId, token, draft, receipt)
  }
}

export const inventoryAdjustment = new InventoryAdjustment()
