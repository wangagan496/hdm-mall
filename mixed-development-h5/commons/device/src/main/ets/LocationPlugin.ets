import { util } from '@kit.ArkTS'
import { common } from '@kit.AbilityKit'

class LocationPlugin {
  getAreaColumns(context: common.UIAbilityContext): string {
    try {
      const unit8Array = context.resourceManager.getRawFileContentSync('area.json')
      const decoder = new util.TextDecoder()
      return decoder.decodeToString(unit8Array)
    } catch {
      return '[]'
    }
  }
}

export const locationPlugin = new LocationPlugin()
