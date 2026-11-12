import { GlobalVariable } from 'constants'
import { HDMUser, formatBeijingTime } from 'models'
import { HDMNavBar } from 'ui_components'
import { RequestAxios } from 'network'

interface MerchantReview { id: string; buyerId: string; nickname: string; avatar: string; score: number; content: string; createdAt: number; hiddenReason?: string }
interface MerchantReviewPage { items: MerchantReview[]; pages: number }
interface ModerationBody { reason: string }

@Component
export struct ReviewManageView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = { account: '', nickname: '', token: '', avatar: '' }
  @State items: MerchantReview[] = []
  @State selected: MerchantReview | null = null
  @State action: string = ''
  @State reason: string = ''
  @State message: string = ''
  @State messageOk: boolean = false
  @State loading: boolean = false
  @State busy: boolean = false
  @State page: number = 1
  @State pages: number = 0
  private productId: string = ''
  private active: boolean = false
  private generation: number = 0
  private query: number = 0
  private reasons: string[] = ['广告', '辱骂', '无关内容', '泄露隐私', '其他']
  private current(generation: number, token: string): boolean { return this.active && generation === this.generation && !!token && token === this.user.token && this.user.role === 'merchant' }
  private messageColor(): ResourceColor { return this.messageOk ? $r('[ui_components].color.text') : $r('[ui_components].color.red') }
  private accountChanged(): void { this.generation++; this.query++; this.items = []; this.selected = null; this.reason = ''; this.message = ''; this.busy = false; this.loading = false; if (this.active) void this.load(1) }
  aboutToDisappear(): void { this.active = false; this.accountChanged() }
  private async load(page: number = 1): Promise<void> {
    const token = this.user.token, generation = this.generation, query = ++this.query
    if (!this.current(generation, token) || !this.productId) { this.message = '请使用商家账号查看商品评价'; return }
    this.loading = true
    try {
      const result = await RequestAxios.getForSession<MerchantReviewPage>('/merchant/goods/' + encodeURIComponent(this.productId) + '/reviews?page=' + page + '&pageSize=10', token)
      if (this.current(generation, token) && query === this.query) { this.items = result.items; this.pages = result.pages; this.page = page }
    } catch { if (this.current(generation, token) && query === this.query) this.message = '评价读取失败，请重试' }
    finally { if (this.current(generation, token) && query === this.query) this.loading = false }
  }
  private open(item: MerchantReview, action: string): void { if (this.busy) return; this.selected = item; this.action = action; this.reason = ''; this.message = '' }
  private async submit(): Promise<void> {
    const token = this.user.token, generation = this.generation, item = this.selected
    if (!item || this.busy || !this.current(generation, token)) return
    if (!this.reasons.includes(this.reason)) { this.messageOk = false; this.message = '请选择处理原因'; return }
    this.busy = true; this.message = ''; this.messageOk = false
    try {
      const path = this.action === 'avatar' ? '/merchant/members/' + encodeURIComponent(item.buyerId) + '/avatar/reset' : '/merchant/reviews/' + encodeURIComponent(item.id) + '/hide'
      await RequestAxios.postWithSession<null>(path, { reason: this.reason } as ModerationBody, token)
      if (this.current(generation, token)) { this.messageOk = true; this.message = this.action === 'avatar' ? '头像已恢复默认，买家可以重新上传' : '评价已隐藏，买家可以查看原因并修改重发'; this.selected = null; await this.load(this.page) }
    } catch { if (this.current(generation, token)) this.message = '暂未确认处理结果，请刷新查看或重试' }
    finally { if (this.current(generation, token)) this.busy = false }
  }
  build() {
    NavDestination() {
      Column() {
        HDMNavBar({ title: '商品评价处理' })
        Scroll() {
          Column({ space: 12 }) {
            Text('评价先发布；只有违规内容才隐藏，不因差评隐藏。').fontColor($r('[ui_components].color.gray'))
            if (this.message) { Text(this.message).fontColor(this.messageColor()) }
            Button(this.loading ? '读取中' : '刷新评价').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(!this.loading && !this.busy).onClick(() => this.load(this.page))
            if (this.selected) {
              Column({ space: 10 }) {
                Text(this.action === 'avatar' ? '选择重置头像的原因' : '选择隐藏评价的原因').fontColor($r('[ui_components].color.text'))
                ForEach(this.reasons, (reason: string) => {
                  Button(reason).id('moderation-reason-' + reason).backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({ width: this.reason === reason ? 2 : 0, color: $r('[ui_components].color.red') }).enabled(!this.busy).onClick(() => { this.reason = reason })
                })
                Button(this.busy ? '处理中' : '确认处理').id('moderation-submit').backgroundColor($r('[ui_components].color.red')).fontColor(Color.White).enabled(!this.busy).onClick(() => this.submit())
                Button('暂不处理').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(!this.busy).onClick(() => { this.selected = null })
              }.width('100%').padding(16).backgroundColor($r('[ui_components].color.white')).borderRadius(12)
            }
            ForEach(this.items, (item: MerchantReview) => {
              Column({ space: 10 }) {
                Text(item.nickname + ' · ' + item.score + '星').fontColor($r('[ui_components].color.text'))
                Text(formatBeijingTime(item.createdAt)).fontColor($r('[ui_components].color.gray'))
                Text(item.content).fontColor($r('[ui_components].color.text'))
                if (item.hiddenReason) { Text('已隐藏：' + item.hiddenReason).fontColor($r('[ui_components].color.red')) }
                if (!item.hiddenReason) {
                  Button('隐藏评价').id('review-hide-' + item.id).backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(!this.busy).onClick(() => this.open(item, 'hide'))
                }
                if (item.avatar) {
                  Image(item.avatar).width(48).height(48).borderRadius(24)
                  Button('重置违规头像').id('avatar-reset-' + item.id).backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(!this.busy).onClick(() => this.open(item, 'avatar'))
                }
              }.width('100%').padding(16).backgroundColor($r('[ui_components].color.white')).borderRadius(12).alignItems(HorizontalAlign.Start)
            }, (item: MerchantReview) => item.id + ':' + (item.hiddenReason || ''))
            if (!this.loading && this.items.length === 0) { Text('暂无评价').fontColor($r('[ui_components].color.gray')) }
            Row({ space: 12 }) {
              Button('上一页').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(this.page > 1 && !this.loading && !this.busy).onClick(() => this.load(this.page - 1))
              Text(this.page + ' / ' + Math.max(1, this.pages)).fontColor($r('[ui_components].color.text'))
              Button('下一页').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(this.page < this.pages && !this.loading && !this.busy).onClick(() => this.load(this.page + 1))
            }
          }.width('100%').padding(16)
        }.layoutWeight(1).width('100%').align(Alignment.Top)
      }.width('100%').height('100%').padding({ top: this.safeTop, bottom: this.safeBottom }).backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true).onReady(context => { this.productId = context.pathInfo.param as string || ''; this.active = true; void this.load() })
      .onShown(() => { if (!this.active) { this.active = true; void this.load(this.page) } }).onHidden(() => this.aboutToDisappear())
  }
}
