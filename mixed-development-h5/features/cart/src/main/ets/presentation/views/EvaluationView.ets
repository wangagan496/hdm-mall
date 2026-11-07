import { KeyboardAvoidMode } from '@kit.ArkUI'
import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMNavBar } from 'ui_components'
import { HDMUser, OrderItem, OrderSku } from 'models'
import { validateEvaluation, auth, storeManager } from 'storage'
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

interface EvaluationDraft {
  score: number
  content: string
}

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
  @State content: string = ''
  @State errorText: string = ''
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
    this.content = ''
    this.errorText = ''
    this.submitted = false
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
        const draft: EvaluationDraft = { score: this.score, content: this.content }
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
      if (orderToReview.evaluation) {
        this.errorText = '该订单已评价，当前输入保留为本机草稿'
      } else if (!orderToReview.canEvaluate) {
        this.errorText = '当前订单暂不能评价，输入已保留，请确认收货后重试'
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
      }
    }
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

  private async submitEvaluation(): Promise<void> {
    if (this.submitting || this.submitted || !this.pageActive || this.leaving || this.loading || this.loadFailed ||
      !this.order || this.order.id !== this.orderId || this.orderId !== this.readEvaluationOrderId()) {
      return
    }
    if (!this.order.canEvaluate) {
      this.errorText = '当前订单暂不能评价，请确认收货后重试'
      return
    }
    if (!this.isCurrentSession()) {
      this.errorText = '登录状态已变化，请重新打开评价页'
      return
    }
    // 空字符串表示评分和文字均通过检查；否则直接显示具体原因。
    const validationMessage = validateEvaluation(this.score, this.content)
    if (validationMessage) {
      this.errorText = validationMessage
      return
    }
    this.submitting = true
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const orderId: string = this.order.id
    try {
      const score: number = this.score
      const content: string = this.content
      const actions: EvaluationSubmitActions = {
        submitRemote: async (): Promise<void> => {
          try {
            await commentOrderAPI(orderId, { score, content }, token)
          } catch (error) {
            if (!this.isCurrentEvaluation(generation, token, orderId)) return
            // 回应丢失时按已保存内容确认；其他评价不冒充本次提交成功。
            const confirmed = await getOrderDetailAPI(orderId, token).catch(() => null)
            if (!this.isCurrentEvaluation(generation, token, orderId)) return
            if (!confirmed?.evaluation || confirmed.evaluation.score !== score ||
              confirmed.evaluation.content !== content.trim()) throw error as Error
          }
          if (!this.isCurrentEvaluation(generation, token, orderId)) return
          this.submitted = true
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
        this.errorText = failure.unknownResult ? '网络连接失败，评价结果待确认，输入已保留，请恢复网络后重新提交' :
          failure.message || '提交失败，请重试'
      }
    } finally {
      if (this.isCurrentEvaluation(generation, token, orderId)) this.submitting = false
    }
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
    .backgroundColor(hasEvaluationTag(this.content, tag) ? '#FFF0F0' : $r('[ui_components].color.under'))
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
            Button('重新加载')
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

                Text('评价提交后保存到账号，可在订单详情中查看')
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
            Button(this.submitting ? '提交中...' : '提交评价')
              .width('100%')
              .height(44)
              .fontSize(15)
              .fontWeight(500)
              .backgroundColor($r('[ui_components].color.red'))
              .constraintSize({ minHeight: 44 })
              .enabled(this.canEditEvaluation() && !this.loading && !this.loadFailed && !!this.order?.canEvaluate)
              .onClick(() => this.submitEvaluation())
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
