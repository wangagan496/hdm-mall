import { HDMGoodsItem, LocalGoodsItem } from 'models'
import { auth } from './Auth'
import { storeManager } from './StoreManager'
import { getAccountScopedKey } from './AccountScope'

const FAVORITE_GOODS_KEY: string = 'favorite_goods'
const BROWSE_HISTORY_KEY: string = 'browse_history'
const MAX_HISTORY_COUNT: number = 50

export class LocalGoodsStore {
  private pendingWrite: Promise<void> = Promise.resolve()

  private enqueue(action: () => Promise<void>): Promise<void> {
    const task: Promise<void> = this.pendingWrite.then(action)
    this.pendingWrite = task.catch(() => {})
    return task
  }
  private getAccountStorageKey(key: string): string {
    return getAccountScopedKey(key)
  }

  private copyGoodsForLocalStorage(goods: HDMGoodsItem): LocalGoodsItem {
    let picture: string = ''
    if (typeof goods.picture === 'string') {
      picture = goods.picture
    }
    return {
      id: goods.id,
      name: goods.name,
      desc: goods.desc,
      price: goods.price,
      picture: picture,
      orderNum: goods.orderNum,
      originalPrice: goods.originalPrice,
      updatedAt: Date.now()
    }
  }

  private readLocalGoods(key: string): LocalGoodsItem[] {
    const value = storeManager.getStore().getSync(this.getAccountStorageKey(key), [])
    return (value as LocalGoodsItem[]).slice()
  }

  private updateLocalGoods(key: string, update: (goods: LocalGoodsItem[]) => LocalGoodsItem[]): Promise<void> {
    // 入队时固定账号；轮到本次操作时再读取上一笔已确认的数据。
    const storageKey: string = this.getAccountStorageKey(key)
    return this.enqueue(async (): Promise<void> => {
      const store = storeManager.getStore()
      const before: LocalGoodsItem[] = store.getSync(storageKey, []) as LocalGoodsItem[]
      const goods: LocalGoodsItem[] = update(before.slice())
      try {
        store.putSync(storageKey, goods)
        await store.flush()
      } catch {
        try { store.putSync(storageKey, before); await store.flush() } catch {}
        throw new Error('本地商品数据保存失败')
      }
    })
  }

  private mergeLegacyGoods(accountGoods: LocalGoodsItem[], legacyGoods: LocalGoodsItem[], maxCount?: number): LocalGoodsItem[] {
    const mergedGoods: LocalGoodsItem[] = accountGoods.slice()
    legacyGoods.forEach((legacyItem: LocalGoodsItem) => {
      if (!mergedGoods.some((item: LocalGoodsItem) => item.id === legacyItem.id)) {
        mergedGoods.push(legacyItem)
      }
    })
    mergedGoods.sort((left: LocalGoodsItem, right: LocalGoodsItem) => right.updatedAt - left.updatedAt)
    if (maxCount && mergedGoods.length > maxCount) {
      mergedGoods.splice(maxCount, mergedGoods.length - maxCount)
    }
    return mergedGoods
  }

  // 兼容旧版未区分账号的记录：合入当前账号后删除旧存储键。
  private migrateLegacyList(key: string, accountStorageKey: string, maxCount?: number): boolean {
    const store = storeManager.getStore()
    const legacyGoods = store.getSync(key, []) as LocalGoodsItem[]
    if (legacyGoods.length === 0) {
      return false
    }
    const accountGoods = store.getSync(accountStorageKey, []) as LocalGoodsItem[]
    store.putSync(accountStorageKey, this.mergeLegacyGoods(accountGoods, legacyGoods, maxCount))
    store.deleteSync(key)
    return true
  }

