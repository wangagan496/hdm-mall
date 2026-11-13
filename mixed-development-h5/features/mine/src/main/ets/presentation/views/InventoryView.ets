import { GlobalVariable } from 'constants'
import { HDMUser } from 'models'
import { HDMNavBar } from 'ui_components'
import { RequestAxios } from 'network'
import { InventoryItem, InventoryPage, StockAdjustmentDraft, StockAdjustmentReceipt } from '../../data/api/inventory'
import { inventoryAdjustment } from '../utils/InventoryAdjustment'

@Builder
function InventoryViewBuilder() { InventoryView() }

@Component
export struct InventoryView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged')
  user: HDMUser = { account: '', nickname: '', token: '', avatar: '' }
  @StorageProp(GlobalVariable.APP_FOREGROUND_SEQUENCE) @Watch('refreshAfterForeground') foregroundSequence: number = 0
  @State items: InventoryItem[] = []
  @State page: number = 1
  @State pages: number = 0
  @State loading: boolean = false
  @State submitting: boolean = false
  @State message: string = ''
  @State loadError: string = ''
  @State pendingError: string = ''
  @State ready: boolean = false
  @State pending: StockAdjustmentDraft | null = null
  @State selected: InventoryItem | null = null
  @State quantity: string = ''
  @State reason: string = ''
  @State reasonCategory: string = ''
  @State increase: boolean = true
  private active: boolean = false
  private queryId: number = 0
  private generation: number = 0
  private dialogSequence: number = 0
  private sessionToken: string = ''
  private sessionUserId: string = ''
  private sessionRole: string = ''
  private scroller: Scroller = new Scroller()
  private recoveryTimer: number = -1
  private recoveryAttempts: number = 0
  @State recoveryExhausted: boolean = false

  aboutToAppear(): void { this.active = true; this.load(this.page) }
  aboutToDisappear(): void {
    this.stopRecovery()
    this.active = false; this.queryId++; this.generation++; this.dialogSequence++
    this.ready = false; this.loading = false; this.submitting = false
  }
  private showInventory(): void { if (!this.active) this.aboutToAppear() }
  private refreshAfterForeground(): void { if (this.active && !this.submitting) this.load(this.page) }

  private accountChanged(): void {
    if (this.synchronizeSession() && this.active) this.load(1)
  }

  private synchronizeSession(): boolean {
    const token: string = this.user.token || '', userId: string = this.user.id || '', role: string = this.user.role || ''
    if (token === this.sessionToken && userId === this.sessionUserId && role === this.sessionRole) return false
    this.sessionToken = token; this.sessionUserId = userId; this.sessionRole = role
    this.stopRecovery()
    this.queryId++; this.generation++; this.dialogSequence++
    this.items = []; this.selected = null; this.quantity = ''; this.reason = ''; this.pending = null
    this.reasonCategory = ''
    this.page = 1; this.pages = 0; this.message = ''; this.loading = false; this.submitting = false
    this.ready = false; this.loadError = ''; this.pendingError = ''; this.increase = true
    return true
  }

  private isCurrent(generation: number, token: string): boolean {
    return this.active && generation === this.generation && !!token && token === this.sessionToken &&
      token === this.user.token && !!this.sessionUserId && this.sessionUserId === this.user.id &&
      this.sessionRole === 'merchant' && this.user.role === 'merchant'
  }

  private canAdjust(): boolean {
    return this.isCurrent(this.generation, this.sessionToken) && this.ready && !this.loading &&
      !this.submitting && !this.pending && !this.pendingError
  }

  private readPending(): void {
    this.pendingError = ''
    try { this.pending = inventoryAdjustment.pending(this.sessionUserId) }
    catch { this.pending = null; this.pendingError = '本地待确认记录异常，请核查库存记录' }
  }

  private async load(page: number, confirmedMessage: string = ''): Promise<void> {
    if (this.synchronizeSession()) page = 1
    const token: string = this.sessionToken, generation: number = this.generation
    if (!this.isCurrent(generation, token)) {
      if (this.active) this.message = '请使用商家账号登录'
      return
    }
    const query: number = ++this.queryId
    this.dialogSequence++; this.ready = false; this.loading = true; this.loadError = ''
    if (!this.submitting) { this.message = ''; this.readPending() }
    try {
      const result = await RequestAxios.getForSession<InventoryPage>('/merchant/inventory?page=' + page + '&pageSize=10', token)
      if (!this.isCurrent(generation, token) || query !== this.queryId) return
      this.items = result.items; this.page = result.page; this.pages = result.pages
      this.ready = true
      if (this.selected && !this.pending && !this.submitting) {
        const skuId = this.selected.skuId
        this.selected = result.items.find(item => item.skuId === skuId) || null
      }
    } catch {
      if (this.isCurrent(generation, token) && query === this.queryId) {
        this.loadError = confirmedMessage ? '列表刷新失败，请刷新库存' : '库存读取失败，请重试刷新'
      }
    } finally {
      if (this.isCurrent(generation, token) && query === this.queryId) this.loading = false
    }
    if (this.isCurrent(generation, token) && query === this.queryId && !confirmedMessage &&
      this.pending && !this.pendingError && !this.submitting && this.recoveryAttempts === 0) await this.submit()
  }

  private stopRecovery(): void {
    if (this.recoveryTimer !== -1) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = -1
    this.recoveryAttempts = 0
    this.recoveryExhausted = false
  }

  private scheduleRecovery(generation: number, token: string): void {
    if (!this.pending || this.pendingError || this.recoveryTimer !== -1 || !this.isCurrent(generation, token)) return
    const delays: number[] = [1000, 3000, 8000]
    if (this.recoveryAttempts >= delays.length) { this.recoveryExhausted = true; return }
    this.recoveryTimer = setTimeout(() => {
      if (!this.isCurrent(generation, token)) return
      this.recoveryTimer = -1
      void this.submit()
    }, delays[this.recoveryAttempts++])
  }

  private select(item: InventoryItem): void {
    if (!this.canAdjust()) return
    const current: InventoryItem | undefined = this.items.find(value => value.skuId === item.skuId)
    if (!current || current.difference !== 0) return
    this.dialogSequence++
    this.selected = current; this.quantity = ''; this.reason = ''; this.increase = true; this.message = ''
    this.reasonCategory = ''
  }

  private chooseReason(category: string): void {
    if (!this.canAdjust()) return
    this.dialogSequence++
    this.reasonCategory = category
    if (category === '补货') this.reason = '商品补货入库'
    else if (category === '盘点更正') this.reason = '库存盘点更正'
    else if (category === '损耗') this.reason = '商品损耗调整'
    else this.reason = ''
  }

  private cancelEdit(): void { this.dialogSequence++; this.selected = null }

  private canSubmitItem(item: InventoryItem, delta: number, reason: string): boolean {
    const current: InventoryItem | undefined = this.items.find(value => value.skuId === item.skuId)
    return this.canAdjust() && !!current && current.difference === 0 && current.stock === item.stock &&
      Number.isInteger(delta) && delta !== 0 && Math.abs(delta) <= 1000000 &&
      current.stock + delta >= 0 && current.stock + delta <= 2147483647 &&
      reason.trim().length >= 5 && reason.trim().length <= 200
  }

  private valid(): boolean {
    const count = Number(this.quantity)
    return !!this.selected && this.reasonCategory.length > 0 && /^\d+$/.test(this.quantity) && count > 0 &&
      this.canSubmitItem(this.selected, count * (this.increase ? 1 : -1), this.reason)
  }

  private confirmAdjustment(): void {
    const item = this.selected
    if (!item || this.pending || this.submitting || !this.valid()) return
    const delta = Number(this.quantity) * (this.increase ? 1 : -1)
    const reason: string = this.reason.trim(), token: string = this.sessionToken
    const generation: number = this.generation, query: number = this.queryId, dialog: number = ++this.dialogSequence
    const skuId: string = item.skuId, stock: number = item.stock
    this.getUIContext().showAlertDialog({ title: '确认调整库存',
      message: item.name + ' · ' + item.spec + '\n' + item.stock + ' → ' + (item.stock + delta) + '\n原因：' + reason,
      primaryButton: { value: '取消', action: () => { if (dialog === this.dialogSequence) this.dialogSequence++ } },
      secondaryButton: { value: '确认调整', action: () => {
        if (dialog !== this.dialogSequence || query !== this.queryId || !this.isCurrent(generation, token) ||
          !this.valid() || this.selected?.skuId !== skuId || this.selected.stock !== stock ||
          Number(this.quantity) * (this.increase ? 1 : -1) !== delta || this.reason.trim() !== reason) return
        this.dialogSequence++
        this.submit(item, delta, reason)
      } }
    })
  }

  private async submit(item?: InventoryItem, delta: number = 0, reason: string = ''): Promise<void> {
    const token: string = this.sessionToken, generation: number = this.generation
    if (this.submitting || !this.isCurrent(generation, token)) return
    if (item) {
      if (!this.canSubmitItem(item, delta, reason)) return
    } else {
      this.readPending()
      if (!this.pending || this.pendingError) return
    }
    this.dialogSequence++
    this.submitting = true; this.message = ''
    try {
      const receipt: StockAdjustmentReceipt = item ?
        await inventoryAdjustment.start(item.skuId, delta, item.stock, reason, token) : await inventoryAdjustment.resume(token)
      if (!this.isCurrent(generation, token)) return
      this.selected = null; this.quantity = ''; this.reason = ''
      this.message = '调整已记录，本次调整后库存为 ' + receipt.balance
      this.readPending()
      this.stopRecovery()
      await this.load(this.page, this.message)
    } catch (error) {
      if (this.isCurrent(generation, token)) {
        this.queryId++; this.ready = false; this.loading = false
        this.readPending()
        this.message = this.pending ? '正在确认库存调整结果' : '调整未完成，请刷新库存后核对再提交'
      }
    } finally {
      if (this.isCurrent(generation, token)) {
        this.submitting = false
        this.scheduleRecovery(generation, token)
      }
    }
  }

  @Builder
  private AdjustmentEditor() {
    if (this.selected) {
      Text('调整：' + this.selected.name + ' · ' + this.selected.spec).fontSize(18).fontColor($r('[ui_components].color.text'))
      Text('当前可售库存：' + this.selected.stock).fontSize(14).fontColor($r('[ui_components].color.text'))
      Row({ space: 12 }) {
        Button(this.increase ? '增加库存 ✓' : '增加库存').enabled(this.canAdjust()).onClick(() => this.increase = true)
        Button(this.increase ? '减少库存' : '减少库存 ✓').enabled(this.canAdjust()).onClick(() => this.increase = false)
      }
      TextInput({ placeholder: '调整数量（正整数）', text: $$this.quantity }).type(InputType.Number).maxLength(7).enabled(this.canAdjust())
      Text('请选择调整原因').fontSize(14)
      Flex({ wrap: FlexWrap.Wrap }) {
        ForEach(['补货', '盘点更正', '损耗', '其他'], (category: string) => {
          Button(category + (this.reasonCategory === category ? ' ✓' : ''))
            .margin(4).enabled(this.canAdjust()).onClick(() => this.chooseReason(category))
        })
      }
      if (this.reasonCategory === '其他') {
        TextArea({ placeholder: '补充说明，至少5个字', text: $$this.reason }).maxLength(200).height(90).enabled(this.canAdjust())
      } else if (this.reason) { Text(this.reason).fontSize(14) }
      Button(this.submitting ? '正在确认…' : '提交库存调整').enabled(!this.submitting && this.valid()).onClick(() => this.confirmAdjustment())
      Button('取消编辑').enabled(!this.submitting).onClick(() => this.cancelEdit())
    }
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({ title: '库存管理', onLeftClick: () => this.stackPath.pop() })
        Scroll(this.scroller) {
          Column({ space: 12 }) {
            if (this.message) { Text(this.message).fontSize(14).fontColor($r('[ui_components].color.red')).width('100%') }
            if (this.loadError) { Text(this.loadError).fontSize(14).fontColor($r('[ui_components].color.red')).width('100%') }
            if (this.pendingError) { Text(this.pendingError).fontSize(14).fontColor($r('[ui_components].color.red')).width('100%') }
            if (this.user.role === 'merchant') {
              Button(this.loading ? '读取中…' : '刷新库存').enabled(!this.loading && !this.submitting).onClick(() => this.load(this.page))
              if (this.pending) {
                Text('正在确认库存调整结果').fontSize(18).fontColor($r('[ui_components].color.text'))
                Text('数量变化：' + this.pending.delta + '\n原因：' + this.pending.reason).fontSize(14).fontColor($r('[ui_components].color.text'))
                if (this.recoveryExhausted || this.pendingError) {
                  Button('确认调整结果').enabled(!this.submitting && !this.pendingError).onClick(() => this.submit())
                }
              }
              if (!this.loading && !this.loadError && this.ready && this.items.length === 0) { Text('暂无库存记录').fontSize(14).fontColor($r('[ui_components].color.text')) }
              ForEach(this.items, (item: InventoryItem) => {
                Column({ space: 8 }) {
                  Text(item.name + ' · ' + item.spec).fontSize(18).fontColor($r('[ui_components].color.text'))
                  Text('可售库存：' + item.stock).fontSize(16).fontColor($r('[ui_components].color.text'))
                  if (item.difference !== 0) { Text('库存与流水差异：' + item.difference + '，请先核查记录').fontColor($r('[ui_components].color.red')) }
                  Button('调整库存').enabled(this.canAdjust() && item.difference === 0).onClick(() => this.select(item))
                  if (this.selected?.skuId === item.skuId && !this.pending) { this.AdjustmentEditor() }
                }.width('100%').padding(16).backgroundColor($r('[ui_components].color.white')).borderRadius(12).alignItems(HorizontalAlign.Start)
              // 接口返回普通对象；数据变化时重建该行，更新显示和按钮捕获的库存基准。
              }, (item: InventoryItem) => JSON.stringify(item))
              Row({ space: 16 }) {
                Button('上一页').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).enabled(this.page > 1 && !this.loading && !this.submitting).onClick(() => this.load(this.page - 1))
                Text(this.page + ' / ' + Math.max(1, this.pages)).fontColor($r('[ui_components].color.text'))
                Button('下一页').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).enabled(this.page < this.pages && !this.loading && !this.submitting).onClick(() => this.load(this.page + 1))
              }
            }
          }.width('100%').padding(16).alignItems(HorizontalAlign.Start)
        }.layoutWeight(1).width('100%')
      }.width('100%').height('100%').padding({ top: this.safeTop, bottom: this.safeBottom }).backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true)
    .onShown(() => this.showInventory())
    .onHidden(() => this.aboutToDisappear())
  }
}
