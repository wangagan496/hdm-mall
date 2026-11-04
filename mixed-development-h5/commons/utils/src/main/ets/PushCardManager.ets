import { fileIo } from '@kit.CoreFileKit'
import { formBindingData, formProvider } from '@kit.FormKit'
import { BusinessError } from '@kit.BasicServicesKit'

export interface CardPushResult {
  failedFormIds: string[]
  superseded: boolean
}

export class PushCardManager {
  private generation: number = 0
  private queue: Promise<void> = Promise.resolve()

  pushImageToCard(list: string[], formIdList: string[]): Promise<CardPushResult> {
    const generation: number = ++this.generation
    const images: string[] = list.slice(0, 5)
    const ids: string[] = Array.from(new Set<string>(formIdList))
    const task = this.queue.then(() => this.pushVersion(images, ids, generation))
    // 后一版本在前一版本所有在途更新结束后才推送，旧图不会最后覆盖新图。
    this.queue = task.then(() => {}, () => {})
    return task
  }

  private async pushVersion(images: string[], ids: string[], generation: number): Promise<CardPushResult> {
    const failedFormIds: string[] = []
    const openedFiles: fileIo.File[] = []
    if (generation !== this.generation || ids.length === 0 || images.length === 0) {
      return { failedFormIds, superseded: generation !== this.generation }
    }
    try {
      const formImages: Record<string, number> = {}
      for (const path of images) {
        const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY)
        openedFiles.push(file)
        formImages[path] = file.fd
      }
      const data = formBindingData.createFormBindingData({ formImages, imageList: images })
      let pending: string[] = ids
      for (let attempt: number = 0; attempt < 3 && pending.length > 0; attempt++) {
        if (generation !== this.generation) break
        const results = await Promise.allSettled(pending.map(id => formProvider.updateForm(id, data)))
        const retry: string[] = []
        results.forEach((result, index: number) => {
          if (result.status === 'rejected') {
            const code: number = (result.reason as BusinessError).code
            // 仅 SDK 明确的内部暂时错误重试；删除、归属不符等错误立即停止。
            if (code === 16501000 && attempt < 2) retry.push(pending[index])
            else failedFormIds.push(pending[index])
          }
        })
        pending = retry
        if (pending.length > 0 && generation === this.generation) {
          await new Promise<void>(resolve => setTimeout(resolve, 500 * (attempt + 1)))
        }
      }
      return { failedFormIds, superseded: generation !== this.generation }
    } finally {
      // 句柄在整轮有限重试期间存活，全部结束后才释放。
      for (const file of openedFiles) {
        try { fileIo.closeSync(file) } catch {}
      }
    }
  }
}
export const pushCardManager = new PushCardManager()
