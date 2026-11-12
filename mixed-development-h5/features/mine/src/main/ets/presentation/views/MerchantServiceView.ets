import { GlobalVariable } from 'constants'
import { HDMUser, formatBeijingTime } from 'models'
import { HDMNavBar } from 'ui_components'
import { RequestAxios } from 'network'

interface ServiceThread { buyerId: string; buyerName: string; lastMessage: string; updatedAt: number; awaitingReply: number }
interface ServiceThreadPage { items: ServiceThread[]; pages: number }
interface ThreadRoute { buyerId: string }

@Component
export struct MerchantServiceView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = { account: '', nickname: '', token: '', avatar: '' }
  @State items: ServiceThread[] = []
  @State filter: string = 'pending'
  @State page: number = 1
  @State pages: number = 0
  @State loading: boolean = false
  @State message: string = ''
  private active: boolean = false
  private query: number = 0
  private accountChanged(): void { this.query++; this.items = []; this.page = 1; this.pages = 0; this.loading = false; this.message = ''; if (this.active) void this.load(1) }
  aboutToDisappear(): void { this.active = false; this.query++; this.items = []; this.loading = false }
  private async load(page: number): Promise<void> {
    const token = this.user.token, query = ++this.query
    if (!this.active || !token || this.user.role !== 'merchant') { this.message = '请使用商家账号查看客服留言'; return }
    this.loading = true; this.message = ''
    try {
      const result = await RequestAxios.getForSession<ServiceThreadPage>('/merchant/service?state=' + this.filter + '&page=' + page + '&pageSize=10', token)
      if (this.active && query === this.query && token === this.user.token && this.user.role === 'merchant') { this.items = result.items; this.pages = result.pages; this.page = page }
    } catch { if (this.active && query === this.query && token === this.user.token) this.message = '留言列表读取失败，请重试' }
    finally { if (query === this.query) this.loading = false }
  }
  private async changeFilter(filter: string): Promise<void> { this.filter = filter; this.items = []; this.page = 1; await this.load(1) }
  private open(item: ServiceThread): void {
    if (!this.active || this.user.role !== 'merchant') return
    this.stackPath.pushPath({ name: 'MerchantServiceThread', param: { buyerId: item.buyerId } as ThreadRoute,
      onPop: () => { this.active = true; void this.load(this.page) } })
  }
  build() {
    NavDestination() {
      Column() {
        HDMNavBar({ title: '客服留言' })
        Scroll() {
          Column({ space: 12 }) {
            Row({ space: 12 }) {
              Button('待回复').id('service-filter-pending').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({ width: this.filter === 'pending' ? 2 : 0, color: $r('[ui_components].color.red') }).onClick(() => this.changeFilter('pending'))
              Button('全部').id('service-filter-all').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({ width: this.filter === 'all' ? 2 : 0, color: $r('[ui_components].color.red') }).onClick(() => this.changeFilter('all'))
            }
            if (this.message) { Text(this.message).fontColor($r('[ui_components].color.red')) }
            Button(this.loading ? '读取中' : '刷新').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(!this.loading).onClick(() => this.load(this.page))
            ForEach(this.items, (item: ServiceThread) => {
              Column({ space: 8 }) {
                Text(item.buyerName + (item.awaitingReply ? ' · 待回复' : ' · 已回复')).fontColor($r('[ui_components].color.text'))
                Text(item.lastMessage).maxLines(3).textOverflow({ overflow: TextOverflow.Ellipsis }).fontColor($r('[ui_components].color.text'))
                Text(formatBeijingTime(item.updatedAt)).fontColor($r('[ui_components].color.gray'))
                Button('查看并回复').id('service-thread-' + item.buyerId).backgroundColor($r('[ui_components].color.red')).fontColor(Color.White).onClick(() => this.open(item))
              }.width('100%').padding(16).backgroundColor($r('[ui_components].color.white')).borderRadius(12).alignItems(HorizontalAlign.Start)
            }, (item: ServiceThread) => item.buyerId + ':' + item.updatedAt + ':' + item.awaitingReply)
            if (!this.loading && this.items.length === 0) { Text(this.filter === 'pending' ? '暂时没有待回复留言' : '还没有客服留言').fontColor($r('[ui_components].color.gray')) }
            Row({ space: 12 }) {
              Button('上一页').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(this.page > 1 && !this.loading).onClick(() => this.load(this.page - 1))
              Text(this.page + ' / ' + Math.max(1, this.pages)).fontColor($r('[ui_components].color.text'))
              Button('下一页').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(this.page < this.pages && !this.loading).onClick(() => this.load(this.page + 1))
            }
          }.width('100%').padding(16)
        }.layoutWeight(1).width('100%').align(Alignment.Top)
      }.width('100%').height('100%').padding({ top: this.safeTop, bottom: this.safeBottom }).backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true).onReady(() => { this.active = true; void this.load(1) })
      .onShown(() => { if (!this.active) { this.active = true; void this.load(this.page) } }).onHidden(() => this.aboutToDisappear())
  }
}
