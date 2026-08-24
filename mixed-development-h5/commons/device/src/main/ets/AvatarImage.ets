import { image } from '@kit.ImageKit'
import { util } from '@kit.ArkTS'

const AVATAR_SIZE: number = 256
const AVATAR_QUALITY: number = 80

export async function encodeAvatarFile(fd: number): Promise<string> {
  const source: image.ImageSource = image.createImageSource(fd)
  const packer: image.ImagePacker = image.createImagePacker()
  let pixelMap: image.PixelMap | undefined = undefined

  try {
    const info: image.ImageInfo = await source.getImageInfo()
    const desiredSize: image.Size = info.size.width <= info.size.height ? {
      width: AVATAR_SIZE,
      height: Math.round(info.size.height * AVATAR_SIZE / info.size.width)
    } : {
      width: Math.round(info.size.width * AVATAR_SIZE / info.size.height),
      height: AVATAR_SIZE
    }
    pixelMap = await source.createPixelMap({
      desiredSize: desiredSize
    })
    const pixelInfo: image.ImageInfo = await pixelMap.getImageInfo()
    const side: number = Math.min(pixelInfo.size.width, pixelInfo.size.height)
    await pixelMap.crop({
      x: Math.floor((pixelInfo.size.width - side) / 2),
      y: Math.floor((pixelInfo.size.height - side) / 2),
      size: { width: side, height: side }
    })
    const data: ArrayBuffer = await packer.packToData(pixelMap, {
      format: 'image/jpeg',
      quality: AVATAR_QUALITY
    })
    return new util.Base64Helper().encodeToStringSync(new Uint8Array(data))
  } finally {
    if (pixelMap) {
      await pixelMap.release()
    }
    await packer.release()
    await source.release()
  }
}
