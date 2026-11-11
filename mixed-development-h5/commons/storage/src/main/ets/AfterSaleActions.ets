import { util } from '@kit.ArkTS'
import { RequestAxios } from 'network'
import { AfterSaleBody, AfterSalePhoto, AfterSalePending, AfterSaleReceipt, AfterSaleImage } from 'models'
import { auth } from './Auth'
import { storeManager } from './StoreManager'

interface AfterSaleError { httpStatus?: number; response?: AfterSaleResponse }
interface AfterSaleResponse { status?: number }
export class AfterSaleActions {
  private running: Map<string, Promise<AfterSaleReceipt>> = new Map<string, Promise<AfterSaleReceipt>>()
  private key(account: string, order: string): string { return 'after-sale:' + account + ':' + order }
  private session(token: string): string {
    const user = auth.getUserInfo()
    if (!user?.id || !token || user.token !== token || storeManager.getUserInfo()?.token !== token) throw new Error('登录状态已变化，请重新登录后确认售后结果')
    return user.id
  }
  pending(account: string, order: string): AfterSalePending | null {
    if (!account || !order) return null
    const raw = storeManager.getStore().getSync(this.key(account,order),'') as string
    if (!raw) return null
    const saved = JSON.parse(raw) as AfterSalePending
    if (saved.orderId !== order || !saved.body.requestKey || !saved.url || !Array.isArray(saved.photos)) throw new Error('本地售后记录异常，请联系客服')
    return saved
  }
  start(order: string, url: string, body: AfterSaleBody, photos: AfterSalePhoto[], token: string): Promise<AfterSaleReceipt> {
    try {
      const account = this.session(token), key = this.key(account,order)
      const active = this.running.get(key); if (active) return active
      if (this.pending(account,order)) throw new Error('请先确认上次售后操作结果')
      const copy = JSON.parse(JSON.stringify(body)) as AfterSaleBody
      copy.requestKey = copy.requestKey || util.generateRandomUUID()
      const saved: AfterSalePending = {orderId:order,url,body:copy,photos:JSON.parse(JSON.stringify(photos)) as AfterSalePhoto[]}
      return this.run(account,saved,token)
    } catch(error) {return Promise.reject(error as Error)}
  }
  resume(order: string, token: string): Promise<AfterSaleReceipt> {
    try {
      const account=this.session(token), active=this.running.get(this.key(account,order)); if(active)return active
      const saved=this.pending(account,order); if(!saved)throw new Error('没有待确认的售后操作')
      return this.run(account,saved,token)
    } catch(error) {return Promise.reject(error as Error)}
  }
  private async persist(account: string, order: string, saved: AfterSalePending | null): Promise<void> {
    const store=storeManager.getStore(), key=this.key(account,order), before=store.getSync(key,'') as string
    store.putSync(key,saved?JSON.stringify(saved):'')
    try {await store.flush()} catch {store.putSync(key,before);throw new Error('本地记录保存失败，请重试')}
  }
  private run(account: string,saved: AfterSalePending,token: string): Promise<AfterSaleReceipt> {
    const key=this.key(account,saved.orderId)
    const task=this.execute(account,saved,token).finally(()=>this.running.delete(key));this.running.set(key,task);return task
  }
  private async execute(account: string,saved: AfterSalePending,token: string): Promise<AfterSaleReceipt> {
    this.session(token);await this.persist(account,saved.orderId,saved);this.session(token)
    try {
      while(saved.photos.length>0) {
        const photo=saved.photos[0], bytes=new util.Base64Helper().decodeSync(photo.bytes)
        const image=await RequestAxios.postMultipartForSession<AfterSaleImage>('/member/after-sales/images',bytes.buffer as ArrayBuffer,photo.requestKey,token,saved.orderId,saved.body.requestKey)
        this.session(token)
        if (saved.url.endsWith('/ship-back')) saved.body.shippingImageId = image.imageId
        else saved.body.imageIds=(saved.body.imageIds||[]).concat([image.imageId])
        saved.photos=saved.photos.slice(1)
        await this.persist(account,saved.orderId,saved);this.session(token)
      }
      const result=await RequestAxios.postWithSession<AfterSaleReceipt>(saved.url,saved.body,token)
      this.session(token)
      if(result.orderId!==saved.orderId || !result.afterSaleId)throw new Error('售后结果需要重新确认')
      await this.persist(account,saved.orderId,null);this.session(token);return result
    } catch(error) {
      this.session(token)
      const failure=error as AfterSaleError, status=failure.httpStatus||failure.response?.status||0
      if([400,403,404,409,413,422].includes(status))await this.persist(account,saved.orderId,null)
      throw error as Error
    }
  }
}
export const afterSaleActions=new AfterSaleActions()
