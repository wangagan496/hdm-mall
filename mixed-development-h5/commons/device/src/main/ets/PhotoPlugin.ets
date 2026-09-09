import { fileIo as fs } from '@kit.CoreFileKit'
import { photoAccessHelper } from '@kit.MediaLibraryKit'
import { encodeAvatarFile } from './AvatarImage'

class PhotoPlugin {
  async pickerPhoto(): Promise<string> {
    try {
      const options = new photoAccessHelper.PhotoSelectOptions()
      options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE
      options.maxSelectNumber = 1
      const picker = new photoAccessHelper.PhotoViewPicker()
      const result: photoAccessHelper.PhotoSelectResult = await picker.select(options)
      const uri = result.photoUris[0]
      if (!uri) {
        return ''
      }
      const file = fs.openSync(uri)
      try {
        return await encodeAvatarFile(file.fd)
      } finally {
        try {
          fs.closeSync(file)
        } catch {
        }
      }
    } catch {
      return ''
    }
  }
}

export const photoPlugin = new PhotoPlugin()
