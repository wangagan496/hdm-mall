import { abilityAccessCtrl, bundleManager, common, Permissions } from "@kit.AbilityKit"

export class AccessManager {
  async checkPermission(context: common.UIAbilityContext, permissions: Permissions[], callback: () => void) {
    const appInfo = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION)
    const manager = abilityAccessCtrl.createAtManager()
    let isHave = permissions.every(item => {
      let status = manager.checkAccessTokenSync(appInfo.appInfo.accessTokenId, item)
      return status === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED
    })
    if (isHave) {
      callback()
    } else {
      const result = await manager.requestPermissionsFromUser(context, permissions)
      let againHave = result.authResults.every(status => {
        return status === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED
      })
      if (againHave) {
        callback()
      } else {
        manager.requestPermissionOnSetting(context, permissions)
      }
    }
  }
}

export const accessManager = new AccessManager()
