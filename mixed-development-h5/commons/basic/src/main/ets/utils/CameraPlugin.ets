import { camera, cameraPicker } from '@kit.CameraKit';

import { util } from '@kit.ArkTS';
import { fileIo } from '@kit.CoreFileKit';

class CameraPlugin {
  async pickerCamera() {
    // 1. 打开相机后置摄像头得到拍照结果集
    const pickerProfile: cameraPicker.PickerProfile = {
      cameraPosition: camera.CameraPosition.CAMERA_POSITION_BACK
    };
    const pickerResult: cameraPicker.PickerResult = await cameraPicker.pick(getContext(),
      [cameraPicker.PickerMediaType.PHOTO], pickerProfile);

    if (!pickerResult) {
      return
    }
    // 2. 根据结果集的URI属性同步打开文件
    const file = fileIo.openSync(pickerResult.resultUri)
    // 3. 同步读取文件的详情信息
    const stat = fileIo.statSync(file.fd)
    // 4. 定义缓冲区用于保存读取的文件
    const buffer = new ArrayBuffer(stat.size)
    // 5. 开始同步读取内容到缓冲区
    fileIo.readSync(file.fd, buffer)
    // 6. 读取完毕后关闭文件流
    fileIo.closeSync(file)


    // 7. 借助util工具方法把读取的文件流转成base64编码的字符串
    const helper = new util.Base64Helper()
    const str = helper.encodeToStringSync(new Uint8Array(buffer))
    console.log('mk-logger', 'pickerCamera', str)
    return str
  }
}


export const cameraPlugin = new CameraPlugin()