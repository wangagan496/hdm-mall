import { fileIo as fs } from '@kit.CoreFileKit'
import { photoAccessHelper } from '@kit.MediaLibraryKit'
import { encodeAvatarFile } from './AvatarImage'
import { BusinessError } from '@kit.BasicServicesKit'

class PhotoPlugin {
  async pickerPhoto(): Promise<string> {
    try {
      const photoSelectionOptions = new photoAccessHelper.PhotoSelectOptions()
      photoSelectionOptions.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE
      photoSelectionOptions.maxSelectNumber = 1
      const picker = new photoAccessHelper.PhotoViewPicker()
      const selectedPhotos: photoAccessHelper.PhotoSelectResult = await picker.select(photoSelectionOptions)
      const selectedPhotoUri = selectedPhotos.photoUris[0]
      if (!selectedPhotoUri) {
        return ''
      }
      const photoFile = fs.openSync(selectedPhotoUri)
      try {
        // 将图片裁剪、压缩成头像，再把 Base64 图片内容交给网页预览。
        return await encodeAvatarFile(photoFile.fd)
      } finally {
        try {
          fs.closeSync(photoFile)
        } catch {
        }
      }
    } catch (error) {
      const code: number = (error as BusinessError).code
      if (code === 201 || code === 13900012) throw new Error('未获得所选照片的读取权限，请重新选择')
      throw new Error('相册读取失败，请重试')
    }
  }
}

export const photoPlugin = new PhotoPlugin()
