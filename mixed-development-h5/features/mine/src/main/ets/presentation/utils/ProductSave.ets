import { util } from '@kit.ArkTS'
import { RequestAxios } from 'network'
import { auth, storeManager } from 'storage'
import { ProductBody, ProductData, ProductPending, ProductError, ProductImageResult } from '../../data/api/products'

export class ProductSave {
  private running: Map<string, Promise<ProductData>> = new Map<string, Promise<ProductData>>()
  private key(userId: string, productId: string): string { return 'product-save:' + userId + ':' + (productId || 'new') }
  pending(userId: string, productId: string): ProductPending | null {
    if (!userId) return null
    const raw = storeManager.getStore().getSync(this.key(userId, productId), '') as string
    if (!raw) return null
    const draft = JSON.parse(raw) as ProductPending
    if (draft.productId !== productId || !draft.body?.requestKey || !draft.imageKey) throw new Error('本地保存记录异常，请核查商品')
    return draft
  }
  private assertSession(token: string): string {
    const user = auth.getUserInfo()
    if (!user?.id || user.role !== 'merchant' || !token || user.token !== token || storeManager.getUserInfo()?.token !== token) {
      throw new Error('登录状态已变化，请重新登录后确认保存结果')
    }
    return user.id
  }
  start(productId: string, body: ProductBody, image: string, token: string): Promise<ProductData> {
    try {
      const userId = this.assertSession(token), key = this.key(userId, productId)
      const active = this.running.get(key)
      if (active) return active
      if (this.pending(userId, productId)) return Promise.reject(new Error('请先确认本商品保存结果'))
      const input = JSON.parse(JSON.stringify(body)) as ProductBody
      input.requestKey = util.generateRandomUUID()
      return this.run(userId, { productId, body: input, image, imageKey: util.generateRandomUUID() }, token, false)
    } catch (error) { return Promise.reject(error as Error) }
  }
  resume(productId: string, token: string): Promise<ProductData> {
    try {
      const userId = this.assertSession(token), key = this.key(userId, productId)
      const active = this.running.get(key)
      if (active) return active
      const draft = this.pending(userId, productId)
      if (!draft) return Promise.reject(new Error('没有待确认的保存'))
      return this.run(userId, draft, token, true)
    } catch (error) { return Promise.reject(error as Error) }
  }
  private run(userId: string, draft: ProductPending, token: string, resume: boolean): Promise<ProductData> {
    const key = this.key(userId, draft.productId)
    const task = this.execute(userId, draft, token, resume).finally(() => this.running.delete(key))
    this.running.set(key, task)
    return task
  }
  private async persist(userId: string, productId: string, draft: ProductPending | null, clearDraft: boolean = false): Promise<void> {
    const store = storeManager.getStore(), key = this.key(userId, productId)
    const before = store.getSync(key, '') as string
    const formKey = 'product-draft:' + userId + ':' + (productId || 'new')
    const formBefore = store.getSync(formKey, '') as string
    store.putSync(key, draft ? JSON.stringify(draft) : '')
    if (clearDraft) store.putSync(formKey, '')
    try { await store.flush() } catch {
      store.putSync(key, before)
      if (clearDraft) store.putSync(formKey, formBefore)
      throw new Error('本地记录保存失败，输入已保留')
    }
  }
  private status(error: Error): number { const failure = error as ProductError; return failure.httpStatus || failure.response?.status || 0 }
  private async find(draft: ProductPending, token: string): Promise<ProductData | null> {
    this.assertSession(token)
    try {
      const result = await RequestAxios.getForSession<ProductData>('/merchant/products/changes/' + draft.body.requestKey, token)
      this.assertSession(token)
      return result
    } catch (error) { this.assertSession(token); if (this.status(error as Error) === 404) return null; throw error as Error }
  }
  private async finish(userId: string, draft: ProductPending, token: string, result: ProductData): Promise<ProductData> {
    this.assertSession(token)
    if (!result.id || (draft.productId && draft.productId !== result.id)) throw new Error('返回商品不一致，请核查保存结果')
    await this.persist(userId, draft.productId, null, draft.body.name !== undefined || draft.body.expectedRevision !== undefined)
    this.assertSession(token)
    return result
  }
  private async execute(userId: string, draft: ProductPending, token: string, resume: boolean): Promise<ProductData> {
    this.assertSession(token)
    await this.persist(userId, draft.productId, draft)
    this.assertSession(token)
    if (resume) {
      const known = await this.find(draft, token)
      if (known) return this.finish(userId, draft, token, known)
    }
    let result: ProductData
    try {
      if (draft.image) {
        const bytes = new util.Base64Helper().decodeSync(draft.image)
        const image = await RequestAxios.postMultipartForSession<ProductImageResult>('/merchant/products/images', bytes.buffer as ArrayBuffer, draft.imageKey, token)
        this.assertSession(token)
        draft.body.imageId = image.imageId; draft.image = ''
        await this.persist(userId, draft.productId, draft)
        this.assertSession(token)
      }
      result = draft.productId ? await RequestAxios.putForSession<ProductData>('/merchant/products/' + encodeURIComponent(draft.productId), draft.body, token) :
        await RequestAxios.postWithSession<ProductData>('/merchant/products', draft.body, token)
    } catch (error) {
      this.assertSession(token)
      const known = await this.find(draft, token).catch((): null => null)
      this.assertSession(token)
      if (known) return this.finish(userId, draft, token, known)
      if ([400, 403, 404, 409, 413, 422].includes(this.status(error as Error))) await this.persist(userId, draft.productId, null)
      throw error as Error
    }
    return this.finish(userId, draft, token, result)
  }
}
export const productSave = new ProductSave()
