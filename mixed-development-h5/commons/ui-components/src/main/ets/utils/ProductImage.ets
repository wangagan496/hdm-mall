import { image } from '@kit.ImageKit'
import { fileIo as fs } from '@kit.CoreFileKit'
import { photoAccessHelper } from '@kit.MediaLibraryKit'
import { util } from '@kit.ArkTS'

export async function encodeProductFile(fd: number): Promise<ArrayBuffer> {
  const source = image.createImageSource(fd), packer = image.createImagePacker()
  let pixels: image.PixelMap | undefined = undefined
  try {
    const info = await source.getImageInfo()
    if (info.size.width <= 0 || info.size.height <= 0) throw new Error('图片无法读取，请换一张')
    const dimensions: number[] = [1600, 1200, 800, 480]
    const qualities: number[] = [85, 70, 55]
    for (const dimension of dimensions) {
      const scale = Math.min(1, dimension / Math.max(info.size.width, info.size.height))
      pixels = await source.createPixelMap({ desiredSize: {
        width: Math.max(1, Math.round(info.size.width * scale)), height: Math.max(1, Math.round(info.size.height * scale))
      } })
      for (const quality of qualities) {
        const bytes = await packer.packToData(pixels, { format: 'image/jpeg', quality })
        if (bytes.byteLength <= 512 * 1024) return bytes
      }
      await pixels.release(); pixels = undefined
    }
    throw new Error('图片过大，请换一张')
  } finally {
    if (pixels) { try { await pixels.release() } catch {} }
    try { await packer.release() } catch {}
    try { await source.release() } catch {}
  }
}

export async function pickProductImage(): Promise<string> {
  const options = new photoAccessHelper.PhotoSelectOptions()
  options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE; options.maxSelectNumber = 1
  const selected = await new photoAccessHelper.PhotoViewPicker().select(options)
  if (!selected.photoUris[0]) return ''
  const file = fs.openSync(selected.photoUris[0], fs.OpenMode.READ_ONLY)
  try { return new util.Base64Helper().encodeToStringSync(new Uint8Array(await encodeProductFile(file.fd))) }
  finally { try { fs.closeSync(file) } catch {} }
}
