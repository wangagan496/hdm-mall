import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMNavBar, AfterSalePhotos, pickProductImage } from 'ui_components'
import { HDMUser, AfterSaleImage, AfterSalePhoto, formatBeijingTime } from 'models'
import { RequestAxios } from 'network'
import { checkoutFailure } from 'storage'
import { util } from '@kit.ArkTS'

interface ServiceRoute { orderId?: string; buyerId?: string; orderName?: string; orderCreatedAt?: number }
interface ServiceMessage { id: number; buyerId: string; sender: string; orderId?: string; orderName?: string | null; orderCreatedAt?: number | null; content: string; createdAt: number; images: string[] }
interface ServiceHistory { items: ServiceMessage[]; hasMore: boolean; beforeId: number | null; buyerName: string }
interface ServiceBody { requestKey: string; content: string; orderId?: string; images: string[] }
interface ServiceImage { path: string }
interface ServiceRead { throughId: number }

@Builder
function CustomerServiceViewBuilder() { CustomerServiceView() }

@Component
export struct CustomerServiceView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) topHeight: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) bottomHeight: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = { account: '', nickname: '', token: '', avatar: '' }
  @State content: string = ''
  @State items: ServiceMessage[] = []
  @State photos: AfterSalePhoto[] = []
  @State message: string = ''
  @State messageOk: boolean = false
  @State orderName: string = ''
  @State orderCreatedAt: number = 0
  @State buyerName: string = ''
  @State orderId: string = ''
  @State buyerId: string = ''
  @State loading: boolean = false
  @State sending: boolean = false
  @State choosing: boolean = false
  @State pending: boolean = false
  @State hasMore: boolean = false
  private beforeId: number | null = null
  private pendingBody: ServiceBody | undefined = undefined
  private pendingPhotos: AfterSalePhoto[] = []
  private active: boolean = false
  private generation: number = 0
  private query: number = 0
  private accountId: string = ''
  private current(generation: number, token: string): boolean {
    return this.active && generation === this.generation && !!token && token === this.user.token && !!this.user.id
  }
  private accountChanged(): void {
    this.generation++; this.query++; this.items = []; this.photos = []; this.content = ''; this.message = ''; this.messageOk = false
    this.pendingBody = undefined; this.pendingPhotos = []; this.pending = false; this.loading = false; this.sending = false; this.choosing = false
    this.orderId = ''; this.orderName = ''; this.orderCreatedAt = 0; this.buyerId = ''; this.hasMore = false; this.beforeId = null
    this.accountId = this.user.id || ''
    if (this.active) void this.load()
  }
  aboutToDisappear(): void { this.active = false; this.generation++; this.query++; this.loading = false; this.sending = false; this.choosing = false; this.items = [] }
  private hidden(): void { if (!this.choosing) this.aboutToDisappear() }
  private shown(): void {
    if (this.active) return
    this.active = true
    if (this.accountId && this.accountId !== this.user.id) this.accountChanged()
    else void this.load()
  }
  private messageColor(): ResourceColor { return this.messageOk ? $r('[ui_components].color.text') : $r('[ui_components].color.red') }
  private orderLabel(name: string | null | undefined, createdAt: number | null | undefined): string {
    return '关联订单：' + (name || '订单') + (createdAt ? ' · ' + formatBeijingTime(createdAt) + ' 下单' : '')
  }
  private openOrder(orderId: string): void {
    this.stackPath.pushPath({ name: this.user.role === 'merchant' ? 'MerchantOrderView' : PAGE_PATH.ORDER_DETAIL_PAGE, param: orderId })
  }
  private endpoint(): string { return this.user.role === 'merchant' ? '/merchant/service/' + encodeURIComponent(this.buyerId) + '/messages' : '/member/service/messages' }
  private async load(older: boolean = false): Promise<void> {
    const token = this.user.token, generation = this.generation, query = ++this.query
    if (!this.current(generation, token)) { this.messageOk = false; this.message = '请登录后留言'; return }
    if (this.user.role === 'merchant' && !this.buyerId) { this.message = '请从商家客服留言列表选择买家'; return }
    if (older && (!this.hasMore || !this.beforeId)) return
    this.loading = true
    try {
      const history = await RequestAxios.getForSession<ServiceHistory>(this.endpoint() + '?limit=30' + (older ? '&beforeId=' + this.beforeId : ''), token)
      if (!this.current(generation, token) || query !== this.query) return
      this.items = older ? history.items.concat(this.items) : history.items
      this.hasMore = history.hasMore; this.beforeId = history.beforeId; this.buyerName = history.buyerName
      if (!older && this.user.role !== 'merchant' && history.items.length > 0) {
        await RequestAxios.postWithSession<null>('/member/service/read', { throughId: history.items[history.items.length - 1].id } as ServiceRead, token)
      }
    } catch { if (this.current(generation, token) && query === this.query) this.message = '留言读取或已读同步失败，请刷新重试，输入仍保留' }
    finally { if (this.current(generation, token) && query === this.query) this.loading = false }
  }
  private async choosePhoto(): Promise<void> {
    if (this.sending || this.pending || this.choosing || this.photos.length >= 3 || this.user.role === 'merchant') return
    const token = this.user.token, generation = this.generation
    if (!this.current(generation, token)) return
    this.choosing = true
    try {
      const bytes = await pickProductImage()
      if (this.current(generation, token) && bytes) this.photos = this.photos.concat([{ bytes, requestKey: util.generateRandomUUID(true) }])
    } catch { if (this.current(generation, token)) this.message = '照片读取失败，请重新选择' }
    finally { if (this.current(generation, token)) this.choosing = false }
  }
  private async send(): Promise<void> {
    const token = this.user.token, generation = this.generation
    if (this.sending || this.choosing || !this.current(generation, token) || this.user.role === 'merchant' && !this.buyerId) return
    if (!this.pendingBody) {
      const content = this.content.trim()
      if (!content || Array.from(content).length > 500) { this.message = '请填写1至500字的留言'; return }
      if (this.photos.length > 3) { this.message = '最多选择3张照片'; return }
      this.pendingBody = { requestKey: util.generateRandomUUID(true), content, orderId: this.orderId || undefined, images: [] }
      this.pendingPhotos = this.photos.slice()
    }
    this.pending = true; this.sending = true; this.message = ''; this.messageOk = false
    const body = this.pendingBody
    try {
      while (this.pendingPhotos.length > 0) {
        const photo = this.pendingPhotos[0], bytes = new util.Base64Helper().decodeSync(photo.bytes)
        const image = await RequestAxios.postMultipartForSession<ServiceImage>('/member/service/images', bytes.buffer as ArrayBuffer, photo.requestKey, token)
        if (!this.current(generation, token)) return
        body.images = body.images.concat([image.path]); this.pendingPhotos = this.pendingPhotos.slice(1)
      }
      await RequestAxios.postWithSession<ServiceMessage>(this.endpoint(), body, token)
      if (!this.current(generation, token)) return
      this.pendingBody = undefined; this.pendingPhotos = []; this.pending = false; this.content = ''; this.photos = []; this.messageOk = true; this.message = '已发送'
      await this.load()
    } catch (error) {
      if (!this.current(generation, token)) return
      const status = checkoutFailure(error as Error).status
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        this.pendingBody = undefined; this.pendingPhotos = []; this.pending = false; this.message = '未能发送，请核对订单、文字和照片后重试'
      } else this.message = '暂未确认发送结果，请重试发送；不会重复留言'
    } finally { if (this.current(generation, token)) this.sending = false }
  }
  private photoItems(paths: string[]): AfterSaleImage[] { return paths.map((path: string): AfterSaleImage => ({ imageId: path, path })) }
  private async loadPhoto(path: string): Promise<string> {
    const token = this.user.token, generation = this.generation
    const bytes = await RequestAxios.getImageForSession(path, token)
    if (!this.current(generation, token)) throw new Error('登录状态已变化')
    return 'data:image/jpeg;base64,' + new util.Base64Helper().encodeToStringSync(new Uint8Array(bytes))
  }
  build() {
    NavDestination() {
      Column() {
        HDMNavBar({ title: this.user.role === 'merchant' ? '回复客服留言' : '联系客服' })
        Scroll() {
          Column({ space: 12 }) {
            Text(this.user.role === 'merchant' ? this.buyerName : '留言后商家会在这里回复，照片仅你和商家可见。').fontColor($r('[ui_components].color.gray'))
            if (this.orderId) { Text(this.orderLabel(this.orderName, this.orderCreatedAt)).id('service-linked-order').fontColor($r('[ui_components].color.text')) }
            if (this.message) { Text(this.message).id('service-message').fontColor(this.messageColor()) }
            if (!this.user.token) { Button('登录后留言').backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary')).onClick(() => this.stackPath.pushPath({ name: PAGE_PATH.LOGIN_PAGE })) }
            Button(this.loading ? '读取中' : '刷新留言').id('service-refresh').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(!this.loading).onClick(() => this.load())
            if (this.hasMore) { Button('查看更早留言').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(!this.loading).onClick(() => this.load(true)) }
            ForEach(this.items, (item: ServiceMessage) => {
              Column({ space: 8 }) {
                Text((item.sender === 'merchant' ? '商家回复' : '买家留言') + ' · ' + formatBeijingTime(item.createdAt)).fontColor($r('[ui_components].color.gray'))
                Text(item.content).id('service-item-' + item.id).fontColor($r('[ui_components].color.text')).width('100%')
                if (item.orderId) { Text(this.orderLabel(item.orderName, item.orderCreatedAt) + ' ›').fontSize(12).fontColor($r('[ui_components].color.red')).onClick(() => this.openOrder(item.orderId || '')) }
                if (item.images.length > 0) { AfterSalePhotos({ images: this.photoItems(item.images), loadImage: path => this.loadPhoto(path) }) }
              }.padding(14).width('100%').backgroundColor($r('[ui_components].color.white')).borderRadius(10).alignItems(HorizontalAlign.Start)
            }, (item: ServiceMessage) => String(item.id))
            if (!this.loading && this.items.length === 0) { Text('还没有留言').fontColor($r('[ui_components].color.gray')) }
            TextArea({ text: this.content, placeholder: '请写下你的问题或回复（1至500字）' }).id('service-content').height(120).maxLength(1000)
              .fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.white')).enabled(!this.pending && !this.choosing).onChange(value => { this.content = value })
            ForEach(this.photos, (photo: AfterSalePhoto, index: number) => {
              Row({ space: 12 }) {
                Image('data:image/jpeg;base64,' + photo.bytes).width(72).height(72).objectFit(ImageFit.Cover)
                Button('移除照片 ' + (index + 1)).backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(!this.pending && !this.choosing).onClick(() => { this.photos = this.photos.filter((_photo: AfterSalePhoto, position: number): boolean => position !== index) })
              }
            }, (photo: AfterSalePhoto) => photo.requestKey)
            if (this.user.role !== 'merchant') { Button(this.choosing ? '读取照片中' : '选择照片（最多3张JPEG）').id('service-photo').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(!this.pending && !this.choosing && this.photos.length < 3).onClick(() => this.choosePhoto()) }
            Button(this.sending ? '发送中' : this.pending ? '重试发送' : '发送留言').id('service-send').backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary')).enabled(!this.sending && !this.choosing && !!this.user.token).onClick(() => this.send())
          }.width('100%').padding(16).alignItems(HorizontalAlign.Start)
        }.layoutWeight(1).width('100%').align(Alignment.Bottom)
      }.width('100%').height('100%').padding({ top: this.topHeight, bottom: this.bottomHeight }).backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true).onReady(context => {
      const route = context.pathInfo.param as ServiceRoute | undefined
      this.orderId = route?.orderId || ''; this.orderName = route?.orderName || ''; this.orderCreatedAt = route?.orderCreatedAt || 0; this.buyerId = route?.buyerId || ''; this.accountId = this.user.id || ''; this.active = true; void this.load()
    }).onShown(() => this.shown()).onHidden(() => this.hidden())
  }
}
