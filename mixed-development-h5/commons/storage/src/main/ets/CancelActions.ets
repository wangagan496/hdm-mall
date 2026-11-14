import { util } from '@kit.ArkTS'
import { CancelActionIntent, PendingCancelAction, CancelActionReceipt } from 'models'
import { auth } from './Auth'
import { storeManager } from './StoreManager'
import { requestOrderCancelAPI, withdrawOrderCancelAPI, resolveOrderCancelAPI, getCancelActionReceiptAPI } from './CancelActionAPI'

interface CancelFailureBody { msg?: string; reason?: string }
interface CancelFailureResponse { status: number; data?: CancelFailureBody }
export interface CancelFailureInfo { status: number; reason: string; message: string }
interface CancelFailure extends Error { httpStatus?: number; reason?: string; response?: CancelFailureResponse }
export function cancelActionFailure(error: Error): CancelFailureInfo {
  const failure = error as CancelFailure
  return { status: failure.httpStatus || failure.response?.status || 0,
    reason: failure.reason || failure.response?.data?.reason || '',
    message: failure.response?.data?.msg || failure.message || '操作失败，请稍后重试' }
}
export const CANCEL_ACTION_UNKNOWN: string = '操作结果待确认，请重新查询'

export class CancelActions {
  private running: Map<string, Promise<void>> = new Map<string, Promise<void>>()
  private saving: Promise<void> = Promise.resolve()

  pending(): PendingCancelAction[] {
    const accountId: string = auth.getUserInfo()?.id || ''
    return accountId ? this.read(accountId) : []
  }

  private read(accountId: string): PendingCancelAction[] {
    const records = JSON.parse(storeManager.getStore().getSync('order-cancel-actions:' + accountId, '[]') as string) as PendingCancelAction[]
    if (!Array.isArray(records)) throw new Error('取消操作记录读取失败，请重试')
    return records.filter((record: PendingCancelAction) => record.accountId === accountId)
  }

  private save(record: PendingCancelAction, remove: boolean): Promise<void> {
    const task = this.saving.then(async (): Promise<void> => {
      const store = storeManager.getStore()
      const key: string = 'order-cancel-actions:' + record.accountId
      const previous = store.getSync(key, '[]') as string
      const records = this.read(record.accountId)
      const next = records.filter((item: PendingCancelAction) => item.requestKey !== record.requestKey)
      if (!remove) next.push(record)
      try {
        store.putSync(key, JSON.stringify(next))
        await store.flush()
      } catch {
        store.putSync(key, previous)
        throw new Error('取消操作记录保存失败，请重试')
      }
    })
    this.saving = task.catch(() => {})
    return task
  }

  private assertSession(accountId: string, token: string): void {
    const user = auth.getUserInfo()
    if (user?.id !== accountId || user?.token !== token || !token) throw new Error('登录状态已变化，请重新查询取消结果')
  }

  private status(error: Error): number {
    const failure = error as CancelFailure
    return failure.httpStatus || failure.response?.status || 0
  }

  private async send(record: PendingCancelAction, token: string): Promise<CancelActionReceipt> {
    this.assertSession(record.accountId, token)
    if (record.action === 'request') return requestOrderCancelAPI(record.orderId, record.requestKey, token)
    if (record.action === 'withdraw') return withdrawOrderCancelAPI(record.orderId, record.cancelRequestId, record.requestKey, token)
    return resolveOrderCancelAPI(record.orderId, record.cancelRequestId, record.requestKey, record.action, record.reason, token, record.carrier || '', record.trackingNo || '')
  }

  confirm(intent: CancelActionIntent, token: string): Promise<void> {
    const accountId: string = auth.getUserInfo()?.id || ''
    try { this.assertSession(accountId, token) } catch (error) { return Promise.reject(error) }
    const key: string = accountId + ':' + intent.orderId
    if (this.running.has(key)) return Promise.reject(new Error(CANCEL_ACTION_UNKNOWN))
    const task = this.start(intent, accountId, token).finally(() => { this.running.delete(key) })
    this.running.set(key, task)
    return task
  }

  private async start(intent: CancelActionIntent, accountId: string, token: string): Promise<void> {
    if (this.read(accountId).some((item: PendingCancelAction) => item.orderId === intent.orderId)) throw new Error(CANCEL_ACTION_UNKNOWN)
    const record: PendingCancelAction = { accountId, orderId: intent.orderId, cancelRequestId: intent.cancelRequestId,
      action: intent.action, reason: intent.reason.trim(), requestKey: util.generateRandomUUID(true), carrier: intent.carrier, trackingNo: intent.trackingNo }
    await this.save(record, false)
    await this.perform(record, token, false)
  }

  recover(orderId: string, token: string): Promise<void> {
    const accountId: string = auth.getUserInfo()?.id || ''
    try { this.assertSession(accountId, token) } catch (error) { return Promise.reject(error) }
    const key: string = accountId + ':' + orderId
    const active = this.running.get(key)
    if (active) return active
    const record = this.read(accountId).find((item: PendingCancelAction) => item.orderId === orderId)
    if (!record) return Promise.resolve()
    const task = this.perform(record, token, true).finally(() => { this.running.delete(key) })
    this.running.set(key, task)
    return task
  }

  async inspectPending(orderId: string, token: string): Promise<void> {
    const accountId: string = auth.getUserInfo()?.id || ''
    this.assertSession(accountId, token)
    const record = this.read(accountId).find((item: PendingCancelAction) => item.orderId === orderId)
    if (!record) return
    await getCancelActionReceiptAPI(record.requestKey, token)
    this.assertSession(accountId, token)
    await this.save(record, true)
  }

  private async perform(record: PendingCancelAction, token: string, recover: boolean): Promise<void> {
    try {
      this.assertSession(record.accountId, token)
      if (recover) {
        try { await getCancelActionReceiptAPI(record.requestKey, token) }
        catch (error) {
          if (this.status(error as Error) !== 404) throw error as Error
          this.assertSession(record.accountId, token)
          await this.send(record, token)
        }
      } else {
        await this.send(record, token)
      }
      this.assertSession(record.accountId, token)
      await this.save(record, true)
    } catch (error) {
      const status: number = this.status(error as Error)
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        await this.save(record, true)
        throw new Error(cancelActionFailure(error as Error).message)
      }
      this.assertSession(record.accountId, token)
      throw new Error(CANCEL_ACTION_UNKNOWN)
    }
  }
}

export const cancelActions = new CancelActions()
