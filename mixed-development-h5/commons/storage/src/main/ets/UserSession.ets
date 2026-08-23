import { auth } from './Auth'
import { authCart } from './AuthCart'
import { storeManager } from './StoreManager'

export class UserSession {
  async logout(): Promise<void> {
    const emptyUser = auth.createEmptyUser()
    await storeManager.setUserInfo(emptyUser)
    auth.clearUserInfo()
    await authCart.updateCartCount()
  }
}

export const userSession = new UserSession()
