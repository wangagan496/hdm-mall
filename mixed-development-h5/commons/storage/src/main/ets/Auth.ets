import { GlobalVariable } from 'constants'
import { HDMUser } from 'models'

export class Auth {
  private key: string = GlobalVariable.USER_INFO_KEY

  createEmptyUser(): HDMUser {
    return {
      token: '',
      nickname: '',
      avatar: '',
      account: ''
    }
  }

  setUserInfo(user: HDMUser): void {
    AppStorage.setOrCreate<HDMUser>(this.key, user)
  }

  getUserInfo(): HDMUser | undefined {
    return AppStorage.get<HDMUser>(this.key)
  }

  clearUserInfo(): void {
    // USER_INFO_KEY is observed by multiple @StorageProp fields. Deleting an
    // observed key is not a reliable state transition, so publish an explicit
    // anonymous user and let every subscriber update in the same process.
    this.setUserInfo(this.createEmptyUser())
  }
}

export const auth = new Auth()
