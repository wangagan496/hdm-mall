import { display, window } from "@kit.ArkUI"
import { common } from "@kit.AbilityKit"
import { GlobalVariable } from "constants"
import { BreakPointEnum } from "models"

export class ScreenManagerByMedia {
  private sizeChangeCallback: ((size: window.Size) => void) | null = null

  // 开启监听屏幕变化
  async registerListenerScreen(ctx: common.UIAbilityContext) {
    try {
      const mainWindow = await window.getLastWindow(ctx)
      const uiContext = mainWindow.getUIContext()
      if (this.sizeChangeCallback) {
        mainWindow.off("windowSizeChange", this.sizeChangeCallback)
      }
      this.judgeScreen(uiContext.px2vp(display.getDefaultDisplaySync().width))
      this.sizeChangeCallback = (size: window.Size) => {
        this.judgeScreen(uiContext.px2vp(size.width))
      }
      mainWindow.on("windowSizeChange", this.sizeChangeCallback)
    } catch {
    }
  }

  // 判断屏幕大小并写入 AppStorage
  judgeScreen(width: number) {
    let breakPoint: string = ""
    if (width < 320) {
      breakPoint = BreakPointEnum.xs
    } else if (width >= 320 && width < 520) {
      breakPoint = BreakPointEnum.sm
    } else if (width >= 520 && width < 840) {
      breakPoint = BreakPointEnum.md
    } else {
      breakPoint = BreakPointEnum.lg
    }
    AppStorage.setOrCreate(GlobalVariable.BREAK_POINT_KEY, breakPoint)
  }

  // 卸载监听
  async unregisterListenerScreen(ctx: common.UIAbilityContext) {
    try {
      const mainWindow = await window.getLastWindow(ctx)
      if (this.sizeChangeCallback) {
        mainWindow.off("windowSizeChange", this.sizeChangeCallback)
        this.sizeChangeCallback = null
      }
    } catch {
    }
  }
}

export const screenManagerByMedia = new ScreenManagerByMedia()
