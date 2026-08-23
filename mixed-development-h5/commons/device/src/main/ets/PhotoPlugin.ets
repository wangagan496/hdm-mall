import fs from '@ohos.file.fs'
import { util } from '@kit.ArkTS'
import { photoAccessHelper } from '@kit.MediaLibraryKit'

class PhotoPlugin {
  async pickerPhoto(): Promise<string> {
    let PhotoSelectOptions = new photoAccessHelper.PhotoSelectOptions()
    PhotoSelectOptions.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE
    PhotoSelectOptions.maxSelectNumber = 1
    let photoPicker = new photoAccessHelper.PhotoViewPicker()
    let photoSelectResult: photoAccessHelper.PhotoSelectResult = await photoPicker.select(PhotoSelectOptions)
    const uri = photoSelectResult.photoUris[0]
    if (!uri) {
      return ''
    }
    const file = fs.openSync(uri)
    try {
      const stat = fs.statSync(file.fd)
      const buffer = new ArrayBuffer(stat.size)
      fs.readSync(file.fd, buffer)
      const helper = new util.Base64Helper()
      return helper.encodeToStringSync(new Uint8Array(buffer))
    } finally {
      fs.closeSync(file)
    }
  }
}

export const photoPlugin = new PhotoPlugin()
