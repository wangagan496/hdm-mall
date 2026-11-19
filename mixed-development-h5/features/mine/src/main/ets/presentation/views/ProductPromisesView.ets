import { util } from '@kit.ArkTS'
import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMUser, PromiseDraft, PromiseEntry, PromiseSnapshot, sameIdentitySession } from 'models'
import { storeManager } from 'storage'
import { HDMNavBar } from 'ui_components'
import {
  ProductPromises, PromiseDecision, getProductPromises, extractProductPromises, confirmProductPromises,
  publishProductPromises, findPromiseReceipt, promiseRequestStatus, promiseRequestMessage
} from '../../data/api/productPromises'

@Builder
function ProductPromisesViewBuilder() { ProductPromisesView() }

@Component
export struct ProductPromisesView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = {} as HDMUser
  @State draft: PromiseDraft | null = null
  @State published: PromiseSnapshot | null = null
  @State decisions: PromiseDecision[] = []
  @State busy: boolean = false
  @State pendingKey: string = ''
  @State message: string = ''
  private session: HDMUser | null = null
  private productId: string = ''
  private active: boolean = true
  private generation: number = 0

  private current(generation: number, session: HDMUser | null): boolean {
    return this.active && this.generation === generation && !!this.productId && !!session?.id &&
      this.user.id === session.id && this.user.identity === 'merchant' && sameIdentitySession(this.user, session)
  }

  private accountChanged(): void {
    if (this.session?.id === this.user.id && sameIdentitySession(this.user, this.session)) return
    this.clear()
    if (this.active) void this.load()
  }

  private clear(): void {
    this.generation++
    this.session = null
    this.draft = null
    this.published = null
    this.decisions = []
    this.pendingKey = ''
    this.message = ''
    this.busy = false
  }

  private hide(): void { this.active = false; this.clear() }
  aboutToDisappear(): void { this.hide() }

  private storeKey(session: HDMUser): string {
    return 'promise-publication:' + session.id + ':' + this.productId
  }

  private async saveKey(session: HDMUser, requestKey: string): Promise<void> {
    const store = storeManager.getStore()
    const key = this.storeKey(session)
    const before = store.getSync(key, '') as string
    store.putSync(key, requestKey)
    try {
      await store.flush()
    } catch {
      store.putSync(key, before)
      throw new Error('发布记录保存失败，请重试')
    }
  }

  private display(result: ProductPromises): void {
    if (this.draft?.id !== result.draft?.id) this.decisions = []
    this.draft = result.draft
    this.published = result.published
  }

  private async load(): Promise<void> {
    if (this.busy || !this.active || !this.productId) return
    const session = this.user
    const generation = ++this.generation
    this.session = session
    if (!this.current(generation, session)) {
      this.message = '请切换为店主身份后查看商品承诺'
      return
    }
    this.busy = true
    this.message = ''
    try {
      this.pendingKey = storeManager.getStore().getSync(this.storeKey(session), '') as string
      const result = await getProductPromises(this.productId, session.token)
      if (!this.current(generation, session)) return
      this.display(result)
      if (this.pendingKey) await this.recover(generation, session, this.pendingKey)
    } catch (error) {
      if (this.current(generation, session)) {
        this.message = promiseRequestMessage(error as Error, '承诺记录暂未读取，请刷新重试')
      }
    } finally {
      if (this.current(generation, session)) this.busy = false
    }
  }

  private async recover(generation: number, session: HDMUser, requestKey: string): Promise<void> {
    const receipt = await findPromiseReceipt(this.productId, requestKey, session.token)
    if (!this.current(generation, session)) return
    if (!receipt) {
      this.message = '暂未查到发布记录。核对草稿后可再次发布，系统会沿用上次记录。'
      return
    }
    await this.saveKey(session, '')
    if (!this.current(generation, session)) return
    this.pendingKey = ''
    this.message = '上次发布已确认'
    if (!this.published || this.published.publishedAt <= receipt.publishedAt) this.published = receipt
  }

  private async extract(): Promise<void> {
    const generation = this.generation, session = this.session
    if (this.busy || !session || !this.current(generation, session)) return
    this.busy = true
    this.message = ''
    try {
      const result = await extractProductPromises(this.productId, session.token)
      if (!this.current(generation, session)) return
      this.display(result)
      this.message = this.draft ? '草稿已生成' : '没有可用的承诺草稿'
    } catch (error) {
      if (this.current(generation, session)) {
        this.message = promiseRequestMessage(error as Error, '抽取结果暂未确认，请先刷新查看承诺')
      }
    } finally {
      if (this.current(generation, session)) this.busy = false
    }
  }

  private decision(fieldId: string): string {
    return this.decisions.find(item => item.fieldId === fieldId)?.decision || ''
  }

  private choose(entry: PromiseEntry, decision: string): void {
    if (this.busy || !this.current(this.generation, this.session) || entry.status !== 'known') return
    this.decisions = this.decisions.filter(item => item.fieldId !== entry.fieldId).concat([{ fieldId: entry.fieldId, decision }])
  }

  private canPublish(): boolean {
    const entries = this.draft?.entries || []
    return !this.busy && this.current(this.generation, this.session) &&
      entries.filter(entry => entry.status === 'known').every(entry => !!this.decision(entry.fieldId)) &&
      this.decisions.some(item => item.decision === 'accept')
  }

  private requestPublish(): void {
    if (!this.canPublish()) return
    const generation = this.generation, session = this.session, draftId = this.draft?.id
    const decisions = this.decisions
    this.getUIContext().showAlertDialog({
      title: '发布商品承诺',
      message: '本次确认 ' + decisions.filter(item => item.decision === 'accept').length + ' 条。发布后，这些承诺将随新订单保存。',
      primaryButton: { value: '返回核对', action: () => {} },
      secondaryButton: { value: '确认发布', action: () => {
        if (session && draftId && this.current(generation, session) && this.draft?.id === draftId &&
          this.decisions === decisions && this.canPublish()) void this.publish(draftId, decisions, generation, session)
      } }
    })
  }

  private async publish(draftId: string, decisions: PromiseDecision[], generation: number, session: HDMUser): Promise<void> {
    this.busy = true
    this.message = ''
    const requestKey = this.pendingKey || util.generateRandomUUID(true)
    try {
      if (this.pendingKey) {
        await this.recover(generation, session, requestKey)
        if (!this.current(generation, session)) return
        if (!this.pendingKey) {
          this.draft = null
          this.decisions = []
          return
        }
      }
      const confirmation = await confirmProductPromises(this.productId, draftId, decisions, session.token)
      if (!this.current(generation, session)) return
      await this.saveKey(session, requestKey)
      if (!this.current(generation, session)) return
      this.pendingKey = requestKey
      const receipt = await publishProductPromises(this.productId, confirmation, requestKey, session.token)
      if (!this.current(generation, session)) return
      this.published = receipt
      this.draft = null
      this.decisions = []
      this.message = '承诺已发布'
      await this.saveKey(session, '')
      if (this.current(generation, session)) this.pendingKey = ''
    } catch (error) {
      if (this.current(generation, session)) {
        const status = promiseRequestStatus(error as Error)
        this.message = promiseRequestMessage(error as Error, this.pendingKey
          ? '发布结果暂未确认，请查询发布结果' : '发布未完成，请重试')
        if (status === 409) {
          await getProductPromises(this.productId, session.token).then(result => {
            if (this.current(generation, session)) this.display(result)
          }).catch(() => {})
        }
      }
    } finally {
      if (this.current(generation, session)) this.busy = false
    }
  }

  private valueText(entry: PromiseEntry): string {
    if (entry.status === 'not-applicable') return '不适用'
    if (entry.status === 'unknown') return '商品资料未说明'
    return (entry.value || '') + (entry.unit || '')
  }

  @Builder
  private Entry(entry: PromiseEntry, editable: boolean) {
    Column({ space: 6 }) {
      Text(entry.label + '：' + this.valueText(entry)).fontSize(15).fontColor($r('[ui_components].color.text'))
      if (entry.condition) {
        Text('适用条件：' + entry.condition).fontSize(14).fontColor($r('[ui_components].color.text'))
      }
      if (entry.conditionNeedsReview) {
        Text('请看原文核对').fontSize(14).fontColor($r('[ui_components].color.text'))
      }
      if (entry.quote) {
        Text((entry.sourceRef?.field === 'material' ? '材料说明原文 · 第 ' + entry.sourceRevision + ' 版：' : '商品资料原文：') + entry.quote)
          .fontSize(13).fontColor($r('[ui_components].color.gray'))
      }
      if (editable && entry.status === 'known') {
        Row({ space: 8 }) {
          Button(this.decision(entry.fieldId) === 'accept' ? '已确认' : '确认').id('promises-accept-' + entry.fieldId)
            .backgroundColor(this.decision(entry.fieldId) === 'accept' ? $r('[ui_components].color.red') : $r('[ui_components].color.under'))
            .fontColor(this.decision(entry.fieldId) === 'accept' ? $r('[ui_components].color.on_primary') : $r('[ui_components].color.text'))
            .enabled(!this.busy).onClick(() => this.choose(entry, 'accept'))
          Button(this.decision(entry.fieldId) === 'reject' ? '已不采纳' : '不采纳').id('promises-reject-' + entry.fieldId)
            .backgroundColor(this.decision(entry.fieldId) === 'reject' ? $r('[ui_components].color.red') : $r('[ui_components].color.under'))
            .fontColor(this.decision(entry.fieldId) === 'reject' ? $r('[ui_components].color.on_primary') : $r('[ui_components].color.text'))
            .enabled(!this.busy).onClick(() => this.choose(entry, 'reject'))
        }
      }
    }.width('100%').alignItems(HorizontalAlign.Start).padding({ top: 8, bottom: 8 })
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({ title: '商品承诺', onLeftClick: () => this.stackPath.pop() })
        if (this.message) {
          Text(this.message).id('product-promises-message').fontColor($r('[ui_components].color.text')).width('100%').padding(12)
        }
        Scroll() {
          Column({ space: 12 }) {
            Button('管理来源材料').id('product-source-materials').width('100%')
              .backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.text'))
              .enabled(!this.busy && this.current(this.generation, this.session))
              .onClick(() => this.stackPath.pushPath({ name: PAGE_PATH.PRODUCT_MATERIALS_PAGE, param: this.productId }))
            Row({ space: 8 }) {
              Button(this.busy ? '处理中' : '让 AI 抽取承诺').id('product-promises-extract')
                .backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary'))
                .enabled(!this.busy && this.current(this.generation, this.session)).onClick(() => this.extract())
              Button(this.pendingKey ? '查询发布结果' : '刷新承诺').id('product-promises-refresh')
                .backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.text'))
                .enabled(!this.busy).onClick(() => this.load())
            }.width('100%')
            if (this.draft) {
              Column({ space: 8 }) {
                Text('逐条确认草稿').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('[ui_components].color.text'))
                ForEach(this.draft.issues, (issue: string) => {
                  Text(issue).fontSize(14).fontColor($r('[ui_components].color.red')).width('100%')
                })
                ForEach(this.draft.entries, (entry: PromiseEntry) => {
                  this.Entry(entry, true)
                }, (entry: PromiseEntry) => entry.fieldId + ':' + this.decision(entry.fieldId) + ':' + (this.draft?.id || ''))
                Button('发布已确认的承诺').id('product-promises-publish').width('100%')
                  .backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary'))
                  .enabled(this.canPublish()).onClick(() => this.requestPublish())
              }.width('100%').padding(12).alignItems(HorizontalAlign.Start)
                .backgroundColor($r('[ui_components].color.white')).borderRadius(8)
            }
            Column({ space: 8 }) {
              Text('当前已发布的承诺').id('product-promises-published').fontSize(18).fontColor($r('[ui_components].color.text'))
              if (this.published) {
                ForEach(this.published.entries, (entry: PromiseEntry) => {
                  this.Entry(entry, false)
                }, (entry: PromiseEntry) => entry.fieldId + ':' + (this.published?.receiptId || ''))
              } else if (!this.busy) {
                Text('尚无已发布承诺').fontColor($r('[ui_components].color.gray'))
              }
            }.width('100%').padding(12).alignItems(HorizontalAlign.Start)
              .backgroundColor($r('[ui_components].color.white')).borderRadius(8)
          }.width('100%').padding(12)
        }.align(Alignment.Top).layoutWeight(1).width('100%')
      }.width('100%').height('100%').padding({ top: this.safeTop, bottom: this.safeBottom })
        .backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true)
    .onReady((context: NavDestinationContext) => { this.productId = context.pathInfo.param as string; void this.load() })
    .onShown(() => { this.active = true; if (!this.session) void this.load() })
    .onHidden(() => this.hide())
  }
}
