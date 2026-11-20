import { KeyboardAvoidMode } from '@kit.ArkUI'
import { connection } from '@kit.NetworkKit'
import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMNavBar } from 'ui_components'
import { HDMUser, OrderItem, OrderSku, LocalEvaluationItem, ReviewChoice, ReviewHistory, PromiseEntry } from 'models'
import { validateEvaluation, auth, storeManager } from 'storage'
import { EvaluationPayload } from '../../data/api/cart'
import { commentOrderAPI, getOrderDetailAPI } from '../../data/api'
import { EvaluationSubmitActions, submitEvaluationFlow } from '../utils/EvaluationSubmitFlow'
import { orderWriteFailure } from '../utils/OrderWriteFailure'
import { EvaluationNavigationActions, returnEvaluationToOrders } from '../utils/EvaluationNavigation'
import {
  EVALUATION_CONTENT_MAX_LENGTH,
  getEvaluationQuickTags,
  getScoreLabel,
  hasEvaluationTag,
  toggleEvaluationTag
} from '../utils/EvaluationPresentation'

@Builder
function EvaluationViewBuilder() {
  EvaluationView()
}

interface EvaluationDraft extends EvaluationSnapshot {
  score: number
  content: string
  pending?: EvaluationSnapshot
}
interface EvaluationSnapshot extends EvaluationPayload {}

