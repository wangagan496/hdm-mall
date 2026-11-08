import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMUser } from 'models'
import { HDMNavBar } from 'ui_components'
import { RequestAxios } from 'network'
import { ProductData, ProductPage, ProductError, ProductNotice } from '../../data/api/products'
import { productSave } from '../utils/ProductSave'

@Builder
function ProductManageViewBuilder() { ProductManageView() }

@Component
export struct ProductManageView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = { account: '', nickname: '', token: '', avatar: '' }
  @State items: ProductData[] = []
  @State page: number = 1
  @State pages: number = 0
  @State filter: string = ''
  @State loading: boolean = false
  @State busy: string[] = []
  @State message: string = ''
  @State messageKind: 'normal' | 'warning' = 'normal'
  private active: boolean = false
  private token: string = ''
  private accountId: string = ''
  private generation: number = 0
  private query: number = 0

  private setMessage(text: string, kind: 'normal' | 'warning'): void { this.message = text; this.messageKind = kind }
  private messageColor(): ResourceColor { return this.messageKind === 'warning' ? $r('[ui_components].color.red') : $r('[ui_components].color.text') }

  private synchronize(): void {
    if (this.token === (this.user.token || '') && this.accountId === (this.user.id || '')) return
    this.token = this.user.token || ''; this.accountId = this.user.id || ''; this.generation++; this.query++
    this.items = []; this.page = 1; this.pages = 0; this.busy = []; this.setMessage('', 'normal'); this.loading = false
  }
  private current(generation: number, token: string): boolean {
    return this.active && generation === this.generation && !!token && token === this.user.token && token === this.token &&
      !!this.accountId && this.accountId === this.user.id && this.user.role === 'merchant'
  }
  private accountChanged(): void { this.synchronize(); if (this.active) void this.load(1) }
  aboutToAppear(): void { this.active = true; void this.load(1) }
  aboutToDisappear(): void { this.active = false; this.generation++; this.query++; this.loading = false }
  private shown(): void { if (!this.active) { this.active = true; void this.load(this.page) } }
  private async load(page: number, saved: string = '', kind: 'normal' | 'warning' = 'normal'): Promise<void> {
    this.synchronize()
    const generation = this.generation, token = this.token, query = ++this.query
    if (!this.current(generation, token)) { this.setMessage('请使用商家账号登录', 'warning'); return }
    this.loading = true
    try {
      const result = await RequestAxios.getForSession<ProductPage>('/merchant/products?page=' + page + '&pageSize=10' + (this.filter ? '&status=' + this.filter : ''), token)
      if (!this.current(generation, token) || query !== this.query) return
      this.items = result.items; this.page = result.page; this.pages = result.pages; this.setMessage(saved, kind)
    } catch {
      if (this.current(generation, token) && query === this.query) this.setMessage(saved && kind === 'normal' ? '商品已保存，列表暂未刷新' : '商品读取失败，请重试', 'warning')
    } finally { if (this.current(generation, token) && query === this.query) this.loading = false }
  }
  private edit(id: string): void {
    if (!this.current(this.generation, this.token)) return
    this.stackPath.pushPath({ name: PAGE_PATH.PRODUCT_EDIT_PAGE, param: id,
      onPop: info => { const saved = info.result as ProductNotice | undefined; this.active = true; void this.load(this.page, saved?.text || '', saved?.kind || 'normal') } })
  }
  private status(item: ProductData): string { return item.status === 'off' ? '已下架' : item.skus.some(sku => sku.enabled) ? '在售' : '无可售规格' }
  private price(item: ProductData): string {
    const prices = item.skus.filter(sku => sku.enabled).map(sku => sku.priceCents)
    if (!prices.length) return '暂无可购买规格'
    const min = Math.min(...prices), max = Math.max(...prices)
    return '¥' + (min / 100).toFixed(2) + (min === max ? '' : ' ～ ¥' + (max / 100).toFixed(2))
  }
  private stock(item: ProductData): number { return item.skus.filter(sku => sku.enabled).reduce((sum: number, sku) => sum + sku.stock, 0) }
  private hasPending(id: string): boolean { try { return productSave.pending(this.accountId, id) !== null } catch { return true } }
  private async toggle(item: ProductData): Promise<void> {
    const generation = this.generation, token = this.token
    if (!this.current(generation, token) || this.busy.includes(item.id)) return
    if (this.hasPending(item.id)) { this.edit(item.id); return }
    this.busy = this.busy.concat(item.id)
    try {
      const result = await productSave.start(item.id, { status: item.status === 'off' ? 'on' : 'off' }, '', token)
      if (!this.current(generation, token)) return
      this.items = this.items.map(value => value.id === result.id ? result : value)
      await this.load(this.page, result.status === 'off' ? '已下架，买家暂时看不到' : '已重新上架')
    } catch (error) {
      if (this.current(generation, token)) {
        const failure = error as ProductError
        if (failure.response?.data?.reason === 'PRODUCT_REVISION_CHANGED') await this.load(this.page, '商品刚被修改，已刷新，请核对后重试', 'warning')
        else if (this.hasPending(item.id)) this.edit(item.id)
        else this.setMessage('状态修改未完成，请重试', 'warning')
      }
    } finally { if (this.current(generation, token)) this.busy = this.busy.filter(id => id !== item.id) }
  }
  build() {
    NavDestination() {
      Column() {
        HDMNavBar({ title: '商品管理' })
        Scroll() {
          Column({ space: 12 }) {
            Button('新建商品').onClick(() => this.edit(''))
            Row({ space: 8 }) {
              Button('全部').onClick(() => { this.filter = ''; void this.load(1) })
              Button('在售').onClick(() => { this.filter = 'on'; void this.load(1) })
              Button('已下架').onClick(() => { this.filter = 'off'; void this.load(1) })
            }
            if (this.message) { Text(this.message).id('product-manage-message').fontColor(this.messageColor()) }
            Button(this.loading ? '正在读取' : '刷新').enabled(!this.loading).onClick(() => this.load(this.page))
            ForEach(this.items, (item: ProductData) => {
              Column({ space: 8 }) {
                Row({ space: 12 }) {
                  Image(item.picture).width(72).height(72).objectFit(ImageFit.Contain)
                  Column({ space: 6 }) { Text(item.name).fontSize(18).fontColor($r('[ui_components].color.black')); Text(this.price(item)).fontColor($r('[ui_components].color.text')); Text('库存：' + this.stock(item) + ' · ' + this.status(item)).fontColor($r('[ui_components].color.text')) }.alignItems(HorizontalAlign.Start).layoutWeight(1)
                }
                Row({ space: 12 }) {
                  Button('编辑').id('product-edit-' + item.id).onClick(() => this.edit(item.id))
                  Button(this.hasPending(item.id) ? '确认保存结果' : item.status === 'off' ? '上架' : '下架').id('product-toggle-' + item.id).enabled(!this.busy.includes(item.id)).onClick(() => this.toggle(item))
                }
              }.padding(16).width('100%').backgroundColor($r('[ui_components].color.white')).borderRadius(12)
            }, (item: ProductData) => item.id + ':' + item.revision)
            Row({ space: 12 }) {
              Button('上一页').enabled(this.page > 1 && !this.loading).onClick(() => this.load(this.page - 1))
              Text(this.page + ' / ' + Math.max(1, this.pages)).fontColor($r('[ui_components].color.text'))
              Button('下一页').enabled(this.page < this.pages && !this.loading).onClick(() => this.load(this.page + 1))
            }
          }.padding(16).width('100%')
        }.align(Alignment.Top).layoutWeight(1).width('100%')
      }.padding({ top: this.safeTop }).width('100%').height('100%').backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true).onShown(() => this.shown()).onHidden(() => this.aboutToDisappear())
  }
}
