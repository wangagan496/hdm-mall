import { abilityAccessCtrl, bundleManager, common, Permissions } from "@kit.AbilityKit"

export class AccessManager {
  async checkPermission(context: common.UIAbilityContext, permissions: Permissions[], callback: () => void): Promise<void> {
    try {
      const appInfo = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION)
      const manager = abilityAccessCtrl.createAtManager()
      const isHave = permissions.every(item => {
        const status = manager.checkAccessTokenSync(appInfo.appInfo.accessTokenId, item)
        return status === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED
      })
      if (isHave) {
        callback()
        return
      }
      const result = await manager.requestPermissionsFromUser(context, permissions)
      const againHave = result.authResults.every(status => {
        return status === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED
      })
      if (againHave) {
        callback()
      } else {
        manager.requestPermissionOnSetting(context, permissions)
      }
    } catch {
      // Permission failures are handled by the caller as a disabled capability.
    }
  }
}

export const accessManager = new AccessManager()
