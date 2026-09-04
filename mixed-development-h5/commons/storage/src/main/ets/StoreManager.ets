import { preferences } from "@kit.ArkData"
import { common } from "@kit.AbilityKit"
import { GlobalVariable } from "constants"
import { HDMUser } from "models"

export class StoreManager {
  ctx?: common.UIAbilityContext

  getStore() {
    try {
      if (!this.ctx) {
        throw new Error('StoreManager: ctx 未初始化，请在 UIAbility.onCreate 中设置 storeManager.ctx')
      }
      return preferences.getPreferencesSync(this.ctx, {
        name: GlobalVariable.USER_INFO_KEY
      })
    } catch {
      throw new Error('本地存储初始化失败')
    }
  }

  async setUserInfo(user: HDMUser): Promise<void> {
    try {
      const store = this.getStore()
      store.putSync(GlobalVariable.USER_INFO_KEY, user)
      await store.flush()
    } catch {
      throw new Error('用户信息保存失败')
    }
  }

  getUserInfo(): HDMUser | null {
    try {
      const store = this.getStore()
      const raw = store.getSync(GlobalVariable.USER_INFO_KEY, null)
      if (raw === null || raw === undefined) {
        return null
      }
      return raw as HDMUser
    } catch {
      return null
    }
  }

  async setFormId(formId: string): Promise<void> {
    try {
      const store = this.getStore()
      const formIdList = this.getFormId()
      formIdList.push(formId)
      store.putSync(GlobalVariable.FORM_ID_LIST, formIdList)
      await store.flush()
    } catch {
      throw new Error('卡片信息保存失败')
    }
  }

  getFormId(): string[] {
    try {
      const store = this.getStore()
      return store.getSync(GlobalVariable.FORM_ID_LIST, []) as string[]
    } catch {
      return []
    }
  }
}

export const storeManager = new StoreManager()
