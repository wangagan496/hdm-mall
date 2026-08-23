import { HDMGoodsItem, LocalGoodsItem } from 'models'
import { auth } from './Auth'
import { storeManager } from './StoreManager'

const FAVORITE_GOODS_KEY: string = 'favorite_goods'
const BROWSE_HISTORY_KEY: string = 'browse_history'
const ANONYMOUS_SCOPE: string = 'anonymous'
const MAX_HISTORY_COUNT: number = 50

export class LocalGoodsStore {
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

  private createSnapshot(goods: HDMGoodsItem): LocalGoodsItem {
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

  private getGoodsList(key: string): LocalGoodsItem[] {
    const value = storeManager.getStore().getSync(this.getScopedKey(key), [])
    return value as LocalGoodsItem[]
  }

  private async saveGoodsList(key: string, goods: LocalGoodsItem[]): Promise<void> {
    const store = storeManager.getStore()
    store.putSync(this.getScopedKey(key), goods)
    await store.flush()
  }

  private mergeGoods(current: LocalGoodsItem[], legacy: LocalGoodsItem[], maxCount?: number): LocalGoodsItem[] {
    const merged: LocalGoodsItem[] = current.slice()
    legacy.forEach((legacyItem: LocalGoodsItem) => {
      if (!merged.some((item: LocalGoodsItem) => item.id === legacyItem.id)) {
        merged.push(legacyItem)
      }
    })
    merged.sort((left: LocalGoodsItem, right: LocalGoodsItem) => right.updatedAt - left.updatedAt)
    if (maxCount && merged.length > maxCount) {
      merged.splice(maxCount, merged.length - maxCount)
    }
    return merged
  }

  private migrateLegacyList(key: string, maxCount?: number): boolean {
    const store = storeManager.getStore()
    const legacy = store.getSync(key, []) as LocalGoodsItem[]
    if (legacy.length === 0) {
      return false
    }
    const scopedKey = this.getScopedKey(key)
    const current = store.getSync(scopedKey, []) as LocalGoodsItem[]
    store.putSync(scopedKey, this.mergeGoods(current, legacy, maxCount))
    store.deleteSync(key)
    return true
  }

  async migrateLegacyData(): Promise<void> {
    const account = auth.getUserInfo()?.account?.trim()
    if (!account) {
      return
    }
    const favoritesChanged = this.migrateLegacyList(FAVORITE_GOODS_KEY)
    const historyChanged = this.migrateLegacyList(BROWSE_HISTORY_KEY, MAX_HISTORY_COUNT)
    if (favoritesChanged || historyChanged) {
      await storeManager.getStore().flush()
    }
  }

  getFavorites(): LocalGoodsItem[] {
    return this.getGoodsList(FAVORITE_GOODS_KEY)
  }

  isFavorite(goodsId: string): boolean {
    return this.getFavorites().some((item: LocalGoodsItem) => item.id === goodsId)
  }

  async toggleFavorite(goods: HDMGoodsItem): Promise<boolean> {
    const favorites = this.getFavorites()
    const index = favorites.findIndex((item: LocalGoodsItem) => item.id === goods.id)
    if (index >= 0) {
      favorites.splice(index, 1)
      await this.saveGoodsList(FAVORITE_GOODS_KEY, favorites)
      return false
    }
    favorites.unshift(this.createSnapshot(goods))
    await this.saveGoodsList(FAVORITE_GOODS_KEY, favorites)
    return true
  }

  async removeFavorite(goodsId: string): Promise<void> {
    const favorites = this.getFavorites().filter((item: LocalGoodsItem) => item.id !== goodsId)
    await this.saveGoodsList(FAVORITE_GOODS_KEY, favorites)
  }

  getHistory(): LocalGoodsItem[] {
    return this.getGoodsList(BROWSE_HISTORY_KEY)
  }

  async recordHistory(goods: HDMGoodsItem): Promise<void> {
    const history = this.getHistory().filter((item: LocalGoodsItem) => item.id !== goods.id)
    history.unshift(this.createSnapshot(goods))
    if (history.length > MAX_HISTORY_COUNT) {
      history.splice(MAX_HISTORY_COUNT, history.length - MAX_HISTORY_COUNT)
    }
    await this.saveGoodsList(BROWSE_HISTORY_KEY, history)
  }

  async removeHistory(goodsId: string): Promise<void> {
    const history = this.getHistory().filter((item: LocalGoodsItem) => item.id !== goodsId)
    await this.saveGoodsList(BROWSE_HISTORY_KEY, history)
  }

  async clearHistory(): Promise<void> {
    await this.saveGoodsList(BROWSE_HISTORY_KEY, [])
  }
}

export const localGoodsStore = new LocalGoodsStore()
