import { KeyboardAvoidMode } from '@kit.ArkUI'
import { RequestAxios } from 'network'
import { reviewLabel, formatBeijingTime } from 'models'
import { connection } from '@kit.NetworkKit'
import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMNavBar } from 'ui_components'
import { HDMUser, OrderItem, OrderSku, LocalEvaluationItem, ReviewChoice, ReviewHistory, SizeChoice, PromiseEntry } from 'models'
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

interface CorrectionRequest {reason:string}
interface FollowupRequest {content:string}

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
  @State sizes:SizeChoice[] = []
  @State content: string = ''
  @State errorText: string = ''
  @State resultUnknown: boolean = false
  @State correctionReason:string=''
  @State correcting:boolean=false
  @State followupContent: string = ''
  @State followupSubmitting: boolean = false
  @State followupError: string = ''
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
    this.correctionReason=''
    this.correcting=false
    this.followupContent = ''
    this.followupSubmitting = false
    this.followupError = ''
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
    this.sizes=[]
    this.content = ''
    this.errorText = ''
    this.followupContent = ''
    this.followupSubmitting = false
    this.followupError = ''
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
        this.sizes=draft.sizes || []
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
        const draft: EvaluationDraft = { score: this.score, content: this.content, logisticsScore:this.logisticsScore, serviceScore:this.serviceScore, items:this.choices, sizes:this.sizes, pending:this.pendingEvaluation }
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
      this.orderId.length > 0 && this.order?.evaluation?.hiddenSource!=='platform' &&
      !this.order?.evaluation?.followup && !this.submitting && !this.submitted
  }

  private isOriginalEditable(): boolean {
    return this.order?.evaluation?.hiddenSource !== 'platform' &&
      !this.order?.evaluation?.followup &&
      !(this.order?.evaluation && !this.order?.canEvaluate)
  }

  private canSubmitFollowup(): boolean {
    return this.isCurrentEvaluation(this.pageGeneration, this.sessionToken, this.orderId) &&
      !!this.order?.evaluation?.canFollowup && !this.order?.evaluation?.followup &&
      !this.followupSubmitting && !this.loading && !this.loadFailed
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
        if(evaluation?.hiddenReason){this.errorText=evaluation.hiddenSource==='platform'?'':'已被商家隐藏：'+evaluation.hiddenReason+'，请修改后重新发布';this.pendingEvaluation=undefined;this.saveDraft()}
        else if(evaluation && this.sameSubmission(evaluation,snapshot)){
          this.submitted=true;this.pendingEvaluation=undefined;this.errorText='评价已发布';this.saveDraft()
        }else if(evaluation){this.errorText='订单已有不同评价，本次输入已保留';this.pendingEvaluation=undefined;this.saveDraft()}
        else {this.errorText='尚未查到本次评价，可以继续提交';this.pendingEvaluation=undefined;this.saveDraft()}
      } else if (orderToReview.evaluation?.hiddenReason) {
        this.errorText = orderToReview.evaluation.hiddenSource==='platform'?'':'已被商家隐藏：' + orderToReview.evaluation.hiddenReason + '，请修改后重新发布'
        if (!this.content) { this.content = orderToReview.evaluation.content; this.score = orderToReview.evaluation.score }
      } else if (orderToReview.evaluation && orderToReview.canEvaluate) {
        const previous = orderToReview.evaluation
        if (!this.content) {
          this.content=previous.content
          this.sizes=previous.sizes || []
          this.score=previous.score
          this.logisticsScore=previous.logisticsScore || 0
          this.serviceScore=previous.serviceScore || 0
          this.choices=(previous.items || []).map((v:ReviewChoice):ReviewChoice=>({skuId:v.skuId,fieldId:v.fieldId,result:v.result,note:v.note}))
        }
        this.errorText=''
      } else if (orderToReview.evaluation) {
        this.errorText = (orderToReview.evaluation.followup || orderToReview.evaluation.canFollowup) ? '' : '该订单已评价，当前输入保留为本机草稿'
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
    const sizes=expected.sizes || [], saved=actual.sizes || []
    return sizes.length===saved.length && sizes.every(choice=>saved.some(value=>value.skuId===choice.skuId &&
      value.sizeFit===choice.sizeFit && (value.sizeShift || '')===(choice.sizeShift || ''))) && !actual.hiddenReason && actual.score===expected.score && actual.content===expected.content.trim()
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
    if ((this.order.skus || []).some(sku=>sku.sizeReviewRequired && !this.sizeChoice(sku.id))) {
      this.errorText='请选择尺码合不合适';return
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
        items:this.choices,sizes:this.sizes.length ? this.sizes : undefined,revision:this.order.evaluation?.revision}
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

  private async submitFollowup(): Promise<void> {
    if (!this.canSubmitFollowup()) return
    const trimmed: string = this.followupContent.trim()
    const length: number = Array.from(trimmed).length
    if (length < 5 || length > 300) {
      this.followupError = '请填写5至300字的处理后感受'
      return
    }
    const token: string = this.sessionToken
    const generation: number = this.pageGeneration
    const orderId: string = this.orderId
    this.followupSubmitting = true
    this.followupError = ''
    try {
      await RequestAxios.postWithSession<object>(
        '/member/order/' + encodeURIComponent(orderId) + '/evaluation/followup',
        { content: trimmed } as FollowupRequest,
        token
      )
      if (this.isCurrentEvaluation(generation, token, orderId)) {
        this.followupContent = ''
        this.safeToast('已追加处理后感受')
        await this.loadOrderForEvaluation()
      }
    } catch (error) {
      if (this.isCurrentEvaluation(generation, token, orderId)) {
        const failure = orderWriteFailure(error as Error)
        this.followupError = failure.unknownResult
          ? '结果确认中，请刷新查看是否已追加'
          : (failure.message || '追加失败，请检查内容后重试')
      }
    } finally {
      if (generation === this.pageGeneration) this.followupSubmitting = false
    }
  }

  private sizeChoice(skuId:string):SizeChoice|undefined {
    return this.sizes.find(value=>value.skuId===skuId)
  }
  private chooseSize(skuId:string,sizeFit:string,sizeShift?:string):void {
    if(!this.canEditEvaluation()) return
    const choice:SizeChoice={skuId,sizeFit,sizeShift:sizeFit==='true' ? undefined : sizeShift}
    this.sizes=this.sizes.filter(value=>value.skuId!==skuId).concat([choice])
    this.errorText=''
    this.queueDraft()
  }
  @Builder
  private SizePicker(sku:OrderSku) {
    Text(sku.attrsText+' · 尺码合不合适').fontColor($r('[ui_components].color.text'))
    Row({space:6}){
      ForEach(['larger','true','smaller'],(fit:string)=>{
        Button((this.sizeChoice(sku.id)?.sizeFit===fit?'✓ ':'')+(fit==='larger'?'偏大':fit==='true'?'合适':'偏小'))
          .fontColor(this.sizeChoice(sku.id)?.sizeFit===fit?Color.White:'#252525')
          .backgroundColor(this.sizeChoice(sku.id)?.sizeFit===fit?'#D91B2B':Color.White)
          .onClick(()=>this.chooseSize(sku.id,fit))
      })
    }
    if(this.sizeChoice(sku.id) && this.sizeChoice(sku.id)?.sizeFit!=='true'){
      Row({space:6}){
        ForEach(['half','full'],(shift:string)=>{
          Button((this.sizeChoice(sku.id)?.sizeShift===shift?'✓ ':'')+(shift==='half'?'约半码':'约一码'))
            .fontColor(this.sizeChoice(sku.id)?.sizeShift===shift?Color.White:'#252525')
            .backgroundColor(this.sizeChoice(sku.id)?.sizeShift===shift?'#D91B2B':Color.White)
            .onClick(()=>this.chooseSize(sku.id,this.sizeChoice(sku.id)!.sizeFit,this.sizeChoice(sku.id)?.sizeShift===shift?undefined:shift))
        })
      }
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

  private async requestCorrection():Promise<void>{
    const token=this.sessionToken, generation=this.pageGeneration, dispute=this.order?.evaluation?.dispute
    if(!dispute?.canCorrect || this.correcting || Array.from(this.correctionReason.trim()).length<5 || Array.from(this.correctionReason.trim()).length>200)return
    this.correcting=true
    try{
      await RequestAxios.postWithSession<object>('/reviews/'+encodeURIComponent(dispute.reviewId)+'/correction',
        {reason:this.correctionReason.trim()} as CorrectionRequest,token)
      if(this.pageActive && generation===this.pageGeneration && token===this.sessionToken){
        this.correctionReason=''; await this.loadOrderForEvaluation()
      }
    }catch(error){if(generation===this.pageGeneration)this.safeToast((error as Error).message)}
    finally{if(generation===this.pageGeneration)this.correcting=false}
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
                if(this.isOriginalEditable()){
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
                ForEach(this.order?.skus || [],(sku:OrderSku)=>{
                  if(sku.sizeReviewRequired){this.SizePicker(sku)}
                })
                this.OptionalScore('物流评分',true)
                if(this.order?.afterSales?.length) { this.OptionalScore('售后评分',false) }
                else { Text('售后：未发生').fontColor($r('[ui_components].color.gray')) }
                ForEach(this.order?.skus || [],(sku:OrderSku)=>{
                  ForEach(sku.promiseSnapshot?.entries || [],(field:PromiseEntry)=>{
                    if(field.status==='known'){this.PromisePicker(sku,field)}
                  })
                })
                }
                if(this.order?.evaluation){
                  if (!this.isOriginalEditable() && this.order.evaluation.hiddenSource !== 'platform') {
                    Text('原评分：' + this.order.evaluation.score.toString() + ' 星 · 物流 ' +
                      (this.order.evaluation.logisticsScore ? this.order.evaluation.logisticsScore + '分' : '未评分') +
                      ' · 售后 ' + (this.order.evaluation.serviceScore ? this.order.evaluation.serviceScore + '分' :
                      this.order.evaluation.serviceOccurred ? '未评分' : '未发生'))
                      .fontSize(13)
                      .fontColor($r('[ui_components].color.text'))
                  }
                  if(this.order.evaluation.hiddenSource==='platform'){
                    Text(this.order.evaluation.dispute?.canCorrect?'已被平台复核隐藏，可请求更正':'已被平台复核隐藏').fontColor($r('[ui_components].color.text'))
                  }
                  if(this.order.evaluation.dispute?.conclusion){
                    Text('平台复核 · '+reviewLabel(this.order.evaluation.dispute.conclusion.kind)).fontColor($r('[ui_components].color.text'))
                    Text(this.order.evaluation.dispute.conclusion.reason)
                    Text(formatBeijingTime(this.order.evaluation.dispute.conclusion.time)+' · '+reviewLabel(this.order.evaluation.dispute.status))
                    if(this.order.evaluation.dispute.canCorrect){
                      TextInput({placeholder:'更正理由（5至200字）',text:this.correctionReason}).maxLength(200).onChange((s:string)=>{this.correctionReason=s})
                      Button('请求更正').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red'))
                        .enabled(!this.correcting && Array.from(this.correctionReason.trim()).length>=5).onClick(()=>this.requestCorrection())
                    }
                  }
                  Text((this.order.evaluation.hiddenSource==='platform' || !this.isOriginalEditable() ? '原评价：' : '已发布：') + this.order.evaluation.content)
                    .fontColor($r('[ui_components].color.text'))
                  ForEach(this.order.evaluation.history || [],(entry:ReviewHistory)=>{
                    Text('第'+entry.revision+'版：'+entry.content).fontColor($r('[ui_components].color.gray'))
                  })
                  Text('售后处理记录：' + (this.order.evaluation.serviceRecord?.label || '处理记录待接入'))
                    .fontSize(12)
                    .fontColor($r('[ui_components].color.gray'))
                  if (this.order.evaluation.followup) {
                    Divider().strokeWidth(0.5).color($r('[ui_components].color.border'))
                    Column({ space: 6 }) {
                      Text('买家追加 · ' + formatBeijingTime(this.order.evaluation.followup.createdAt))
                        .fontSize(13)
                        .fontWeight(500)
                        .fontColor($r('[ui_components].color.red'))
                      Text(this.order.evaluation.followup.content)
                        .fontSize(14)
                        .lineHeight(20)
                        .fontColor($r('[ui_components].color.text'))
                      Text('已追加处理后感受，原评价与追加内容均为只读')
                        .fontSize(11)
                        .fontColor($r('[ui_components].color.gray'))
                    }
                    .width('100%')
                    .padding(10)
                    .backgroundColor($r('[ui_components].color.under'))
                    .borderRadius(8)
                    .alignItems(HorizontalAlign.Start)
                  } else if (this.order.evaluation.canFollowup) {
                    Divider().strokeWidth(0.5).color($r('[ui_components].color.border'))
                    Row() {
                      Text('追加处理后感受')
                        .fontSize(15)
                        .fontWeight(500)
                        .fontColor($r('[ui_components].color.text'))
                      Blank()
                      Text(Array.from(this.followupContent.trim()).length.toString() + '/300')
                        .fontSize(11)
                        .fontColor($r('[ui_components].color.gray'))
                    }
                    .width('100%')
                    Text('售后已结束，可追加一次处理后感受（5至300字，不含联系方式，提交后不可修改，原评价保持不变）')
                      .fontSize(12)
                      .fontColor($r('[ui_components].color.gray'))
                    TextArea({ placeholder: '说说售后处理后的真实感受，5至300字', text: this.followupContent })
                      .id('evaluation-followup-input')
                      .height(100)
                      .width('100%')
                      .fontSize(14)
                      .backgroundColor($r('[ui_components].color.under'))
                      .borderRadius(8)
                      .padding(10)
                      .maxLength(300)
                      .enabled(!this.followupSubmitting)
                      .onChange((value: string) => {
                        if (this.followupSubmitting) return
                        this.followupContent = value
                        this.followupError = ''
                      })
                    if (this.followupError) {
                      Text(this.followupError)
                        .fontSize(12)
                        .fontColor($r('[ui_components].color.red'))
                    }
                    Button(this.followupSubmitting ? '提交追加中...' : '提交处理后感受')
                      .id('evaluation-followup-submit')
                      .width('100%')
                      .height(44)
                      .fontSize(15)
                      .fontWeight(500)
                      .backgroundColor($r('[ui_components].color.red'))
                      .fontColor($r('[ui_components].color.on_primary'))
                      .enabled(this.canSubmitFollowup() && Array.from(this.followupContent.trim()).length >= 5 && Array.from(this.followupContent.trim()).length <= 300)
                      .onClick(() => { void this.submitFollowup() })
                  }
                }

                if(this.isOriginalEditable()){
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

          if(this.isOriginalEditable()){
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
