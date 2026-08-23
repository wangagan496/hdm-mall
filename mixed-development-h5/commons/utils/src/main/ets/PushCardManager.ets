import { fileIo } from "@kit.CoreFileKit"
import { formBindingData, formProvider } from "@kit.FormKit"
import { GlobalVariable } from "constants"

export class PushCardManager {
  pushImageToCard(list: string[], formIdList: string[]) {
    const images = list.slice(0, 5)
    let imageList: string[] = []
    let formImages: Record<string, number> = {}
    images.forEach(url => {
      const file = fileIo.openSync(url, fileIo.OpenMode.READ_ONLY)
      imageList.push(url)
      formImages[url] = file.fd
    })

    let data = formBindingData.createFormBindingData({
      formImages,
      imageList
    })
    AppStorage.setOrCreate(GlobalVariable.CARD_IMAGE_DATA, data)
    formIdList.forEach(formId => {
      formProvider.updateForm(formId, data)
    })
  }
}

export const pushCardManager = new PushCardManager()
