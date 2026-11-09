import { OrderItem } from 'models'
import { RequestAxios } from 'network'
import { auth, storeManager } from 'storage'
import { cancelOrderWithFallback } from '../../data/api/cart'
import { OrderState } from './OrderPresentation'

interface FailureResponse { status: number }
interface CancellationFailure extends Error {
  httpStatus?: number
  response?: FailureResponse
}

export class CancellationStateChanged extends Error {
  orderState: number
  constructor(orderState: number) {
    super('订单状态已变化，已停止取消，请刷新订单')
    this.orderState = orderState
  }
}

export const CANCELLATION_UNKNOWN: string = '取消结果待确认，请稍后重新查询'

// 保存的只有用户点过取消的订单号；打开普通订单绝不产生新的取消意图。
export class OrderCancellation {
  private running: Map<string, Promise<OrderItem>> = new Map<string, Promise<OrderItem>>()

  pendingIds(): string[] {
    const userId: string = auth.getUserInfo()?.id || ''
    if (!userId) return []
    try {
      const raw: string = storeManager.getStore().getSync('cancel-intents:' + userId, '[]') as string
      const ids = JSON.parse(raw) as string[]
      return Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id.length > 0) : []
    } catch { return [] }
  }

  private async remember(userId: string, orderId: string, pending: boolean): Promise<void> {
    const store = storeManager.getStore()
    const key: string = 'cancel-intents:' + userId
    const ids = JSON.parse(store.getSync(key, '[]') as string) as string[]
    const next: string[] = ids.filter(id => id !== orderId)
    if (pending) next.push(orderId)
    store.putSync(key, JSON.stringify(next))
    await store.flush()
  }

  confirm(orderId: string, resume: boolean = false): Promise<OrderItem> {
    const user = auth.getUserInfo()
    if (!user?.id || !user.token || !orderId) return Promise.reject(new Error('请先登录'))
    const key: string = user.token + ':' + orderId
    const active = this.running.get(key)
    if (active) return active
    if (resume && !this.pendingIds().includes(orderId)) return Promise.reject(new Error('没有待确认的取消操作'))
    const task = this.execute(user.id, user.token, orderId).finally(() => { this.running.delete(key) })
    this.running.set(key, task)
    return task
  }

  private assertSession(token: string): void {
    if (auth.getUserInfo()?.token !== token) throw new Error('登录状态已变化，取消结果请重新登录后查询')
  }

  async inspectPending(orderId: string): Promise<void> {
    const user = auth.getUserInfo()
    if (!user?.id || !user.token || !this.pendingIds().includes(orderId)) return
    // A read may clear a resolved intent; it never retries the cancellation write.
    await this.inspect(user.id, user.token, orderId)
  }

  private isUncertain(error: Error): boolean {
    const failure = error as CancellationFailure
    const status: number | undefined = failure.httpStatus || failure.response?.status
    return status === undefined || status === 408 || status === 429 || status >= 500
  }

  private async inspect(userId: string, token: string, orderId: string): Promise<OrderItem> {
    this.assertSession(token)
    const order = await RequestAxios.getForSession<OrderItem>(`/member/order/${orderId}`, token)
    this.assertSession(token)
    if (order.orderState !== OrderState.AWAITING_PAYMENT) {
      await this.remember(userId, orderId, false)
      if (order.orderState !== OrderState.CANCELLED) throw new CancellationStateChanged(order.orderState)
    }
    return order
  }

  private async execute(userId: string, token: string, orderId: string): Promise<OrderItem> {
    // 先持久化意图，写盘失败时不向服务器发出取消。
    await this.remember(userId, orderId, true)
    for (let attempt: number = 0; attempt < 3; attempt++) {
      this.assertSession(token)
      try {
        const current = await this.inspect(userId, token, orderId)
        if (current.orderState === OrderState.CANCELLED) return current
        this.assertSession(token)
        const updated = await cancelOrderWithFallback(orderId, token)
        this.assertSession(token)
        if (updated?.id === orderId && updated.orderState === OrderState.CANCELLED && updated.skus) {
          await this.remember(userId, orderId, false)
          return updated
        }
      } catch (error) {
        this.assertSession(token)
        // inspect 已确认不再待付款时也必须停止，不把它当成断网。
        if (!this.pendingIds().includes(orderId)) throw error as Error
        if (!this.isUncertain(error as Error)) {
          const failure = error as CancellationFailure
          if ((failure.httpStatus || failure.response?.status) === 409) {
            try { await this.inspect(userId, token, orderId) }
            catch (inspectionError) {
              this.assertSession(token)
              if (inspectionError instanceof CancellationStateChanged) throw inspectionError
            }
          }
          await this.remember(userId, orderId, false)
          throw new Error('服务器已拒绝取消，请刷新订单确认当前状态')
        }
      }
      if (attempt < 2) await new Promise<void>(resolve => setTimeout(resolve, 500 * (attempt + 1)))
    }
    // 最后一次回应也可能丢失，再查询一次；查询失败保留待确认状态。
    try {
      const finalOrder = await this.inspect(userId, token, orderId)
      if (finalOrder.orderState === OrderState.CANCELLED) return finalOrder
    } catch (error) {
      this.assertSession(token)
      if (!this.pendingIds().includes(orderId)) throw error as Error
    }
    throw new Error(CANCELLATION_UNKNOWN)
  }
}

export const orderCancellation = new OrderCancellation()
