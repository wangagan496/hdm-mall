import { request } from '@kit.BasicServicesKit'
import { common } from '@kit.AbilityKit'
import { util } from '@kit.ArkTS'
import { fileIo } from '@kit.CoreFileKit'

interface CachedImage {
  url: string
  path: string
  created: number
  size: number
  checksum: number
}

const CACHE_TTL: number = 60 * 60 * 1000
const CACHE_LIMIT: number = 32 * 1024 * 1024
export class DownLoadManager {
  private directory: string = ''
  private entries: CachedImage[] = []
  private pending: Map<string, Promise<string>> = new Map<string, Promise<string>>()
  private retained: Map<string, number> = new Map<string, number>()
  private downloading: Set<string> = new Set<string>()

  private initialize(context: common.UIAbilityContext): void {
    const directory: string = context.cacheDir + '/card-images'
    if (this.directory === directory) return
    if (!fileIo.accessSync(directory)) fileIo.mkdirSync(directory, true)
    this.directory = directory
    try {
      const loaded: CachedImage[] = JSON.parse(fileIo.readTextSync(directory + '/index.json')) as CachedImage[]
      this.entries = Array.isArray(loaded) ? loaded.filter(entry => typeof entry.path === 'string' &&
        entry.path.startsWith(directory + '/') && !entry.path.includes('/../') &&
        typeof entry.url === 'string' && Number.isFinite(entry.created) &&
        entry.size > 0 && entry.size <= 8 * 1024 * 1024 && Number.isFinite(entry.checksum)) : []
    } catch {
      this.entries = []
    }
    this.prune()
  }

  private saveIndex(): void {
    const file = fileIo.openSync(this.directory + '/index.tmp', fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC)
    try { fileIo.writeSync(file.fd, JSON.stringify(this.entries)) } finally { fileIo.closeSync(file) }
    fileIo.renameSync(this.directory + '/index.tmp', this.directory + '/index.json')
  }

  private remove(path: string): void {
    try { fileIo.unlinkSync(path) } catch {}
  }

  private checksum(path: string, size: number): number {
    if (size > 8 * 1024 * 1024) throw new Error('卡片图片过大')
    const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY)
    try {
      const buffer = new ArrayBuffer(size)
      if (fileIo.readSync(file.fd, buffer) !== size) throw new Error('图片读取不完整')
      const bytes = new Uint8Array(buffer)
      let checksum: number = 2166136261
      for (let index: number = 0; index < bytes.length; index++) {
        checksum = Math.imul(checksum ^ bytes[index], 16777619) >>> 0
      }
      return checksum
    } finally { fileIo.closeSync(file) }
  }

  private prune(): void {
    let bytes: number = 0
    const keep: CachedImage[] = []
    for (const entry of this.entries.slice().sort((a, b) => b.created - a.created)) {
      const retained: boolean = (this.retained.get(entry.path) || 0) > 0
      if (retained || (Date.now() - entry.created < CACHE_TTL && bytes + entry.size <= CACHE_LIMIT && keep.length < 32)) {
        keep.push(entry)
        bytes += entry.size
      } else {
        this.remove(entry.path)
      }
    }
    this.entries = keep
    this.saveIndex()
    // 仅清理本缓存目录内由本下载器创建的图片，回收崩溃和坏索引留下的孤儿文件。
    for (const name of fileIo.listFileSync(this.directory)) {
      const path: string = this.directory + '/' + name
      if (/^[0-9a-f-]+\.jpg$/i.test(name) && !this.downloading.has(path) && !this.retained.has(path) &&
        !this.entries.some(entry => entry.path === path)) this.remove(path)
    }
  }

  // 返回的文件在调用方推送完毕前保留；releaseImages 统一释放后再做容量清理。
  async downLoadImages(context: common.UIAbilityContext, urls: string[]): Promise<string[]> {
    this.initialize(context)
    const selected: string[] = Array.from(new Set<string>(urls.filter(url => /^https?:\/\//.test(url)))).slice(0, 5)
    const results = await Promise.all(selected.map(url => this.downloadImage(context, url).then(path => {
      this.retained.set(path, (this.retained.get(path) || 0) + 1)
      return path
    }).catch((): string => '')))
    return results.filter(path => path !== '')
  }

  releaseImages(paths: string[]): void {
    for (const path of paths) {
      const count: number = this.retained.get(path) || 0
      if (count <= 1) this.retained.delete(path)
      else this.retained.set(path, count - 1)
    }
    this.prune()
  }

  private async downloadImage(context: common.UIAbilityContext, url: string): Promise<string> {
    const cached = this.entries.find(entry => entry.url === url && Date.now() - entry.created < CACHE_TTL)
    if (cached) {
      try {
        const stat = fileIo.statSync(cached.path)
        if (stat.size > 0 && stat.size === cached.size && this.checksum(cached.path, stat.size) === cached.checksum) return cached.path
      } catch {}
      this.entries = this.entries.filter(entry => entry !== cached)
      if (!this.retained.has(cached.path)) this.remove(cached.path)
    }
    const pending = this.pending.get(url)
    if (pending) return pending
    const task = this.downloadFresh(context, url).finally(() => { this.pending.delete(url) })
    this.pending.set(url, task)
    return task
  }

  private async downloadFresh(context: common.UIAbilityContext, url: string): Promise<string> {
    const path: string = this.directory + '/' + util.generateRandomUUID() + '.jpg'
    this.downloading.add(path)
    try {
      const task = await request.downloadFile(context, { url, filePath: path })
      await this.waitForDownload(task)
      const size: number = fileIo.statSync(path).size
      if (size <= 0) throw new Error('图片文件为空')
      this.entries.push({ url, path, created: Date.now(), size, checksum: this.checksum(path, size) })
      this.saveIndex()
      return path
    } catch (error) {
      this.entries = this.entries.filter(entry => entry.path !== path)
      this.remove(path)
      throw error as Error
    } finally {
      this.downloading.delete(path)
    }
  }

  private waitForDownload(task: request.DownloadTask): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer: number = setTimeout(() => {
        void task.delete().catch(() => {})
        reject(new Error('图片下载超时'))
      }, 30000)
      task.on('complete', () => { clearTimeout(timer); resolve() })
      task.on('fail', () => { clearTimeout(timer); reject(new Error('下载失败')) })
    })
  }
}
export const downLoadManager = new DownLoadManager()
