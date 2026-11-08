import { GlobalVariable } from 'constants'
import { HDMUser } from 'models'
import { HDMNavBar } from 'ui_components'
import { RequestAxios } from 'network'
import { storeManager } from 'storage'
import { pickProductImage } from 'device'
import { ProductBody, ProductData, ProductDraft, ProductSku, ProductSkuPatch, ProductSkuInput, ProductCategory, ProductError, ProductNotice } from '../../data/api/products'
import { productSave } from '../utils/ProductSave'

@Builder
function ProductEditViewBuilder() { ProductEditView() }

@Component
export struct ProductEditView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = { account: '', nickname: '', token: '', avatar: '' }
  @StorageProp(GlobalVariable.APP_FOREGROUND_SEQUENCE) @Watch('foreground') foregroundSequence: number = 0
  @State productId: string = ''
  @State draft: ProductDraft = { name: '', categoryId: '', description: '', image: '', picture: '', imageId: '', status: 'on', revision: 0,
    skus: [{ spec: '标准款', price: '', stock: '0', enabled: true, originalPrice: 0 }] }
  @State categories: ProductCategory[] = []
  @State loading: boolean = false
  @State saving: boolean = false
  @State ready: boolean = false
  @State pending: boolean = false
  @State exhausted: boolean = false
  @State message: string = ''
  @State messageKind: 'normal' | 'warning' = 'normal'
  @State draftError: string = ''
  @State touched: string[] = []
  @State submitted: boolean = false
  private scroller: Scroller = new Scroller()
  private active: boolean = false
  private generation: number = 0
  private token: string = ''
  private accountId: string = ''
  private timer: number = -1
  private attempts: number = 0
  private draftWrites: Promise<void> = Promise.resolve()
  private query: number = 0

  private setMessage(text: string, kind: 'normal' | 'warning'): void { this.message = text; this.messageKind = kind }
  private messageColor(): ResourceColor { return this.messageKind === 'warning' ? $r('[ui_components].color.red') : $r('[ui_components].color.text') }

  private empty(): ProductDraft {
    return { name: '', categoryId: '', description: '', image: '', picture: '', imageId: '', status: 'on', revision: 0,
      skus: [{ spec: '标准款', price: '', stock: '0', enabled: true, originalPrice: 0 }] }
  }
  private synchronizeSession(): void {
    if (this.accountId === (this.user.id || '') && this.token === (this.user.token || '')) return
    this.stop(); this.generation++; this.query++
    this.accountId = this.user.id || ''; this.token = this.user.token || ''
    this.draft = this.empty(); this.categories = []; this.ready = false; this.pending = false
    this.saving = false; this.loading = false; this.setMessage('', 'normal'); this.draftError = ''
    this.touched = []; this.submitted = false
  }
  private current(generation: number, token: string): boolean {
    return this.active && generation === this.generation && !!token && token === this.token && token === this.user.token &&
      !!this.accountId && this.accountId === this.user.id && this.user.role === 'merchant'
  }
  private accountChanged(): void { this.synchronizeSession(); if (this.active) void this.load() }
  private foreground(): void { if (this.active && this.pending && !this.saving) void this.save() }
  aboutToDisappear(): void { this.active = false; this.generation++; this.query++; this.stop() }
  private shown(): void { if (!this.active) { this.active = true; void this.load() } }
  private stop(): void { if (this.timer !== -1) clearTimeout(this.timer); this.timer = -1; this.attempts = 0; this.exhausted = false }
  private draftKey(): string { return 'product-draft:' + this.accountId + ':' + (this.productId || 'new') }
  private fromProduct(product: ProductData): ProductDraft {
    return { name: product.name, categoryId: product.categoryId, description: product.description, image: '', picture: product.picture,
      imageId: product.imageId, status: product.status, revision: product.revision, base: product,
      skus: product.skus.map((sku: ProductSku): ProductSkuInput => { return { id: sku.id, spec: sku.spec, price: (sku.priceCents / 100).toFixed(2), stock: String(sku.stock), enabled: sku.enabled, originalPrice: sku.priceCents } }) }
  }
  private async load(): Promise<void> {
    this.synchronizeSession()
    const generation = this.generation, token = this.token, query = ++this.query
    if (!this.current(generation, token)) { this.setMessage('请使用商家账号登录', 'warning'); return }
    this.loading = true; this.ready = false; this.setMessage('', 'normal')
    try {
      const categories = await RequestAxios.getForSession<ProductCategory[]>('/merchant/products/categories', token)
      if (!this.current(generation, token) || query !== this.query) return
      this.categories = categories
      this.touched = []; this.submitted = false
      const raw = storeManager.getStore().getSync(this.draftKey(), '') as string
      if (raw) {
        const saved = JSON.parse(raw) as ProductDraft
        if (!Array.isArray(saved.skus) || saved.skus.length === 0) throw new Error('invalid draft')
        this.draft = saved
        this.restoreTouched()
        this.setMessage('已恢复上次输入', 'normal')
      } else if (this.productId) {
        const product = await RequestAxios.getForSession<ProductData>('/merchant/products/' + encodeURIComponent(this.productId), token)
        if (!this.current(generation, token) || query !== this.query) return
        this.draft = this.fromProduct(product)
      } else this.draft = this.empty()
      if (!this.productId && !this.draft.categoryId && categories.length === 1) this.draft.categoryId = categories[0].id
      this.pending = productSave.pending(this.accountId, this.productId) !== null
      this.ready = true
    } catch { if (this.current(generation, token)) this.setMessage('商品或草稿读取失败，输入已保留，请重试', 'warning') }
    finally { if (this.current(generation, token) && query === this.query) this.loading = false }
    if (this.current(generation, token) && this.pending && !this.saving) await this.save()
  }
  private persist(value: string): Promise<void> {
    const key = this.draftKey(), generation = this.generation, token = this.token
    const task = this.draftWrites.catch(() => {}).then(async () => {
      const store = storeManager.getStore(), before = store.getSync(key, '') as string
      store.putSync(key, value)
      try { await store.flush() } catch { store.putSync(key, before); throw new Error('draft flush') }
    })
    this.draftWrites = task
    task.then(() => { if (this.current(generation, token)) this.draftError = '' }).catch(() => {
      if (this.current(generation, token)) this.draftError = '本地草稿保存失败，请保留此页并重试保存'
    })
    return task
  }
  private changed(): void {
    this.draft = JSON.parse(JSON.stringify(this.draft)) as ProductDraft
    void this.persist(JSON.stringify(this.draft)).catch(() => {})
  }
  private nameError(): string { return this.draft.name.trim().length < 1 || this.draft.name.trim().length > 100 ? '名称请填写1到100个字' : '' }
  private priceError(sku: ProductSkuInput): string {
    return !/^\d+(\.\d{1,2})?$/.test(sku.price) || Number(sku.price) <= 0 || Number(sku.price) > 1000000 ? '价格须大于0，最多保留两位小数' : ''
  }
  private stockError(sku: ProductSkuInput): string { return !/^\d+$/.test(sku.stock) || Number(sku.stock) > 2147483647 ? '库存请填写0以上的整数' : '' }
  private specError(sku: ProductSkuInput): string {
    if (!sku.spec.trim() || sku.spec.trim().length > 60) return '规格名称请填写1到60个字'
    if (sku.enabled && this.draft.skus.filter(value => value.enabled && value.spec.trim() === sku.spec.trim()).length > 1) return '启用的规格名称不能重复'
    return ''
  }
  private valid(): boolean {
    return !this.nameError() && !!this.draft.categoryId && this.draft.description.length <= 2000 &&
      this.draft.skus.length > 0 && this.draft.skus.every(sku => !this.specError(sku) && !this.priceError(sku) && !this.stockError(sku))
  }
  private touch(field: string): void { if (!this.touched.includes(field)) this.touched = this.touched.concat(field) }
  private restoreTouched(): void {
    if (this.draft.name.length > 0) this.touch('name')
    if (this.draft.categoryId) this.touch('category')
    if (this.draft.description.length > 0) this.touch('description')
    this.draft.skus.forEach((sku: ProductSkuInput, index: number) => {
      if (sku.spec.length > 0) this.touch('spec-' + index)
      if (sku.price.length > 0) this.touch('price-' + index)
      if (sku.stock.length > 0) this.touch('stock-' + index)
    })
  }
  private validationError(field: string): string {
    if (field === 'name') return this.nameError()
    if (field === 'category') return this.draft.categoryId ? '' : '请选择分类'
    if (field === 'description') return this.draft.description.length > 2000 ? '商品说明最多2000个字' : ''
    const parts = field.split('-'), sku = this.draft.skus[Number(parts[1])]
    if (!sku) return ''
    return parts[0] === 'spec' ? this.specError(sku) : parts[0] === 'price' ? this.priceError(sku) : this.stockError(sku)
  }
  private fieldError(field: string): string { return this.submitted || this.touched.includes(field) ? this.validationError(field) : '' }
  private firstError(): string {
    const fields: string[] = ['name', 'category', 'description']
    this.draft.skus.forEach((sku: ProductSkuInput, index: number) => { fields.push('spec-' + index, 'price-' + index, 'stock-' + index) })
    return fields.find(field => !!this.validationError(field)) || 'name'
  }
  private scrollToError(field: string): void {
    const generation = this.generation, token = this.token
    setTimeout(() => {
      if (!this.current(generation, token)) return
      try {
        const ui = this.getUIContext(), components = ui.getComponentUtils()
        const target = components.getRectangleById('product-label-' + field)
        const viewport = components.getRectangleById('product-form-scroll')
        this.scroller.scrollTo({ xOffset: 0, yOffset: Math.max(0, this.scroller.currentOffset().yOffset + ui.px2vp(target.windowOffset.y - viewport.windowOffset.y) - 12), animation: false })
      } catch { this.scroller.scrollTo({ xOffset: 0, yOffset: 0, animation: false }) }
    }, 0)
  }
  private categoryLabel(category: ProductCategory): string { return category.name + (this.draft.categoryId === category.id ? ' ✓ 已选' : '') }
  private stockHint(index: number): string {
    const stock = this.draft.skus[index].stock
    return stock.trim() !== '' && Number(stock) === 0 ? '为 0 时买家看不到' : ''
  }
  private async chooseImage(): Promise<void> {
    if (this.saving || this.pending) return
    const generation = this.generation, token = this.token
    try {
      const image = await pickProductImage()
      if (!this.current(generation, token) || !image) return
      this.draft.image = image; this.changed()
    } catch { if (this.current(generation, token)) this.setMessage('图片无法读取或过大，请重新选择图片', 'warning') }
  }
  private imageFailed(): void { this.setMessage('请重新选择图片', 'warning'); this.draft.image = ''; this.changed() }
  private addSku(): void {
    if (this.saving || this.pending || this.draft.skus.length >= 50) return
    this.draft.skus.push({ spec: '规格' + (this.draft.skus.length + 1), price: '', stock: '0', enabled: true, originalPrice: 0 }); this.changed()
  }
  private async clear(): Promise<void> {
    if (this.productId || this.saving || this.pending) return
    try { await this.persist(''); await this.load(); this.scroller.scrollTo({ xOffset: 0, yOffset: 0, animation: false }) } catch {}
  }
  private requestClear(): void {
    if (this.productId || this.saving || this.pending || !this.ready) return
    const generation = this.generation, token = this.token
    this.getUIContext().showAlertDialog({ title: '清空表单', message: '清空后已填写的内容不会保留',
      primaryButton: { value: '继续填写', action: () => {} },
      secondaryButton: { value: '确认清空', action: async () => { if (this.current(generation, token)) await this.clear() } }
    })
  }
  private mergeConflict(latest: ProductData, stockChanged: boolean = false): void {
    const old = this.draft, base = old.base, fresh = this.fromProduct(latest)
    const stockMessages: string[] = []
    if (!base || old.name !== base.name) fresh.name = old.name
    if (!base || old.description !== base.description) fresh.description = old.description
    fresh.image = old.image
    for (const input of old.skus) {
      if (!input.id) { fresh.skus.push(input); continue }
      const original = base?.skus.find(value => value.id === input.id), target = fresh.skus.find(value => value.id === input.id)
      if (!target) continue
      if (!original || input.spec !== original.spec) target.spec = input.spec
      if (!original || Math.round(Number(input.price) * 100) !== original.priceCents) target.price = input.price
      if (!original || Number(input.stock) !== original.stock) {
        if (stockChanged && original && Number(target.stock) !== original.stock) stockMessages.push('当前为 ' + target.stock + '，你填写的 ' + input.stock + ' 已保留')
        target.stock = input.stock
      }
      if (!original || input.enabled !== original.enabled) target.enabled = input.enabled
    }
    this.draft = fresh; this.changed()
    this.setMessage(stockChanged ? '库存刚有变化（可能有买家下单），' + stockMessages.join('；') + '，确认后再保存' :
      '该商品刚被修改，已载入最新内容，你的修改已保留在页面上，请核对后再次保存', 'warning')
  }
  private saveBody(): ProductBody {
    const base = this.draft.base
    if (!this.productId) return { name: this.draft.name.trim(), description: this.draft.description.trim(), categoryId: this.draft.categoryId,
      skus: this.draft.skus.map((sku: ProductSkuInput): ProductSkuPatch => { return { spec: sku.spec.trim(), priceCents: Math.round(Number(sku.price) * 100), stock: Number(sku.stock), enabled: sku.enabled } }) }
    if (!base) throw new Error('请重新读取商品后保存')
    const body: ProductBody = { expectedRevision: this.draft.revision }
    if (this.draft.name.trim() !== base.name) body.name = this.draft.name.trim()
    if (this.draft.description.trim() !== base.description) body.description = this.draft.description.trim()
    const patches: ProductSkuPatch[] = []
    for (const input of this.draft.skus) {
      const original = base.skus.find(sku => sku.id === input.id)
      if (!input.id) { patches.push({ spec: input.spec.trim(), priceCents: Math.round(Number(input.price) * 100), stock: Number(input.stock), enabled: input.enabled }); continue }
      if (!original) throw new Error('请重新读取商品规格后保存')
      const patch: ProductSkuPatch = { id: input.id }
      let changed = false
      if (input.spec.trim() !== original.spec) { patch.spec = input.spec.trim(); changed = true }
      if (Math.round(Number(input.price) * 100) !== original.priceCents) { patch.priceCents = Math.round(Number(input.price) * 100); changed = true }
      if (Number(input.stock) !== original.stock) { patch.stock = Number(input.stock); patch.expectedStock = original.stock; changed = true }
      if (input.enabled !== original.enabled) { patch.enabled = input.enabled; changed = true }
      if (changed) patches.push(patch)
    }
    if (patches.length > 0) body.skus = patches
    return body
  }
  private schedule(generation: number, token: string): void {
    if (!this.pending || this.timer !== -1 || !this.current(generation, token)) return
    const delays: number[] = [1000, 3000, 8000]
    if (this.attempts >= delays.length) { this.exhausted = true; return }
    this.timer = setTimeout(() => { this.timer = -1; if (this.current(generation, token)) void this.save() }, delays[this.attempts++])
  }
  private async save(): Promise<void> {
    const generation = this.generation, token = this.token
    if (!this.current(generation, token) || this.saving || !this.ready) return
    if (!this.pending && !this.valid()) { this.submitted = true; this.setMessage('请核对下面标出的输入', 'warning'); this.scrollToError(this.firstError()); return }
    this.saving = true; this.setMessage('', 'normal')
    try {
      await this.persist(JSON.stringify(this.draft))
      if (!this.current(generation, token)) return
      const body = this.saveBody()
      const result = this.pending ? await productSave.resume(this.productId, token) : await productSave.start(this.productId, body, this.draft.image, token)
      if (!this.current(generation, token)) return
      this.pending = false; this.stop()
      const zeroStock = result.skus.every(sku => sku.stock === 0)
      const notice: ProductNotice = { text: zeroStock ? '已保存，库存为0，买家暂时看不到' : '商品已保存', kind: zeroStock ? 'warning' : 'normal' }
      this.stackPath.pop(notice)
    } catch (error) {
      if (!this.current(generation, token)) return
      this.pending = productSave.pending(this.accountId, this.productId) !== null
      const failure = error as ProductError
      if (failure.response?.data?.reason === 'PRODUCT_STOCK_CHANGED' && failure.response.data.result) this.mergeConflict(failure.response.data.result, true)
      else if (failure.response?.data?.reason === 'PRODUCT_REVISION_CHANGED' && failure.response.data.result) this.mergeConflict(failure.response.data.result)
      else this.setMessage(this.pending ? '正在确认是否已保存' : '保存未完成，输入已保留，请核对后重试', this.pending ? 'normal' : 'warning')
    } finally { if (this.current(generation, token)) { this.saving = false; this.schedule(generation, token) } }
  }

  @Builder
  private FieldLabel(label: string, field: string) {
    Text(label).id('product-label-' + field).fontColor($r('[ui_components].color.text')).fontWeight(500)
  }
  @Builder
  private FieldError(field: string) {
    if (this.fieldError(field)) { Text(this.fieldError(field)).fontColor($r('[ui_components].color.red')) }
  }
  @Builder
  private Form() {
    this.FieldLabel('商品名称', 'name')
    TextInput({ text: this.draft.name, placeholder: '请输入商品名称' }).id('product-name').maxLength(100)
      .onChange(value => { this.draft.name = value; this.touch('name'); this.changed() }).onBlur(() => this.touch('name'))
    this.FieldError('name')
    this.FieldLabel('分类', 'category')
    if (this.productId) {
      Text(this.draft.base?.categoryName || this.draft.categoryId).fontColor($r('[ui_components].color.text'))
      Text('分类创建后不可修改').fontSize(13).fontColor($r('[ui_components].color.gray'))
    } else {
      Flex({ wrap: FlexWrap.Wrap }) {
        ForEach(this.categories, (category: ProductCategory) => {
          Button(this.categoryLabel(category)).id('product-category-' + category.id)
            .backgroundColor(this.draft.categoryId === category.id ? $r('sys.color.ohos_id_color_emphasize') : Color.Transparent)
            .fontColor(this.draft.categoryId === category.id ? $r('[ui_components].color.loading_foreground') : $r('[ui_components].color.text'))
            .border({ width: 1, color: this.draft.categoryId === category.id ? $r('sys.color.ohos_id_color_emphasize') : $r('[ui_components].color.border') })
            .margin({ right: 8, bottom: 4 }).onClick(() => { this.draft.categoryId = category.id; this.touch('category'); this.changed() })
        }, (category: ProductCategory) => category.id)
      }
      this.FieldError('category')
    }
    this.FieldLabel('商品说明（选填）', 'description')
    TextArea({ text: this.draft.description, placeholder: '补充商品特点或使用说明' }).maxLength(2000)
      .onChange(value => { this.draft.description = value; this.touch('description'); this.changed() }).onBlur(() => this.touch('description'))
    this.FieldError('description')
    this.FieldLabel('商品图片', 'image')
    if (this.draft.image || this.draft.picture) {
      Image(this.draft.image ? 'data:image/jpeg;base64,' + this.draft.image : this.draft.picture).width(160).height(160).objectFit(ImageFit.Contain).onError(() => this.imageFailed())
    }
    Button('选择商品图片').backgroundColor(Color.Transparent).fontColor($r('sys.color.ohos_id_color_emphasize'))
      .border({ width: 1, color: $r('[ui_components].color.border') }).onClick(() => this.chooseImage())
    ForEach(this.draft.skus, (sku: ProductSkuInput, index: number) => {
      Column({ space: 8 }) {
        this.FieldLabel('规格名称', 'spec-' + index)
        TextInput({ text: sku.spec, placeholder: '例如：标准款' }).id('product-spec-' + index).maxLength(60)
          .onChange(value => { this.draft.skus[index].spec = value; this.touch('spec-' + index); this.changed() }).onBlur(() => this.touch('spec-' + index))
        this.FieldError('spec-' + index)
        this.FieldLabel('价格（元）', 'price-' + index)
        TextInput({ text: sku.price, placeholder: '请输入价格' }).id('product-price-' + index).type(InputType.NUMBER_DECIMAL)
          .onChange(value => { this.draft.skus[index].price = value; this.touch('price-' + index); this.changed() }).onBlur(() => this.touch('price-' + index))
        this.FieldError('price-' + index)
        if (sku.originalPrice > 0 && Math.round(Number(sku.price) * 100) !== sku.originalPrice && !this.priceError(sku)) {
          Text('¥' + (sku.originalPrice / 100).toFixed(2) + ' → ¥' + Number(sku.price).toFixed(2) + '，保存后新订单使用新价，已有订单金额不变').fontColor($r('[ui_components].color.red'))
        }
        Row({ space: 8 }) {
          this.FieldLabel('库存', 'stock-' + index)
          if (this.stockHint(index)) { Text(this.stockHint(index)).fontSize(12).fontColor($r('[ui_components].color.gray')) }
        }
        TextInput({ text: sku.stock, placeholder: '请输入库存' }).id('product-stock-' + index).type(InputType.Number)
          .onChange(value => { this.draft.skus[index].stock = value; this.touch('stock-' + index); this.changed() }).onBlur(() => this.touch('stock-' + index))
        this.FieldError('stock-' + index)
        Row({ space: 12 }) { Text('启用此规格').fontColor($r('[ui_components].color.text')); Toggle({ type: ToggleType.Switch, isOn: sku.enabled }).id('product-enabled-' + index).onChange(value => { this.draft.skus[index].enabled = value; this.changed() }) }
      }.padding(12).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('[ui_components].color.under')).borderRadius(12)
    }, (sku: ProductSkuInput, index: number) => sku.id || 'new-' + index)
    Button('添加规格').backgroundColor(Color.Transparent).fontColor($r('sys.color.ohos_id_color_emphasize'))
      .border({ width: 1, color: $r('[ui_components].color.border') }).enabled(this.draft.skus.length < 50).onClick(() => this.addSku())
  }
  build() {
    NavDestination() {
      Column() {
        HDMNavBar({ title: this.productId ? '编辑商品' : '新建商品' })
        Scroll(this.scroller) {
          Column({ space: 12 }) {
            if (this.message) { Text(this.message).id('product-edit-message').fontColor(this.messageColor()) }
            if (this.draftError) { Text(this.draftError).fontColor($r('[ui_components].color.red')) }
            if (this.loading) { Text('正在读取商品').fontColor($r('[ui_components].color.text')) }
            if (!this.ready && !this.loading) { Button('重试').onClick(() => this.load()) }
            if (this.ready) {
              Column({ space: 12 }) { this.Form() }.width('100%').alignItems(HorizontalAlign.Start).enabled(!this.saving && !this.pending)
              if (!this.productId) {
                Button('清空').id('product-clear').backgroundColor(Color.Transparent).fontColor($r('[ui_components].color.gray'))
                  .margin({ top: 32, bottom: 32 }).enabled(!this.saving && !this.pending).onClick(() => this.requestClear())
              }
              if (this.pending) { Text('正在确认是否已保存').fontColor($r('[ui_components].color.text')) }
            }
          }.padding(16).width('100%').alignItems(HorizontalAlign.Start)
        }.align(Alignment.Top).layoutWeight(1).width('100%').id('product-form-scroll')
        if (this.ready) {
          Column() {
            Button(this.pending ? (this.exhausted ? '确认保存结果' : '正在确认是否已保存') : this.saving ? '正在保存' : '保存')
              .id('product-save').width('100%').height(48)
              .enabled(!this.saving && (!this.pending || this.exhausted)).onClick(() => this.save())
          }.padding({ left: 16, right: 16, top: 12, bottom: 12 + this.safeBottom }).width('100%')
            .backgroundColor($r('[ui_components].color.white'))
        }
      }.padding({ top: this.safeTop }).width('100%').height('100%').backgroundColor($r('[ui_components].color.white'))
    }.hideTitleBar(true)
    .onReady(context => { this.productId = context.pathInfo.param as string || ''; this.active = true; void this.load() })
    .onShown(() => this.shown()).onHidden(() => this.aboutToDisappear())
  }
}
