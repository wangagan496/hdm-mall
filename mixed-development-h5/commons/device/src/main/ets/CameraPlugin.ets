import { camera, cameraPicker } from '@kit.CameraKit'
import { common } from '@kit.AbilityKit'
import { fileIo } from '@kit.CoreFileKit'
import { encodeAvatarFile } from './AvatarImage'

class CameraPlugin {
  async pickerCamera(context: common.UIAbilityContext): Promise<string> {
    const pickerProfile: cameraPicker.PickerProfile = {
      cameraPosition: camera.CameraPosition.CAMERA_POSITION_BACK
    }
    const pickerResult: cameraPicker.PickerResult = await cameraPicker.pick(context,
      [cameraPicker.PickerMediaType.PHOTO], pickerProfile)
    if (!pickerResult) {
      return ''
    }
    const file = fileIo.openSync(pickerResult.resultUri)
    try {
      return await encodeAvatarFile(file.fd)
    } finally {
      fileIo.closeSync(file)
    }
  }
}

export const cameraPlugin = new CameraPlugin()
