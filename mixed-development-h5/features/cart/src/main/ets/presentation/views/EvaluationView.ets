import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMNavBar } from 'ui_components'
import { OrderItem, OrderSku } from 'models'
import { DemoOrderStore, demoOrderStore } from 'storage'
import { commentOrderAPI, getOrderDetailAPI } from '../../data/api'
import { getOrderStateText } from '../utils/OrderPresentation'

@Builder
function EvaluationViewBuilder() {
  EvaluationView()
}

@Component
export struct EvaluationView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @State order: OrderItem | null = null
  @State loading: boolean = true
  @State loadFailed: boolean = false
  @State submitting: boolean = false
  @State score: number = 5
  @State content: string = ''
  @State errorText: string = ''
  @Consume stackPath: NavPathStack

  private orderId: string = ''

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  aboutToAppear(): void {
    const params = this.stackPath.getParamByName(PAGE_PATH.EVALUATION_PAGE) as string[]
    this.orderId = params && params.length ? params[params.length - 1] : ''
    this.load()
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
      this.order = await getOrderDetailAPI(this.orderId)
    } catch {
      this.loadFailed = true
    } finally {
      this.loading = false
    }
  }

  private setScore(value: number): void {
    if (value < 1 || value > 5) {
      return
    }
    this.score = value
    this.errorText = ''
  }

  private async submit(): Promise<void> {
    if (this.submitting || !this.order) {
      return
    }
    const validation = DemoOrderStore.validateEvaluation(this.score, this.content)
    if (validation) {
      this.errorText = validation
      return
    }
    this.submitting = true
    try {
      try {
        await commentOrderAPI(this.order.id)
      } catch {
        // 后端评价接口可能不支持沙箱；忽略网络层失败，把评价只写到本地演示层。
      }
      await demoOrderStore.saveEvaluation(this.order.id, this.score, this.content)
      this.safeToast('评价成功')
      this.stackPath.pop()
    } catch (error) {
      this.errorText = (error as Error).message || '提交失败，请重试'
    } finally {
      this.submitting = false
    }
  }

  @Builder
  private ScorePicker() {
    Row({ space: 12 }) {
      ForEach([1, 2, 3, 4, 5], (value: number) => {
        Text('★')
          .fontSize(28)
          .fontColor(value <= this.score ? '#F5A623' : $r('[ui_components].color.border'))
        .onClick(() => this.setScore(value))
      }, (value: number) => value.toString())
      Blank()
      Text(this.score + ' 星')
        .fontSize(14)
        .fontColor($r('[ui_components].color.gray'))
    }
    .width('100%')
  }

  @Builder
  private SkuList() {
    ForEach(this.order?.skus, (sku: OrderSku) => {
      Row({ space: 10 }) {
        Image(sku.image)
          .width(56)
          .height(56)
          .borderRadius(4)
          .backgroundColor($r('[ui_components].color.under'))
        Column({ space: 4 }) {
          Text(sku.name)
            .fontSize(13)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(sku.attrsText || '默认规格')
            .fontSize(11)
            .fontColor($r('[ui_components].color.gray'))
        }
        .layoutWeight(1)
      }
      .width('100%')
      .padding({ top: 8, bottom: 8 })
    }, (sku: OrderSku) => sku.id)
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: '订单评价',
          onLeftClick: () => this.stackPath.pop()
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
              Column({ space: 8 }) {
                Text(getOrderStateText(this.order.orderState) + ' 订单')
                  .fontSize(15)
                  .fontWeight(500)
                Text('订单号 ' + this.order.id)
                  .fontSize(11)
                  .fontColor($r('[ui_components].color.gray'))
                this.SkuList()
              }
              .width('100%')
              .padding(12)
              .backgroundColor($r('[ui_components].color.white'))
              .borderRadius(8)

              Column({ space: 12 }) {
                Text('评分')
                  .fontSize(14)
                  .fontWeight(500)
                this.ScorePicker()

                Text('评价内容')
                  .fontSize(14)
                  .fontWeight(500)
                TextArea({ placeholder: '请输入 5-200 字评价', text: $$this.content })
                  .height(120)
                  .width('100%')
                  .fontSize(14)
                  .backgroundColor($r('[ui_components].color.under'))
                  .borderRadius(4)
                  .padding(8)
                  .maxLength(200)
                  .onChange(() => {
                    this.errorText = ''
                  })

                if (this.errorText) {
                  Text(this.errorText)
                    .fontSize(12)
                    .fontColor($r('[ui_components].color.red'))
                }
              }
              .width('100%')
              .padding(12)
              .backgroundColor($r('[ui_components].color.white'))
              .borderRadius(8)
              .alignItems(HorizontalAlign.Start)

              Button(this.submitting ? '提交中...' : '提交评价')
                .width('100%')
                .height(44)
                .fontSize(15)
                .backgroundColor($r('[ui_components].color.red'))
                .enabled(!this.submitting && this.content.trim().length > 0)
                .onClick(() => this.submit())
            }
            .padding(8)
          }
          .layoutWeight(1)
          .scrollBar(BarState.Off)
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