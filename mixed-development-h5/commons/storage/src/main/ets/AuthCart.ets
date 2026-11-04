import { BusinessVariable } from 'constants'
import { AddCartParams, CartCount } from 'models'
import { RequestAxios } from 'network'
import { auth } from './Auth'
import { storeManager } from './StoreManager'
import { formBindingData, formProvider } from "@kit.FormKit"

// 添加购物车
const addCartAPI = (data: AddCartParams, token: string) => {
  return RequestAxios.postWithSession<null>('/member/cart', data, token)
}

// 读取服务端统计的购物袋总件数，不修改任何商品的购买数量。
const getCartCountAPI = (token: string) => {
  return RequestAxios.getForSession<CartCount>('/member/cart/count', token)
}

export class AuthCart {
  private querySequence: number = 0
  private cardUpdates: Promise<void> = Promise.resolve()

  clearCartCount(): void {
    this.querySequence++
    this.publishCartCount(0)
  }
  // 先确认加购成功，再发起角标刷新；调用方不用等待角标就能继续。
  async addCart(data: AddCartParams, token: string): Promise<void> {
    if (!token || auth.getUserInfo()?.token !== token) throw new Error('登录状态已变化，请返回后重试')
    await addCartAPI(data, token)
    if (auth.getUserInfo()?.token === token) void this.updateCartCount()
  }

  // 刷新显示用的总件数，不是修改购物袋里某件商品的数量。
  // 读取成功后更新应用角标、桌面卡片，并通知购物袋页面重新加载列表。
  async updateCartCount(): Promise<void> {
    const token: string = auth.getUserInfo()?.token || ''
    const sequence: number = ++this.querySequence
    if (!token) {
      this.clearCartCount()
      return
    }

    try {
      const cartSummary = await getCartCountAPI(token)
      if (sequence !== this.querySequence || auth.getUserInfo()?.token !== token) {
        return
      }
      this.publishCartCount(cartSummary.count)
    } catch {
      if (sequence === this.querySequence && auth.getUserInfo()?.token === token) {
        // 查询失败统一清理显示；不表示服务端购物袋已清空。
        this.publishCartCount(0)
      }
    }
  }

  private publishCartCount(count: number): void {
    // AppStorage 保存应用共享的显示数量；事件通知 CartView 重新读列表。
    AppStorage.setOrCreate<number>(BusinessVariable.CART_COUNT, count)
    this.updateCardData(count)
    storeManager.ctx?.eventHub.emit(BusinessVariable.UPDATE_CART_LIST)
  }

  // 更新服务卡片上显示的购物车数量
  updateCardData(count: number) {
    // 按发布顺序完成卡片更新，退出后的清零不会被在途旧数量覆盖。
    this.cardUpdates = this.cardUpdates.then(async () => {
      const cardFields: Record<string, number> = { 'count': count }
      const cardData = formBindingData.createFormBindingData(cardFields)
      await Promise.allSettled(storeManager.getFormId().map(formId => formProvider.updateForm(formId, cardData)))
    }).catch(() => {})
  }
}

export const authCart = new AuthCart()
