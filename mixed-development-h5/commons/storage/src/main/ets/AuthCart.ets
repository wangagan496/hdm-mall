import { BusinessVariable } from 'constants'
import { AddCartParams, CartCount } from 'models'
import { RequestAxios } from 'network'
import { auth } from './Auth'
import { storeManager } from './StoreManager'
import { formBindingData, formProvider } from "@kit.FormKit"

// 添加购物车
const addCartAPI = (data: AddCartParams) => {
  return RequestAxios.post<null>('/member/cart', data)
}

// 获取购物车数量
const getCartCountAPI = () => {
  return RequestAxios.get<CartCount>('/member/cart/count')
}

export class AuthCart {
  // 添加购物车并更新角标
  async addCart(data: AddCartParams) {
    await addCartAPI(data)
    this.updateCartCount()
  }

  // 更新购物车数量（AppStorage + 卡片角标 + eventHub 通知列表刷新）
  async updateCartCount(): Promise<void> {
    if (auth.getUserInfo()?.token) {
      try {
        const result = await getCartCountAPI()
        this.publishCartCount(result.count)
      } catch {
        AppStorage.setOrCreate<number>(BusinessVariable.CART_COUNT, 0)
      }
    } else {
      this.publishCartCount(0)
    }
  }

  private publishCartCount(count: number): void {
    AppStorage.setOrCreate<number>(BusinessVariable.CART_COUNT, count)
    this.updateCardData(count)
    storeManager.ctx?.eventHub.emit(BusinessVariable.UPDATE_CART_LIST)
  }

  // 更新服务卡片上显示的购物车数量
  updateCardData(count: number) {
    const formIdList = storeManager.getFormId()
    const param: Record<string, number> = { 'count': count }
    const obj: formBindingData.FormBindingData = formBindingData.createFormBindingData(param)
    formIdList.forEach(formId => {
      formProvider.updateForm(formId, obj)
    })
  }
}

export const authCart = new AuthCart()
