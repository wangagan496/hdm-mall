import { GlobalVariable } from 'constants'
import { HDMUser, ReviewField } from 'models'
import { HDMNavBar } from 'ui_components'
import { RequestAxios } from 'network'

interface ReviewMember {nickname:string}
interface MerchantReview {
  id:string; member:ReviewMember; score:number; logisticsScore?:number; serviceScore?:number; serviceOccurred:boolean
  content:string; reply?:string; items:ReviewField[]
}
interface MerchantReviewPage { items: MerchantReview[]; pages: number }
interface ReplyBody { content: string }

@Component
export struct ReviewManageView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = { account: '', nickname: '', token: '', avatar: '' }
  @State items: MerchantReview[] = []
  @State selected: MerchantReview | null = null
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
  private current(generation: number, token: string): boolean { return this.active && generation === this.generation && !!token && token === this.user.token && this.user.identity === 'merchant' }
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
  private open(item: MerchantReview): void { if (this.busy) return; this.selected = item; this.reason = ''; this.message = '' }
  private async submit(): Promise<void> {
    const token = this.user.token, generation = this.generation, item = this.selected
    if (!item || this.busy || !this.current(generation, token)) return
    if (!this.reason.trim()) { this.messageOk = false; this.message = '请填写公开回复'; return }
    this.busy = true; this.message = ''; this.messageOk = false
    try {
      const path='/merchant/reviews/'+encodeURIComponent(item.id)+'/reply'
      await RequestAxios.postWithSession<ReplyBody>(path,{content:this.reason.trim()} as ReplyBody,token)
      if (this.current(generation, token)) { this.messageOk=true;this.message='公开回复已发布';this.selected=null;await this.load(this.page) }
    } catch { if (this.current(generation, token)) this.message = '回复未确认，请刷新查看；回复不得以补偿换删评' }
    finally { if (this.current(generation, token)) this.busy = false }
  }
  build() {
    NavDestination() {
      Column() {
        HDMNavBar({ title: '商品评价' })
        Scroll() {
          Column({ space: 12 }) {
            if (this.message) { Text(this.message).fontColor(this.messageColor()) }
            Button(this.loading ? '读取中' : '刷新评价').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(!this.loading && !this.busy).onClick(() => this.load(this.page))
            if (this.selected) {
              Column({ space: 10 }) {
                Text(this.selected.content).fontColor($r('[ui_components].color.text'))
                TextArea({text:this.reason,placeholder:'公开回复买家评价'}).maxLength(500).onChange((v:string)=>{this.reason=v})
                Button(this.busy?'发布中':'发布回复').enabled(!this.busy).onClick(()=>this.submit())
                Button('取消').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(!this.busy).onClick(() => { this.selected = null })
              }.width('100%').padding(16).backgroundColor($r('[ui_components].color.white')).borderRadius(12)
            }
            ForEach(this.items, (item: MerchantReview) => {
              Column({ space: 10 }) {
                Text(item.member.nickname+' · 商品 '+item.score+'分'+(item.score===3?'（中评）':'')).fontColor($r('[ui_components].color.text'))
                Text('物流 '+(item.logisticsScore?item.logisticsScore+'分':'未评分')+' · 售后 '+(item.serviceScore?item.serviceScore+'分':item.serviceOccurred?'未评分':'未发生')).fontColor($r('[ui_components].color.gray'))
                Text(item.content).fontColor($r('[ui_components].color.text'))
                ForEach(item.items,(field:ReviewField)=>{
                  Text(field.label+' · '+(field.result==='matches'?'符合':field.result==='mismatch'?'不符':'没注意')+(field.note?' · '+field.note:'')).fontColor($r('[ui_components].color.text'))
                })
                if(item.reply){Text('商家回复：'+item.reply).fontColor($r('[ui_components].color.text'))}
                else{Button('公开回复').enabled(!this.busy).onClick(()=>this.open(item))}
              }.width('100%').padding(16).backgroundColor($r('[ui_components].color.white')).borderRadius(12).alignItems(HorizontalAlign.Start)
            }, (item: MerchantReview) => item.id + ':' + (item.reply || ''))
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
