import { DemoOrderOverlay, LocalEvaluationItem } from 'models'
import { auth } from './Auth'
import { storeManager } from './StoreManager'

/**
 * 沙箱环境的演示闭环数据：明确标注为本地模拟，绝不与服务端真实订单状态混淆。
 * 退出登录或切换账号时数据自动按 scope 隔离。
 */
const DEMO_OVERLAY_KEY: string = 'demo_order_overlay'
const DEMO_EVALUATION_KEY: string = 'demo_order_evaluation'
const ANONYMOUS_SCOPE: string = 'anonymous'
const EVALUATION_MAX_LENGTH: number = 200
const EVALUATION_MIN_LENGTH: number = 5

export class DemoOrderStore {
  private getStorageScope(): string {
    const account = auth.getUserInfo()?.account?.trim()
    if (!account) {
      return ANONYMOUS_SCOPE
    }
    return `account_${encodeURIComponent(account)}`
  }

  private getScopedKey(key: string): string {
    return `${key}_${this.getStorageScope()}`
  }

  private readMap<T>(key: string): Record<string, T> {
    try {
      const store = storeManager.getStore()
      const value: Record<string, T> = store.getSync(this.getScopedKey(key), {} as Record<string, T>) as Record<string, T>
      return value
    } catch {
      return {} as Record<string, T>
    }
  }

  private async writeMap<T>(key: string, value: Record<string, T>): Promise<void> {
    try {
      const store = storeManager.getStore()
      store.putSync(this.getScopedKey(key), value)
      await store.flush()
    } catch {
      throw new Error('演示数据保存失败')
    }
  }

  getOverlay(orderId: string): DemoOrderOverlay | null {
    if (!orderId) {
      return null
    }
    return this.readMap<DemoOrderOverlay>(DEMO_OVERLAY_KEY)[orderId] ?? null
  }

  getAllOverlays(): DemoOrderOverlay[] {
    return Object.values(this.readMap<DemoOrderOverlay>(DEMO_OVERLAY_KEY))
  }

  async setOverlay(orderId: string, advancedState: number): Promise<void> {
    if (!orderId) {
      return
    }
    const map = this.readMap<DemoOrderOverlay>(DEMO_OVERLAY_KEY)
    map[orderId] = { orderId, advancedState, updatedAt: Date.now() }
    await this.writeMap(DEMO_OVERLAY_KEY, map)
  }

  async clearOverlay(orderId: string): Promise<void> {
    if (!orderId) {
      return
    }
    const map = this.readMap<DemoOrderOverlay>(DEMO_OVERLAY_KEY)
    if (map[orderId]) {
      const next: Record<string, DemoOrderOverlay> = {}
      Object.keys(map).forEach((key: string) => {
        if (key !== orderId) {
          next[key] = map[key]
        }
      })
      await this.writeMap(DEMO_OVERLAY_KEY, next)
    }
  }

  getEvaluation(orderId: string): LocalEvaluationItem | null {
    if (!orderId) {
      return null
    }
    return this.readMap<LocalEvaluationItem>(DEMO_EVALUATION_KEY)[orderId] ?? null
  }

  getAllEvaluations(): LocalEvaluationItem[] {
    return Object.values(this.readMap<LocalEvaluationItem>(DEMO_EVALUATION_KEY))
  }

  /** 校验评价内容长度与评分范围，避免空评价或越界分数写入。 */
  static validateEvaluation(score: number, content: string): string | null {
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return '请给出 1-5 星评分'
    }
    const trimmed = content.trim()
    if (trimmed.length < EVALUATION_MIN_LENGTH) {
      return `评价内容至少 ${EVALUATION_MIN_LENGTH} 个字`
    }
    if (trimmed.length > EVALUATION_MAX_LENGTH) {
      return `评价内容不能超过 ${EVALUATION_MAX_LENGTH} 个字`
    }
    return null
  }

  async saveEvaluation(orderId: string, score: number, content: string): Promise<LocalEvaluationItem> {
    if (!orderId) {
      throw new Error('订单不存在')
    }
    const validation = DemoOrderStore.validateEvaluation(score, content)
    if (validation) {
      throw new Error(validation)
    }
    const item: LocalEvaluationItem = {
      orderId,
      score,
      content: content.trim(),
      createdAt: Date.now()
    }
    const map = this.readMap<LocalEvaluationItem>(DEMO_EVALUATION_KEY)
    map[orderId] = item
    await this.writeMap(DEMO_EVALUATION_KEY, map)
    return item
  }

  async clearEvaluation(orderId: string): Promise<void> {
    if (!orderId) {
      return
    }
    const map = this.readMap<LocalEvaluationItem>(DEMO_EVALUATION_KEY)
    if (map[orderId]) {
      const next: Record<string, LocalEvaluationItem> = {}
      Object.keys(map).forEach((key: string) => {
        if (key !== orderId) {
          next[key] = map[key]
        }
      })
      await this.writeMap(DEMO_EVALUATION_KEY, next)
    }
  }
}

export const demoOrderStore = new DemoOrderStore()