@Component
export struct EvaluationView {
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('reloadForCurrentAccount') user: HDMUser = {} as HDMUser
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM)
  bottomHeight: number = 0
  @State order: OrderItem | null = null
  @State loading: boolean = true
  @State loadFailed: boolean = false
  @State submitting: boolean = false
  @State score: number = 5
  @State logisticsScore: number = 0
  @State serviceScore: number = 0
  @State choices: ReviewChoice[] = []
  @State content: string = ''
  @State errorText: string = ''
  @State resultUnknown: boolean = false
  @StorageProp(GlobalVariable.APP_FOREGROUND_SEQUENCE) @Watch('refreshEvaluationResult') foregroundSequence:number=0
  private pendingEvaluation:EvaluationSnapshot | undefined=undefined
  private evaluationMonitor:connection.NetConnection | undefined=undefined
  @Consume stackPath: NavPathStack

  private orderId: string = ''
  private leaving: boolean = false
  private draftKey: string = ''
  private submitted: boolean = false
  private sessionToken: string = ''
  private pageActive: boolean = false
  private pageGeneration: number = 0
  private querySequence: number = 0
  private draftTimer: number = -1
  private draftSaveSequence: number = 0
  private previousKeyboardAvoidMode: KeyboardAvoidMode | undefined = undefined
  private readonly quickTags: string[] = getEvaluationQuickTags()

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  aboutToAppear(): void {
    if (this.pageActive) return
    this.pageActive = true
    this.leaving = false
    this.pageGeneration++
    this.synchronizeEvaluationContext()
    try {
      this.previousKeyboardAvoidMode = this.getUIContext().getKeyboardAvoidMode()
      this.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE)
    } catch {
    }
    this.loadOrderForEvaluation()
  }

  private reloadForCurrentAccount(): void {
    if (this.synchronizeEvaluationContext() && this.pageActive && !this.leaving) {
      this.loadOrderForEvaluation()
    }
  }

  private synchronizeEvaluationContext(): boolean {
    const user = auth.getUserInfo()
    const token: string = user?.token || ''
    const orderId: string = this.readEvaluationOrderId()
    const draftKey: string = token && user?.id && orderId ? 'evaluation-draft:' + user.id + ':' + orderId : ''
    if (token === this.sessionToken && orderId === this.orderId && draftKey === this.draftKey) return false
    // 保存仍属于旧账号和旧订单的输入，再切换草稿归属。
    this.saveDraft()
    clearTimeout(this.draftTimer)
    this.draftTimer = -1
    this.pageGeneration++
    this.querySequence++
    this.sessionToken = token
    this.orderId = orderId
    this.draftKey = draftKey
    this.order = null
    this.score = 5
    this.logisticsScore = 0
    this.serviceScore = 0
    this.choices = []
    this.content = ''
    this.errorText = ''
    this.submitted = false
    this.pendingEvaluation=undefined;this.resultUnknown=false;this.stopEvaluationMonitor()
    this.submitting = false
    this.loading = false
    this.loadFailed = false
    if (!draftKey) return true
    try {
      const raw: string = storeManager.getStore().getSync(draftKey, '') as string
      if (raw) {
        const draft = JSON.parse(raw) as EvaluationDraft
        this.score = draft.score >= 1 && draft.score <= 5 ? draft.score : 5
        this.content = typeof draft.content === 'string' ? draft.content.slice(0, EVALUATION_CONTENT_MAX_LENGTH) : ''
        this.logisticsScore=draft.logisticsScore || 0
        this.serviceScore=draft.serviceScore || 0
        this.choices=draft.items || []
        this.pendingEvaluation=draft.pending;this.resultUnknown=!!draft.pending
      }
    } catch {}
    return true
  }

  private readEvaluationOrderId(): string {
    const evaluationOrderIds = this.stackPath.getParamByName(PAGE_PATH.EVALUATION_PAGE) as string[]
    if (!evaluationOrderIds || evaluationOrderIds.length === 0) {
      return ''
    }
    // 同名评价页可能存在多次，最后一项对应最近打开的评价页。
    const latestPageIndex: number = evaluationOrderIds.length - 1
    return evaluationOrderIds[latestPageIndex]
  }

  aboutToDisappear(): void {
    if (!this.pageActive) return
    this.pageActive = false
    this.stopEvaluationMonitor()
    this.leaving = true
    this.pageGeneration++
    this.querySequence++
    clearTimeout(this.draftTimer)
    this.draftTimer = -1
    this.saveDraft()
    this.submitting = false
    this.loading = false
    try {
      if (this.previousKeyboardAvoidMode !== undefined) {
        this.getUIContext().setKeyboardAvoidMode(this.previousKeyboardAvoidMode)
      }
    } catch {
    }
    this.previousKeyboardAvoidMode = undefined
  }

  private leaveToPrevious(message: string): void {
    if (this.leaving) {
      return
    }
    this.leaving = true
    if (message) {
      this.safeToast(message)
    }
    this.stackPath.pop()
  }

  private saveDraft(): void {
    if (!this.draftKey) return
    const key: string = this.draftKey
    const sequence: number = ++this.draftSaveSequence
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const orderId: string = this.orderId
    const failed = (): void => {
      if (sequence !== this.draftSaveSequence || !this.isCurrentEvaluation(generation, token, orderId)) return
      this.errorText = '本机草稿保存失败，请保留文字后重试'
      this.safeToast(this.errorText)
    }
    try {
      const store = storeManager.getStore()
      if (this.submitted) store.deleteSync(key)
      else {
        const draft: EvaluationDraft = { score: this.score, content: this.content, logisticsScore:this.logisticsScore, serviceScore:this.serviceScore, items:this.choices, pending:this.pendingEvaluation }
        store.putSync(key, JSON.stringify(draft))
      }
      void store.flush().catch(failed)
    } catch { failed() }
  }

  private queueDraft(): void {
    clearTimeout(this.draftTimer)
    this.draftTimer = -1
    if (!this.canEditEvaluation()) return
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const orderId: string = this.orderId
    this.draftTimer = setTimeout(() => {
      if (!this.isCurrentEvaluation(generation, token, orderId)) return
      this.draftTimer = -1
      this.saveDraft()
    }, 500)
  }

  private isCurrentSession(): boolean {
    return this.sessionToken.length > 0 && auth.getUserInfo()?.token === this.sessionToken
  }

  private isCurrentEvaluation(generation: number, token: string, orderId: string): boolean {
    return this.pageActive && !this.leaving && generation === this.pageGeneration &&
      token === this.sessionToken && this.isCurrentSession() && orderId === this.orderId &&
      orderId === this.readEvaluationOrderId()
  }

  private canEditEvaluation(): boolean {
    return this.isCurrentEvaluation(this.pageGeneration, this.sessionToken, this.orderId) &&
      this.orderId.length > 0 && !this.submitting && !this.submitted
  }

  private async loadOrderForEvaluation(): Promise<void> {
    this.synchronizeEvaluationContext()
    const sequence: number = ++this.querySequence
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const orderId: string = this.orderId
    if (!orderId || !this.isCurrentEvaluation(generation, token, orderId)) {
      this.loading = false
      this.loadFailed = true
      return
    }
    this.loading = true
    this.loadFailed = false
    try {
      const orderToReview = await getOrderDetailAPI(orderId, token)
      if (sequence !== this.querySequence || !this.isCurrentEvaluation(generation, token, orderId)) {
        return
      }
      this.order = orderToReview
      if(this.pendingEvaluation) {
        const snapshot=this.pendingEvaluation,evaluation=orderToReview.evaluation
        this.resultUnknown=false;this.stopEvaluationMonitor()
        if(evaluation?.hiddenReason){this.errorText='已被商家隐藏：'+evaluation.hiddenReason+'，请修改后重新发布';this.pendingEvaluation=undefined;this.saveDraft()}
        else if(evaluation && this.sameSubmission(evaluation,snapshot)){
          this.submitted=true;this.pendingEvaluation=undefined;this.errorText='评价已发布';this.saveDraft()
        }else if(evaluation){this.errorText='订单已有不同评价，本次输入已保留';this.pendingEvaluation=undefined;this.saveDraft()}
        else {this.errorText='尚未查到本次评价，可以继续提交';this.pendingEvaluation=undefined;this.saveDraft()}
      } else if (orderToReview.evaluation?.hiddenReason) {
        this.errorText = '已被商家隐藏：' + orderToReview.evaluation.hiddenReason + '，请修改后重新发布'
        if (!this.content) { this.content = orderToReview.evaluation.content; this.score = orderToReview.evaluation.score }
      } else if (orderToReview.evaluation && orderToReview.canEvaluate) {
        const previous = orderToReview.evaluation
        if (!this.content) {
          this.content=previous.content
          this.score=previous.score
          this.logisticsScore=previous.logisticsScore || 0
          this.serviceScore=previous.serviceScore || 0
          this.choices=(previous.items || []).map((v:ReviewChoice):ReviewChoice=>({skuId:v.skuId,fieldId:v.fieldId,result:v.result,note:v.note}))
        }
        this.errorText=''
      } else if (orderToReview.evaluation) {
        this.errorText = '该订单已评价，当前输入保留为本机草稿'
      } else if (!orderToReview.canEvaluate) {
        this.errorText = orderToReview.evaluationRule || '当前订单暂不能评价，输入已保留，请确认收货后重试'
      } else {
        this.errorText = ''
      }
    } catch {
      if (sequence === this.querySequence && this.isCurrentEvaluation(generation, token, orderId)) {
        this.loadFailed = true
      }
    } finally {
      if (sequence === this.querySequence && this.isCurrentEvaluation(generation, token, orderId)) {
        this.loading = false
        if(this.resultUnknown)this.watchEvaluationNetwork()
      }
    }
  }

  private async refreshEvaluationResult():Promise<void> {
    if(!this.pageActive||this.leaving||this.loading||this.submitting||!this.pendingEvaluation)return
    await this.loadOrderForEvaluation()
  }
  private stopEvaluationMonitor():void {
    const monitor=this.evaluationMonitor;this.evaluationMonitor=undefined
    try {monitor?.unregister(()=>{})}catch{}
  }
  private watchEvaluationNetwork():void {
    if(this.evaluationMonitor||!this.pageActive||!this.resultUnknown)return
    try {
      const monitor=connection.createNetConnection();this.evaluationMonitor=monitor
      monitor.on('netAvailable',()=>{if(this.evaluationMonitor===monitor)void this.refreshEvaluationResult()})
      monitor.register((error)=>{if(error&&this.evaluationMonitor===monitor)this.stopEvaluationMonitor();else if(this.evaluationMonitor!==monitor){try{monitor.unregister(()=>{})}catch{}}})
    }catch{this.evaluationMonitor=undefined}
  }

  private setScore(value: number): void {
    if (!this.canEditEvaluation() || value < 1 || value > 5) {
      return
    }
    this.score = value
    this.errorText = ''
    this.queueDraft()
  }

  private leaveToOrderList(message: string): void {
    if (this.leaving) {
      return
    }
    this.leaving = true
    this.safeToast(message)
    const actions: EvaluationNavigationActions = {
      pathNames: this.stackPath.getAllPathName(),
      popToIndex: (index: number): void => this.stackPath.popToIndex(index),
      removeByIndexes: (indexes: number[]): void => { this.stackPath.removeByIndexes(indexes) },
      replaceWithOrderList: (): void => {
        this.stackPath.replacePath({ name: PAGE_PATH.ORDER_PAGE, param: 0 })
      }
    }
    returnEvaluationToOrders(actions)
  }

  private toggleTag(tag: string): void {
    if (!this.canEditEvaluation()) {
      return
    }
    this.content = toggleEvaluationTag(this.content, tag, EVALUATION_CONTENT_MAX_LENGTH)
    this.errorText = ''
    this.queueDraft()
  }

  private choosePromise(skuId:string,fieldId:string,result:string,note:string):void {
    if(!this.canEditEvaluation()) return
    this.choices=this.choices.filter(item=>item.skuId!==skuId||item.fieldId!==fieldId)
      .concat([{skuId,fieldId,result,note} as ReviewChoice])
    this.queueDraft()
  }
  private choice(skuId:string,fieldId:string):ReviewChoice|undefined {
    return this.choices.find(item=>item.skuId===skuId && item.fieldId===fieldId)
  }
  private sameSubmission(actual:LocalEvaluationItem, expected:EvaluationSnapshot):boolean {
    const items=actual.items || [], choices=expected.items || []
    return !actual.hiddenReason && actual.score===expected.score && actual.content===expected.content.trim()
      && (actual.logisticsScore||0)===(expected.logisticsScore||0) && (actual.serviceScore||0)===(expected.serviceScore||0)
      && (!expected.revision || actual.revision===expected.revision+1) && items.length===choices.length &&
      choices.every(choice=>items.some(item=>item.skuId===choice.skuId && item.fieldId===choice.fieldId &&
        item.result===choice.result && item.note===choice.note.trim()))
  }
  private async submitEvaluation(): Promise<void> {
    if (this.resultUnknown || this.submitting || this.submitted || !this.pageActive || this.leaving || this.loading || this.loadFailed ||
      !this.order || this.order.id !== this.orderId || this.orderId !== this.readEvaluationOrderId()) {
      return
    }
    if (!this.order.canEvaluate) {
      this.errorText = this.order.evaluationRule || '当前订单暂不能评价，请确认收货后重试'
      return
    }
    if (!this.isCurrentSession()) {
      this.errorText = '登录状态已变化，请重新打开评价页'
      return
    }
    // 空字符串表示评分和文字均通过检查；否则直接显示具体原因。
    if (this.order.evaluation?.hiddenReason && this.content.trim() === this.order.evaluation.content) {
      this.errorText = '请修改评价内容后再发布'; return
    }
    const validationMessage = validateEvaluation(this.score, this.content)
    if (validationMessage) {
      this.errorText = validationMessage
      return
    }
    if ((this.order.skus||[]).some(sku=>sku.promiseSnapshot?.entries.some(field=>
      field.status==='known' && !this.choice(sku.id,field.fieldId)?.result))) {
      this.errorText='请逐条选择符合、不符或没注意';return
    }
    this.submitting = true
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const orderId: string = this.order.id
    try {
      const score: number = this.score
      const content: string = this.content
      const snapshot:EvaluationSnapshot={score,content,logisticsScore:this.logisticsScore || undefined,
        serviceScore:this.order.afterSales?.length ? this.serviceScore || undefined : undefined,
        items:this.choices,revision:this.order.evaluation?.revision}
      this.pendingEvaluation=snapshot;this.saveDraft()
      const actions: EvaluationSubmitActions = {
        submitRemote: async (): Promise<void> => {
          try {
            await commentOrderAPI(orderId, snapshot, token)
          } catch (error) {
            if (!this.isCurrentEvaluation(generation, token, orderId)) return
            // 回应丢失时按已保存内容确认；其他评价不冒充本次提交成功。
            const confirmed = await getOrderDetailAPI(orderId, token).catch(() => null)
            if (!this.isCurrentEvaluation(generation, token, orderId)) return
            if (!confirmed?.evaluation || !this.sameSubmission(confirmed.evaluation,snapshot)) throw error as Error
          }
          if (!this.isCurrentEvaluation(generation, token, orderId)) return
          this.submitted = true
          this.pendingEvaluation=undefined;this.resultUnknown=false;this.stopEvaluationMonitor()
          clearTimeout(this.draftTimer)
          this.saveDraft()
        },
        isActive: (): boolean => this.isCurrentEvaluation(generation, token, orderId),
        returnToOrderList: (): void => this.leaveToOrderList('评价成功')
      }
      await submitEvaluationFlow(actions)
    } catch (error) {
      if (this.isCurrentEvaluation(generation, token, orderId)) {
        const failure = orderWriteFailure(error as Error)
        this.resultUnknown=failure.unknownResult
        if(!this.resultUnknown)this.pendingEvaluation=undefined
        this.saveDraft();if(this.resultUnknown)this.watchEvaluationNetwork()
        this.errorText = failure.unknownResult ? '正在确认评价结果，输入已保留，恢复网络后会自动核对' :
          failure.message || '提交失败，请重试'
      }
    } finally {
      if (this.isCurrentEvaluation(generation, token, orderId)) this.submitting = false
    }
  }

  @Builder
  private OptionalScore(label:string, logistics:boolean) {
    Text(label + ((logistics ? this.logisticsScore : this.serviceScore) ? ' · '+(logistics ? this.logisticsScore : this.serviceScore)+'分' : ' · 未评分')).fontColor($r('[ui_components].color.text'))
    Row({space:8}) {
      ForEach([1,2,3,4,5], (value:number)=>{
        Text('★').fontSize(28).fontColor(value<=(logistics ? this.logisticsScore : this.serviceScore) ? '#F5A623' : $r('[ui_components].color.gray'))
          .accessibilityText(label+value+'分').onClick(()=>{
            if(logistics) this.logisticsScore=this.logisticsScore===value ? 0 : value
            else this.serviceScore=this.serviceScore===value ? 0 : value
            this.queueDraft()
          })
      })
    }
  }
  @Builder
  private PromisePicker(sku:OrderSku, field:PromiseEntry) {
    Text(sku.attrsText+' · '+field.label).fontColor($r('[ui_components].color.text'))
    Text(field.quote || field.value || '').fontSize(13).fontColor($r('[ui_components].color.gray'))
    Row({space:6}) {
      ForEach(['matches','mismatch','unnoticed'],(result:string)=>{
        Button((this.choice(sku.id,field.fieldId)?.result===result?'✓ ':'')+
          (result==='matches'?'符合':result==='mismatch'?'不符':'没注意')).fontSize(13)
          .backgroundColor(this.choice(sku.id,field.fieldId)?.result===result ? '#D91B2B' : Color.White)
          .fontColor(this.choice(sku.id,field.fieldId)?.result===result ? Color.White : '#252525')
          .onClick(()=>this.choosePromise(sku.id,field.fieldId,result,this.choice(sku.id,field.fieldId)?.note || ''))
      })
    }
    TextInput({placeholder:'补充说明（选填）',text:this.choice(sku.id,field.fieldId)?.note || ''}).maxLength(160)
      .onChange((value:string)=>this.choosePromise(sku.id,field.fieldId,this.choice(sku.id,field.fieldId)?.result || '',value))
  }
  @Builder
  private ScorePicker() {
    Row({ space: 10 }) {
      ForEach([1, 2, 3, 4, 5], (value: number) => {
        Text('★')
          .fontSize(32)
          .fontColor(value <= this.score ? '#F5A623' : $r('[ui_components].color.border'))
          .onClick(() => this.setScore(value))
          .accessibilityText(value.toString() + '星')
      }, (value: number) => value.toString())
      Blank()
      Text(getScoreLabel(this.score))
        .fontSize(14)
        .fontWeight(500)
        .fontColor(this.score >= 4 ? $r('[ui_components].color.red') : $r('[ui_components].color.gray'))
    }
    .width('100%')
  }

  @Builder
  private TagChip(tag: string) {
    Column() {
      Text(tag)
        .fontSize(12)
        .fontColor(hasEvaluationTag(this.content, tag) ? $r('[ui_components].color.red') :
          $r('[ui_components].color.text'))
        .textAlign(TextAlign.Center)
    }
    .layoutWeight(1)
    .height(32)
    .justifyContent(FlexAlign.Center)
    .borderRadius(16)
    .backgroundColor($r('[ui_components].color.under'))
    .border({
      width: 0.5,
      color: hasEvaluationTag(this.content, tag) ? $r('[ui_components].color.red') :
        $r('[ui_components].color.border')
    })
    .onClick(() => this.toggleTag(tag))
  }

  @Builder
  private TagRow(tags: string[]) {
    Row({ space: 8 }) {
      ForEach(tags, (tag: string) => {
        this.TagChip(tag)
      }, (tag: string) => tag)
    }
    .width('100%')
  }

  private getOrderGoods(): OrderSku[] {
    return this.order ? this.order.skus : []
  }

  private getOrderGoodsCount(): number {
    return this.order ? this.order.totalNum : 0
  }

  private getOrderPaidAmount(): number {
    return this.order ? this.order.payMoney : 0
  }

  @Builder
  private SkuList() {
    ForEach(this.getOrderGoods(), (sku: OrderSku) => {
      Row({ space: 8 }) {
        Image(sku.image)
          .width(52)
          .height(52)
          .objectFit(ImageFit.Cover)
          .borderRadius(6)
          .backgroundColor($r('[ui_components].color.under'))
        Column({ space: 2 }) {
          Text(sku.name)
            .fontSize(13)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .fontColor($r('[ui_components].color.black'))
          Text((sku.attrsText || '默认规格') + '  x' + sku.quantity.toString())
            .fontSize(11)
            .fontColor($r('[ui_components].color.gray'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        Text('¥' + sku.realPay.toFixed(2))
          .fontSize(13)
          .fontWeight(500)
      }
      .width('100%')
      .padding({ top: 4, bottom: 4 })
    }, (sku: OrderSku) => sku.id)
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: '订单评价',
          onLeftClick: () => this.leaveToPrevious('')
        })
        if (this.loading) {
          Text('正在核对评价资格，可以先填写内容')
            .fontSize(12)
            .padding(10)
        }
        if (this.loadFailed) {
          Column({ space: 12 }) {
            Text('订单加载失败，请稍后重试')
              .fontSize(14)
              .fontColor($r('[ui_components].color.gray'))
            Button('重新加载').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') })
              .onClick(() => this.loadOrderForEvaluation())
          }
        }
        Column() {
          Scroll() {
            Column({ space: 12 }) {
              if (this.order) {
              Column({ space: 6 }) {
                this.SkuList()
                Row() {
                  Text('共 ' + this.getOrderGoodsCount().toString() + ' 件')
                    .fontSize(12)
                    .fontColor($r('[ui_components].color.gray'))
                  Blank()
                  Text('实付款 ¥' + this.getOrderPaidAmount().toFixed(2))
                    .fontSize(14)
                    .fontWeight(500)
                }
                .width('100%')
              }
              .width('100%')
              .padding({ left: 12, right: 12, top: 10, bottom: 10 })
              .backgroundColor($r('[ui_components].color.white'))
              .borderRadius(12)
              }

              Column({ space: 12 }) {
                Row() {
                  Text('商品评分')
                    .fontSize(15)
                    .fontWeight(500)
                  Blank()
                  Text(this.score.toString() + ' 星')
                    .fontSize(12)
                    .fontColor($r('[ui_components].color.gray'))
                }
                .width('100%')
                this.ScorePicker()
                this.OptionalScore('物流评分',true)
                if(this.order?.afterSales?.length) { this.OptionalScore('售后评分',false) }
                else { Text('售后：未发生').fontColor($r('[ui_components].color.gray')) }
                ForEach(this.order?.skus || [],(sku:OrderSku)=>{
                  ForEach(sku.promiseSnapshot?.entries || [],(field:PromiseEntry)=>{
                    if(field.status==='known'){this.PromisePicker(sku,field)}
                  })
                })
                if(this.order?.evaluation){
                  Text('已发布：'+this.order.evaluation.content).fontColor($r('[ui_components].color.text'))
                  ForEach(this.order.evaluation.history || [],(entry:ReviewHistory)=>{
                    Text('第'+entry.revision+'版：'+entry.content).fontColor($r('[ui_components].color.gray'))
                  })
                }

                Divider().strokeWidth(0.5).color($r('[ui_components].color.border'))

                Text('快捷评价')
                  .fontSize(15)
                  .fontWeight(500)
                this.TagRow(this.quickTags.slice(0, 3))
                this.TagRow(this.quickTags.slice(3, 6))
                Text('点选标签可快速填写，也可继续补充文字')
                  .fontSize(11)
                  .fontColor($r('[ui_components].color.gray'))

                Divider().strokeWidth(0.5).color($r('[ui_components].color.border'))

                Row() {
                  Text('评价内容')
                    .fontSize(15)
                    .fontWeight(500)
                  Blank()
                  Text(this.content.trim().length.toString() + '/' + EVALUATION_CONTENT_MAX_LENGTH.toString())
                    .fontSize(11)
                    .fontColor($r('[ui_components].color.gray'))
                }
                .width('100%')
                TextArea({ placeholder: '说说商品、物流或尺码感受，至少 5 个字', text: this.content })
                  .height(120)
                  .width('100%')
                  .fontSize(14)
                  .backgroundColor($r('[ui_components].color.under'))
                  .borderRadius(8)
                  .padding(10)
                  .maxLength(EVALUATION_CONTENT_MAX_LENGTH)
                  .enabled(this.canEditEvaluation())
                  .onChange((value: string) => {
                    if (!this.canEditEvaluation()) return
                    this.content = value
                    this.errorText = ''
                    this.queueDraft()
                  })

                if (this.errorText) {
                  Text(this.errorText)
                    .fontSize(12)
                    .fontColor($r('[ui_components].color.red'))
                }

                Text('本项目默认自收货起15天内可评价和改评，改评保留原文；未收货仅退款不能评价。')
                  .fontSize(11)
                  .fontColor($r('[ui_components].color.gray'))
              }
              .width('100%')
              .padding(16)
              .backgroundColor($r('[ui_components].color.white'))
              .borderRadius(12)
              .alignItems(HorizontalAlign.Start)
            }
            .padding({ left: 12, right: 12, top: 8, bottom: 24 })
          }
          .layoutWeight(1)
          .scrollBar(BarState.Off)
          .align(Alignment.Top)

          Column() {
            Divider().strokeWidth(0.5).color($r('[ui_components].color.border'))
            Button(this.submitted?'评价已发布':this.resultUnknown?'核对评价结果':this.submitting ? '提交中...' : this.errorText.includes('继续提交')?'继续提交':this.order?.evaluation?.hiddenReason?'修改后重新发布':this.order?.evaluation?'提交改评':'提交评价').fontColor($r('[ui_components].color.on_primary'))
              .width('100%')
              .height(44)
              .fontSize(15)
              .fontWeight(500)
              .backgroundColor($r('[ui_components].color.red'))
              .constraintSize({ minHeight: 44 })
              .enabled(!this.submitted&&!this.loading&&!this.submitting&&(this.resultUnknown||this.canEditEvaluation()&&!this.loadFailed&&!!this.order?.canEvaluate))
              .onClick(() => {if(this.resultUnknown)void this.refreshEvaluationResult();else void this.submitEvaluation()})
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 8, bottom: 8 + this.bottomHeight })
          .backgroundColor($r('[ui_components].color.white'))
        }
        .layoutWeight(1)
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('[ui_components].color.under'))
    }
    .hideTitleBar(true)
    .onShown(() => this.aboutToAppear())
    .onHidden(() => this.aboutToDisappear())
    .padding({ top: this.topHeight })
  }
}
