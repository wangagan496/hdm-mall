import { fileIo } from "@kit.CoreFileKit"
import { formBindingData, formProvider } from "@kit.FormKit"
import { GlobalVariable } from "constants"

const MAX_CARD_IMAGES: number = 5

export class PushCardManager {
  /**
   * 把本地图片通过 fd 推送到服务卡片。
   * 打开的文件句柄只在 updateForm 期间需要存活，推送完成后统一关闭，
   * 否则首页每次刷新促销数据都会泄漏一批 fd。
   */
  async pushImageToCard(list: string[], formIdList: string[]): Promise<void> {
    if (formIdList.length === 0) {
      return
    }
    const images: string[] = list.slice(0, MAX_CARD_IMAGES)
    const imageList: string[] = []
    const formImages: Record<string, number> = {}
    const openedFiles: fileIo.File[] = []
    try {
      images.forEach((url: string) => {
        const file: fileIo.File = fileIo.openSync(url, fileIo.OpenMode.READ_ONLY)
        openedFiles.push(file)
        imageList.push(url)
        formImages[url] = file.fd
      })

      const data: formBindingData.FormBindingData = formBindingData.createFormBindingData({
        formImages,
        imageList
      })
      AppStorage.setOrCreate(GlobalVariable.CARD_IMAGE_DATA, data)
      // 单张卡片更新失败不影响其余卡片
      await Promise.allSettled(formIdList.map((formId: string) => formProvider.updateForm(formId, data)))
    } finally {
      openedFiles.forEach((file: fileIo.File) => {
        try {
          fileIo.closeSync(file)
        } catch {
        }
      })
    }
  }
}

export const pushCardManager = new PushCardManager()