  async migrateLegacyData(): Promise<void> {
    const account = auth.getUserInfo()?.account?.trim()
    if (!account) {
      return
    }
    const favoriteKey: string = this.getAccountStorageKey(FAVORITE_GOODS_KEY)
    const historyKey: string = this.getAccountStorageKey(BROWSE_HISTORY_KEY)
    await this.enqueue(async (): Promise<void> => {
      const store = storeManager.getStore()
      const favorites: LocalGoodsItem[] = store.getSync(favoriteKey, []) as LocalGoodsItem[]
      const history: LocalGoodsItem[] = store.getSync(historyKey, []) as LocalGoodsItem[]
      const oldFavorites: LocalGoodsItem[] = store.getSync(FAVORITE_GOODS_KEY, []) as LocalGoodsItem[]
      const oldHistory: LocalGoodsItem[] = store.getSync(BROWSE_HISTORY_KEY, []) as LocalGoodsItem[]
      try {
        const favoritesChanged: boolean = this.migrateLegacyList(FAVORITE_GOODS_KEY, favoriteKey)
        const historyChanged: boolean = this.migrateLegacyList(BROWSE_HISTORY_KEY, historyKey, MAX_HISTORY_COUNT)
        if (favoritesChanged || historyChanged) await store.flush()
      } catch {
        try {
          store.putSync(favoriteKey, favorites); store.putSync(historyKey, history)
          store.putSync(FAVORITE_GOODS_KEY, oldFavorites); store.putSync(BROWSE_HISTORY_KEY, oldHistory)
          await store.flush()
        } catch {}
        throw new Error('本地商品数据迁移失败')
      }
    })
  }

  getFavorites(): LocalGoodsItem[] {
    return this.readLocalGoods(FAVORITE_GOODS_KEY)
  }

  isFavorite(goodsId: string): boolean {
    // 收藏探测失败不能阻断商品详情；列表页面则需要接收读取错误以便重试。
    try { return this.getFavorites().some((item: LocalGoodsItem) => item.id === goodsId) }
    catch { return false }
  }

  async toggleFavorite(goods: HDMGoodsItem): Promise<boolean> {
    const snapshot: LocalGoodsItem = this.copyGoodsForLocalStorage(goods)
    let favorite: boolean = false
    await this.updateLocalGoods(FAVORITE_GOODS_KEY, (favorites: LocalGoodsItem[]): LocalGoodsItem[] => {
      const index: number = favorites.findIndex((item: LocalGoodsItem) => item.id === snapshot.id)
      favorite = index < 0
      if (favorite) favorites.unshift(snapshot)
      else favorites.splice(index, 1)
      return favorites
    })
    return favorite
  }

  async removeFavorite(goodsId: string): Promise<void> {
    await this.updateLocalGoods(FAVORITE_GOODS_KEY, (favorites: LocalGoodsItem[]): LocalGoodsItem[] =>
      favorites.filter((item: LocalGoodsItem) => item.id !== goodsId))
  }

  getHistory(): LocalGoodsItem[] {
    return this.readLocalGoods(BROWSE_HISTORY_KEY)
  }

  async recordHistory(goods: HDMGoodsItem): Promise<void> {
    // 同一商品只保留最近一次浏览：去掉旧记录，再把新记录放到最前面。
    const snapshot: LocalGoodsItem = this.copyGoodsForLocalStorage(goods)
    await this.updateLocalGoods(BROWSE_HISTORY_KEY, (history: LocalGoodsItem[]): LocalGoodsItem[] => {
      const remainingHistory: LocalGoodsItem[] = history.filter((item: LocalGoodsItem) => item.id !== snapshot.id)
      remainingHistory.unshift(snapshot)
      if (remainingHistory.length > MAX_HISTORY_COUNT) remainingHistory.splice(MAX_HISTORY_COUNT, remainingHistory.length - MAX_HISTORY_COUNT)
      return remainingHistory
    })
  }

  async removeHistory(goodsId: string): Promise<void> {
    await this.updateLocalGoods(BROWSE_HISTORY_KEY, (history: LocalGoodsItem[]): LocalGoodsItem[] =>
      history.filter((item: LocalGoodsItem) => item.id !== goodsId))
  }

  async clearHistory(): Promise<void> {
    await this.updateLocalGoods(BROWSE_HISTORY_KEY, (): LocalGoodsItem[] => [])
  }

  async clearPersonalData(): Promise<void> {
    const favoriteKey = this.getAccountStorageKey(FAVORITE_GOODS_KEY)
    const historyKey = this.getAccountStorageKey(BROWSE_HISTORY_KEY)
    await this.enqueue(async (): Promise<void> => {
      const store = storeManager.getStore()
      for (const key of [favoriteKey, historyKey, FAVORITE_GOODS_KEY, BROWSE_HISTORY_KEY]) store.deleteSync(key)
      await store.flush()
    })
  }
}

export const localGoodsStore = new LocalGoodsStore()
