import { util } from '@kit.ArkTS'
import { GlobalVariable } from 'constants'
import { HDMUser, ProductMaterials, SourceRecord, sameIdentitySession, parseProductMaterials } from 'models'
import { pickMaterialJpeg, HDMNavBar, materialDate, materialKindLabel, verificationLabel, availabilityLabel } from 'ui_components'
import { RequestAxios } from 'network'

interface ProductSourceBatchUpdate { batch: string }

@Builder
function ProductMaterialsViewBuilder() { ProductMaterialsView() }

@Component
export struct ProductMaterialsView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = {} as HDMUser
  @State rows: ProductMaterials | null = null
  @State batch: string = ''
  @State kind: string = 'inspection-report'
  @State from: string = new Date().toISOString().slice(0, 10)
  @State through: string = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10)
  @State summary: string = ''
  @State busy: boolean = false
  @State message: string = ''
  @State original: string = ''
  private productId: string = ''
  private active: boolean = true
  private generation: number = 0
  private session: HDMUser | null = null

  private root(): string { return '/merchant/products/' + encodeURIComponent(this.productId) }
  private current(generation: number, session: HDMUser): boolean {
    return this.active && generation === this.generation && this.user.id === session.id &&
      this.user.identity === 'merchant' && sameIdentitySession(this.user, session)
  }
  private accountChanged(): void { this.reset(); if (this.active) void this.load() }
  private reset(): void { this.generation++; this.session = null; this.rows = null; this.original = ''; this.busy = false }
  private async load(): Promise<void> {
    if (!this.active || !this.productId || this.busy) return
    const session = this.user, generation = ++this.generation
    this.session = session
    if (!session.id || session.identity !== 'merchant') { this.message = '请切换为店主身份后管理来源材料'; return }
    this.busy = true
    try {
      const raw = await RequestAxios.getForSession<Object>(this.root() + '/source-materials', session.token)
      if (!this.current(generation, session)) return
      const result = parseProductMaterials(JSON.stringify(raw))
      if (!result) throw new Error('材料记录读取失败')
      this.rows = result
      this.batch = result.batch || this.batch
      this.message = ''
    } catch { if (this.current(generation, session)) this.message = '材料记录暂时无法读取，请刷新重试' }
    finally { if (this.current(generation, session)) this.busy = false }
  }
  private async saveBatch(): Promise<void> {
    const session = this.session
    if (this.busy || !session || !this.current(this.generation, session) || !this.batch.trim()) return
    const generation = this.generation
    this.busy = true
    try {
      const update: ProductSourceBatchUpdate = { batch: this.batch.trim() }
      await RequestAxios.putForSession<Object>(this.root() + '/source-batch', update, session.token)
      if (this.current(generation, session)) { this.message = '商品批次已保存'; await this.loadAfterBusy(generation, session) }
    } catch { if (this.current(generation, session)) this.message = '批次未保存，请检查批次后重试' }
    finally { if (this.current(generation, session)) this.busy = false }
  }
  private async loadAfterBusy(generation: number, session: HDMUser): Promise<void> {
    this.busy = false
    if (this.current(generation, session)) await this.load()
  }
  private async upload(): Promise<void> {
    const session = this.session
    if (!session || this.busy || !this.current(this.generation, session)) return
    if (!this.batch.trim() || !this.summary.trim()) { this.message = '请先保存批次并填写公开摘要'; return }
    const generation = this.generation
    this.busy = true
    this.message = ''
    try {
      const bytes = await pickMaterialJpeg()
      if (!this.current(generation, session) || !bytes) return
      const metadata = JSON.stringify({ requestKey: util.generateRandomUUID(), kind: this.kind,
        batch: this.batch.trim(), previousVersion: this.rows?.materials.filter(row => row.kind === this.kind &&
          row.batch === this.batch.trim()).reduce((max: number, row: SourceRecord) => Math.max(max, row.version), 0) || 0,
        validFrom: this.from, validThrough: this.through, summary: this.summary })
      await RequestAxios.postSourceMaterialForSession<Object>(this.root() + '/source-materials', bytes, metadata, session.token)
      if (this.current(generation, session)) { this.message = '材料照片已上传，发布承诺前仍需逐条确认'; await this.loadAfterBusy(generation, session) }
    } catch { if (this.current(generation, session)) this.message = '材料未上传，请检查图片、日期和批次后重试' }
    finally { if (this.current(generation, session)) this.busy = false }
  }
  private async withdraw(row: SourceRecord): Promise<void> {
    const session = this.session
    if (!session || this.busy || !this.current(this.generation, session)) return
    const generation = this.generation
    this.busy = true
    try {
      await RequestAxios.deleteForSession<Object>(this.root() + '/source-materials/' + encodeURIComponent(row.materialId), session.token)
      if (this.current(generation, session)) { this.message = '材料已撤销，已有订单仍保留原状态'; await this.loadAfterBusy(generation, session) }
    } catch { if (this.current(generation, session)) this.message = '材料暂未撤销，请刷新重试' }
    finally { if (this.current(generation, session)) this.busy = false }
  }
  private async showOriginal(row: SourceRecord): Promise<void> {
    const session = this.session
    if (!session || !this.current(this.generation, session)) return
    try {
      const data = await RequestAxios.getSourceMaterialForSession(this.productId, row.materialId, session.token)
      if (this.current(this.generation, session)) {
        this.original = 'data:image/jpeg;base64,' + new util.Base64Helper().encodeToStringSync(new Uint8Array(data))
      }
    } catch { if (this.current(this.generation, session)) this.message = '材料原件暂时无法读取' }
  }
  aboutToDisappear(): void { this.active = false; this.reset() }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({ title: '来源材料', onLeftClick: () => this.stackPath.pop() })
        if (this.message) Text(this.message).fontColor($r('[ui_components].color.text')).width('100%').padding(12)
        Scroll() {
          Column({ space: 12 }) {
            Column({ space: 8 }) {
              Text('商品批次').fontColor($r('[ui_components].color.text'))
              TextInput({ text: this.batch, placeholder: '填写与材料一致的商品批次' })
                .id('source-material-batch').onChange((value: string) => { this.batch = value })
              Button('保存批次').id('source-material-save-batch').enabled(!this.busy && !!this.batch.trim())
                .backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary'))
                .onClick(() => this.saveBatch())
              Text('材料照片仅供本人查看。买家看到的是你填写的公开摘要。')
                .fontColor($r('[ui_components].color.text')).width('100%')
              Text('材料类型').fontColor($r('[ui_components].color.text')).width('100%')
              Select([{ value: '批次说明' }, { value: '授权书' }, { value: '检验报告' }])
                .value(materialKindLabel(this.kind)).fontColor($r('[ui_components].color.text'))
                .selected(this.kind === 'batch-note' ? 0 : this.kind === 'authorization' ? 1 : 2)
                .onSelect((index: number) => { this.kind = index === 0 ? 'batch-note' : index === 1 ? 'authorization' : 'inspection-report' })
              Text('有效期开始').fontColor($r('[ui_components].color.text')).width('100%')
              TextInput({ text: this.from, placeholder: '有效期开始 YYYY-MM-DD' }).id('source-material-valid-from')
                .onChange((value: string) => { this.from = value })
              Text('有效期结束').fontColor($r('[ui_components].color.text')).width('100%')
              TextInput({ text: this.through, placeholder: '有效期结束 YYYY-MM-DD' }).id('source-material-valid-through')
                .onChange((value: string) => { this.through = value })
              Text('给买家看的摘要').fontColor($r('[ui_components].color.text')).width('100%')
              TextInput({ text: this.summary, placeholder: '买家可见的公开摘要' }).id('source-material-summary')
                .onChange((value: string) => { this.summary = value })
              Button(this.busy ? '处理中' : '选择照片并上传新版本').id('source-material-upload').enabled(!this.busy)
                .backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary'))
                .onClick(() => this.upload())
            }.width('100%').padding(12).backgroundColor($r('[ui_components].color.white')).borderRadius(8)
            ForEach(this.rows?.materials || [], (row: SourceRecord) => {
              Column({ space: 6 }) {
                Text(materialKindLabel(row.kind) + ' · 第 ' + row.version + ' 版').fontColor($r('[ui_components].color.text'))
                Text('批次 ' + row.batch + ' · ' + materialDate(row.validFrom) + ' 至 ' + materialDate(row.validUntil - 1))
                  .fontColor($r('[ui_components].color.text'))
                Text('商家提供 · ' + verificationLabel(row.verificationStatus) +
                  (row.availability === 'applicable' ? '' : ' · ' + availabilityLabel(row.availability)))
                  .fontColor($r('[ui_components].color.text'))
                Text('公开摘要：' + row.summary).fontColor($r('[ui_components].color.text')).width('100%')
                Row({ space: 8 }) {
                  Button('查看原件').onClick(() => this.showOriginal(row)).fontColor($r('[ui_components].color.text'))
                  Button('撤销材料').enabled(!this.busy && row.availability !== 'withdrawn')
                    .onClick(() => this.withdraw(row)).fontColor($r('[ui_components].color.red'))
                }
                if (this.original) Image(this.original).width('100%').objectFit(ImageFit.Contain)
              }.width('100%').padding(12).backgroundColor($r('[ui_components].color.white')).borderRadius(8)
            }, (row: SourceRecord) => row.materialId)
            Text('材料只作为待核对文字来源。上传成功不等于保真；本阶段材料均待核验。')
              .fontColor($r('[ui_components].color.text')).width('100%')
          }.width('100%').padding(12)
        }.layoutWeight(1).width('100%').align(Alignment.Top)
      }.width('100%').height('100%').padding({ top: this.safeTop, bottom: this.safeBottom })
        .backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true).onReady((context: NavDestinationContext) => {
      this.productId = context.pathInfo.param as string; this.active = true; void this.load()
    })
  }
}
