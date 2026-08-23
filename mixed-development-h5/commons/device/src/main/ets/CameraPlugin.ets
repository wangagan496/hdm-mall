import { camera, cameraPicker } from '@kit.CameraKit'
import { common } from '@kit.AbilityKit'
import { util } from '@kit.ArkTS'
import { fileIo } from '@kit.CoreFileKit'

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
      const stat = fileIo.statSync(file.fd)
      const buffer = new ArrayBuffer(stat.size)
      fileIo.readSync(file.fd, buffer)
      const helper = new util.Base64Helper()
      return helper.encodeToStringSync(new Uint8Array(buffer))
    } finally {
      fileIo.closeSync(file)
    }
  }
}

export const cameraPlugin = new CameraPlugin()
