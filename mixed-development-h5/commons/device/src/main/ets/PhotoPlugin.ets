import fs from '@ohos.file.fs'
import { photoAccessHelper } from '@kit.MediaLibraryKit'
import { encodeAvatarFile } from './AvatarImage'

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
      return await encodeAvatarFile(file.fd)
    } finally {
      fs.closeSync(file)
    }
  }
}

export const photoPlugin = new PhotoPlugin()
