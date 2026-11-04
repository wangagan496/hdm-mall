import { camera, cameraPicker } from '@kit.CameraKit'
import { common } from '@kit.AbilityKit'
import { fileIo } from '@kit.CoreFileKit'
import { encodeAvatarFile } from './AvatarImage'
import { BusinessError } from '@kit.BasicServicesKit'

class CameraPlugin {
  async pickerCamera(context: common.UIAbilityContext): Promise<string> {
    try {
      const cameraOptions: cameraPicker.PickerProfile = {
        cameraPosition: camera.CameraPosition.CAMERA_POSITION_BACK
      }
      const capturedPhoto: cameraPicker.PickerResult = await cameraPicker.pick(context,
        [cameraPicker.PickerMediaType.PHOTO], cameraOptions)
      if (!capturedPhoto || !capturedPhoto.resultUri) {
        return ''
      }
      if (capturedPhoto.resultCode !== 0) throw new Error('相机未能完成拍摄')
      const photoFile = fileIo.openSync(capturedPhoto.resultUri)
      try {
        // 将图片裁剪、压缩成头像，再把 Base64 图片内容交给网页预览。
        return await encodeAvatarFile(photoFile.fd)
      } finally {
        try {
          fileIo.closeSync(photoFile)
        } catch {
        }
      }
    } catch (error) {
      const code: number = (error as BusinessError).code
      if (code === 201 || code === 13900012) throw new Error('相机或照片读取权限未允许，请授权后重试')
      throw new Error('拍照失败，请重试')
    }
  }
}

export const cameraPlugin = new CameraPlugin()
