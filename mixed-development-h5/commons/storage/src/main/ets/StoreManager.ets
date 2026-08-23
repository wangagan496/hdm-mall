import { preferences } from "@kit.ArkData"
import { common } from "@kit.AbilityKit"
import { GlobalVariable } from "constants"
import { HDMUser } from "models"

export class StoreManager {
  ctx?: common.UIAbilityContext

  getStore() {
    if (!this.ctx) {
      throw new Error('StoreManager: ctx 未初始化，请在 UIAbility.onCreate 中设置 storeManager.ctx')
    }
    return preferences.getPreferencesSync(this.ctx, {
      name: GlobalVariable.USER_INFO_KEY
    })
  }

  async setUserInfo(user: HDMUser) {
    const store = this.getStore()
    store.putSync(GlobalVariable.USER_INFO_KEY, user)
    await store.flush()
  }

  getUserInfo(): HDMUser | null {
    const store = this.getStore()
    const raw = store.getSync(GlobalVariable.USER_INFO_KEY, null)
    if (raw === null || raw === undefined) {
      return null
    }
    return raw as HDMUser
  }

  async setFormId(formId: string) {
    const store = this.getStore()
    const formIdList = this.getFormId()
    formIdList.push(formId)
    store.putSync(GlobalVariable.FORM_ID_LIST, formIdList)
    await store.flush()
  }

  getFormId(): string[] {
    const store = this.getStore()
    return store.getSync(GlobalVariable.FORM_ID_LIST, []) as string[]
  }
}

export const storeManager = new StoreManager()
