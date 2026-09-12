import { KeyboardAvoidMode } from '@kit.ArkUI'
import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMNavBar } from 'ui_components'
import { OrderItem, OrderSku } from 'models'
import { DemoOrderStore, demoOrderStore } from 'storage'
import { commentOrderAPI, getOrderDetailAPI } from '../../data/api'
import { EvaluationSubmitActions, submitEvaluationFlow } from '../utils/EvaluationSubmitFlow'
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

@Component
export struct EvaluationView {
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
  private previousKeyboardAvoidMode: KeyboardAvoidMode | undefined = undefined
  private readonly quickTags: string[] = getEvaluationQuickTags()

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  aboutToAppear(): void {
    this.leaving = false
    const params = this.stackPath.getParamByName(PAGE_PATH.EVALUATION_PAGE) as string[]
    this.orderId = params && params.length ? params[params.length - 1] : ''
    try {
      this.previousKeyboardAvoidMode = this.getUIContext().getKeyboardAvoidMode()
      this.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE)
    } catch {
    }
    this.load()
  }

  aboutToDisappear(): void {
    this.leaving = true
    try {
      if (this.previousKeyboardAvoidMode !== undefined) {
        this.getUIContext().setKeyboardAvoidMode(this.previousKeyboardAvoidMode)
      }
    } catch {
    }
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

  private async load(): Promise<void> {
    if (!this.orderId) {
      this.loading = false
      this.loadFailed = true
      return
    }
    this.loading = true
    this.loadFailed = false
    try {
      const order = await getOrderDetailAPI(this.orderId)
      if (this.leaving) {
        return
      }
      this.order = order
      if (demoOrderStore.getEvaluation(this.orderId)) {
        this.leaveToOrderList('该订单已评价')
        return
      }
    } catch {
      if (!this.leaving) {
        this.loadFailed = true
      }
    } finally {
      if (!this.leaving) {
        this.loading = false
      }
    }
  }

  private setScore(value: number): void {
    if (this.submitting || value < 1 || value > 5) {
      return
    }
    this.score = value
    this.errorText = ''
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
    if (this.submitting) {
      return
    }
    this.content = toggleEvaluationTag(this.content, tag, EVALUATION_CONTENT_MAX_LENGTH)
    this.errorText = ''
  }

  private async submit(): Promise<void> {
    if (this.submitting || this.leaving || !this.order) {
      return
    }
    const validation = DemoOrderStore.validateEvaluation(this.score, this.content)
    if (validation) {
      this.errorText = validation
      return
    }
    this.submitting = true
    try {
      const orderId: string = this.order.id
      const score: number = this.score
      const content: string = this.content
      const actions: EvaluationSubmitActions = {
        submitRemote: async (): Promise<void> => { await commentOrderAPI(orderId) },
        saveLocal: async (): Promise<void> => { await demoOrderStore.saveEvaluation(orderId, score, content) },
        isActive: (): boolean => !this.leaving,
        returnToOrderList: (): void => this.leaveToOrderList('评价成功')
      }
      await submitEvaluationFlow(GlobalVariable.DEMO_ORDER_FLOW, actions)
    } catch (error) {
      if (!this.leaving) {
        this.errorText = (error as Error).message || '提交失败，请重试'
      }
    } finally {
      this.submitting = false
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

  private currentSkus(): OrderSku[] {
    return this.order ? this.order.skus : []
  }

  private currentTotalNum(): number {
    return this.order ? this.order.totalNum : 0
  }

  private currentPayMoney(): number {
    return this.order ? this.order.payMoney : 0
  }

  @Builder
  private SkuList() {
    ForEach(this.currentSkus(), (sku: OrderSku) => {
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
          Column() {
            LoadingProgress()
              .width(60)
              .height(60)
              .color($r('[ui_components].color.red'))
          }
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else if (this.loadFailed || !this.order) {
          Column({ space: 12 }) {
            Text('订单加载失败，请稍后重试')
              .fontSize(14)
              .fontColor($r('[ui_components].color.gray'))
            Button('重新加载')
              .onClick(() => this.load())
          }
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else {
          Scroll() {
            Column({ space: 12 }) {
              Column({ space: 6 }) {
                this.SkuList()
                Row() {
                  Text('共 ' + this.currentTotalNum().toString() + ' 件')
                    .fontSize(12)
                    .fontColor($r('[ui_components].color.gray'))
                  Blank()
                  Text('实付款 ¥' + this.currentPayMoney().toFixed(2))
                    .fontSize(14)
                    .fontWeight(500)
                }
                .width('100%')
              }
              .width('100%')
              .padding({ left: 12, right: 12, top: 10, bottom: 10 })
              .backgroundColor($r('[ui_components].color.white'))
              .borderRadius(12)

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
                  .enabled(!this.submitting)
                  .onChange((value: string) => {
                    this.content = value
                    this.errorText = ''
                  })

                if (this.errorText) {
                  Text(this.errorText)
                    .fontSize(12)
                    .fontColor($r('[ui_components].color.red'))
                }

                Text('评价仅保存在本机，用于演示订单流程')
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
              .enabled(!this.submitting)
              .onClick(() => this.submit())
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 8, bottom: 8 + this.bottomHeight })
          .backgroundColor($r('[ui_components].color.white'))
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('[ui_components].color.under'))
    }
    .hideTitleBar(true)
    .padding({ top: this.topHeight })
  }
}
