import { window, KeyboardAvoidMode } from "@kit.ArkUI"
import { common } from "@kit.AbilityKit"
import { GlobalVariable } from "constants"
import { deviceInfo } from "@kit.BasicServicesKit"

export class ScreenManager {
  async full(ctx: common.UIAbilityContext) {
    if (deviceInfo.deviceType !== "2in1") {
      const win = await window.getLastWindow(ctx)
      win.setWindowLayoutFullScreen(true)
      this.setAreaHeight(ctx)
    }
  }

  async setAreaHeight(ctx: common.UIAbilityContext) {
    const win = await window.getLastWindow(ctx)
    const uiContext = win.getUIContext()
    AppStorage.setOrCreate<number>(GlobalVariable.SAFE_AREA_TOP,
      uiContext.px2vp(win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM)
        .topRect.height))
    AppStorage.setOrCreate<number>(GlobalVariable.SAFE_AREA_BOTTOM,
      uiContext.px2vp(win.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR)
        .bottomRect.height))
  }

  async exitFull(ctx: common.UIAbilityContext) {
    const win = await window.getLastWindow(ctx)
    win.setWindowLayoutFullScreen(false)
  }

  async setKeyBoardMode(ctx: common.UIAbilityContext) {
    const win = await window.getLastWindow(ctx)
    win.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE)
  }
}

export const screenManager = new ScreenManager()
