import { abilityAccessCtrl, bundleManager, common, Permissions } from "@kit.AbilityKit"

export interface PermissionOutcome {
  granted: boolean
  prompted: boolean
}

interface PermissionRequestError {
  code?: number
  message?: string
}

function isPermissionRejected(error: Error): boolean {
  const requestError = error as PermissionRequestError
  const message: string = requestError.message || ''
  return requestError.code === 201 ||
    /用户未授权|用户拒绝|用户取消|user.*(?:denied|reject|cancel|not authorized|not grant)|(?:denied|reject|cancel).*user/i.test(message)
}

export class AccessManager {
  async runWithPermissions(context: common.UIAbilityContext, permissions: Permissions[], onPermissionsGranted: () => void): Promise<PermissionOutcome> {
    try {
      const appInfo = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION)
      const permissionManager = abilityAccessCtrl.createAtManager()
      const hasAllPermissions = permissions.every(item => {
        const status = permissionManager.checkAccessTokenSync(appInfo.appInfo.accessTokenId, item)
        return status === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED
      })
      if (hasAllPermissions) {
        onPermissionsGranted()
        return { granted: true, prompted: false }
      }
      const result = await permissionManager.requestPermissionsFromUser(context, permissions)
      const prompted: boolean = !result.dialogShownResults || result.dialogShownResults.length !== permissions.length ||
        result.dialogShownResults.some(shown => shown)
      const grantedAllPermissions = result.authResults.length === permissions.length && result.authResults.every(status => {
        return status === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED
      })
      if (grantedAllPermissions) {
        onPermissionsGranted()
        return { granted: true, prompted }
      }
      if (prompted) return { granted: false, prompted: true }
      try {
        const settingResults = await permissionManager.requestPermissionOnSetting(context, permissions)
        if (settingResults.length === permissions.length && settingResults.every(status =>
          status === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED)) {
          onPermissionsGranted()
          return { granted: true, prompted: true }
        }
      } catch (error) {
        if (isPermissionRejected(error as Error)) return { granted: false, prompted: true }
        const requestError = error as PermissionRequestError
        throw new Error(requestError.message || '权限申请失败，请重试')
      }
      return { granted: false, prompted: true }
    } catch {
      throw new Error('权限申请失败，请重试')
    }
  }
}

export const accessManager = new AccessManager()
