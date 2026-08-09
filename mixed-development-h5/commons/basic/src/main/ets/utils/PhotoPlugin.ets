import { picker } from '@kit.CoreFileKit'
import fs from '@ohos.file.fs';
import { util } from '@kit.ArkTS';
import { photoAccessHelper } from '@kit.MediaLibraryKit';

class PhotoPlugin {
  async pickerPhoto() {
    // 1. 打开相册选择图片

    // 1. 创建选择选项
    let PhotoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
    // 设置媒体文件类型为图片
    PhotoSelectOptions.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
    // 设置最大选择数量为1
    PhotoSelectOptions.maxSelectNumber = 1;

    // 2. 实例化图片选择器
    let photoPicker = new photoAccessHelper.PhotoViewPicker();

    // 3. 调用select方法，拉起系统相册界面
    let photoSelectResult: photoAccessHelper.PhotoSelectResult = await photoPicker.select(PhotoSelectOptions);
    // 4. 获取所选图片的URI路径（数组，第一个元素即为路径）
    let imageUri = photoSelectResult.photoUris;
    console.info('所选图片URI:', imageUri);

    console.log('mk-logger', 'photoPlugin', JSON.stringify(imageUri))

    // 2. 文件操作
    // 2.1 获取照片的uri地址
    const uri = imageUri[0]
    // 2.2 根据uri同步打开文件
    const file = fs.openSync(uri)
    // 2.3 同步获取文件的详细信息
    const stat = fs.statSync(file.fd)
    // 2.4 创建缓冲区存储读取的文件流
    const buffer = new ArrayBuffer(stat.size)
    // 2.5 开始同步读取文件流到缓冲区
    fs.readSync(file.fd, buffer)
    // 2.6 关闭文件流
    fs.closeSync(file)

    // 3. 转成base64编码的字符串
    const helper = new util.Base64Helper()
    const str = helper.encodeToStringSync(new Uint8Array(buffer))
    console.log('mk-logger', 'photoPlugin-str', str)

    return str
  }
}


export const photoPlugin = new PhotoPlugin()