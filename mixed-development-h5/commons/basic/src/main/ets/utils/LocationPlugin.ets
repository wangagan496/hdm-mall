import { util } from '@kit.ArkTS'

class LocationPlugin {
  getAreaColumns() {
    // 2. 读取rawfile目录下的本地文件
    const unit8Array = getContext()
      .resourceManager
      .getRawFileContentSync('area.json')
    // 3. 将读取的字节数组转成字符串
    const decoder = new util.TextDecoder()
    const resStr = decoder.decodeToString(unit8Array)

    return resStr
  }
}

export const locationPlugin = new LocationPlugin()