import { cacheDownload } from '@kit.BasicServicesKit'

// 每批只提前准备少量图片，避免大列表一次抢占过多网络资源。
const MAX_PRELOAD_IMAGES: number = 8

// 提前把图片交给系统缓存；页面仍使用原网址，Image 会自行读取可用缓存。
export function preloadImages(imageSources: ResourceStr[]): void {
  const selectedUrls: Set<string> = new Set<string>()
  for (const imageUrl of imageSources) {
    if (selectedUrls.size >= MAX_PRELOAD_IMAGES) {
      break
    }
    // App 自带的 Resource 图片不需要网络预加载。
    if (typeof imageUrl !== 'string' ||
      (!imageUrl.startsWith('https://') && !imageUrl.startsWith('http://')) || selectedUrls.has(imageUrl)) {
      continue
    }
    selectedUrls.add(imageUrl)
    try {
      // API 23：已有缓存就复用，缺少缓存才下载；不等待它，不阻塞页面展示。
      cacheDownload.download(imageUrl, { cacheStrategy: cacheDownload.CacheStrategy.LAZY })
    } catch {
      // 预加载只是加速：启动失败时，Image 仍按原网址正常加载。
    }
  }
}
