import { GlobalVariable } from 'constants'
import { HDMNavBar } from 'ui_components'
import { DecisionService } from 'network'

interface ServiceQuestion {
  question: string
  answer: string
}

@Builder
function CustomerServiceViewBuilder() {
  CustomerServiceView()
}

@Component
export struct CustomerServiceView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @State
  expandedQuestionIndex: number = -1
  @State
  problemDescription: string = ''
  @State
  suggestedHandling: string = ''
  @State
  isClassifyingProblem: boolean = false
  @Consume
  stackPath: NavPathStack
  questions: ServiceQuestion[] = [
    { question: '收藏保存在哪里？', answer: '当前演示版将收藏保存在本机，暂未与账号服务端同步。' },
    { question: '足迹会保留多少条？', answer: '浏览足迹按最近访问排序，相同商品会自动去重，最多保留 50 条。' },
    { question: '为什么看不到历史订单？', answer: '登录后可从个人中心的订单入口查看订单，并按订单状态筛选。' },
    { question: '在线客服可以聊天吗？', answer: '当前演示版尚未接入客服会话服务，因此不会展示虚假的聊天记录。' }
  ]

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  private showHumanServiceUnavailable(): void {
    this.safeToast('当前演示版未接入客服服务端')
  }

  private async suggestProblemHandling(): Promise<void> {
    const message: string = this.problemDescription.trim()
    if (!message) {
      this.safeToast('请先描述订单或售后问题')
      return
    }
    this.isClassifyingProblem = true
    this.suggestedHandling = ''
    try {
      // 只判断问题属于哪一类，不创建客服会话，也不办理退款。
      const classification = await DecisionService.routeOrderMessage(message)
      if (classification.fallback || !classification.result) {
        this.suggestedHandling = '暂时无法自动判断，建议联系人工客服。'
        return
      }
      this.suggestedHandling = `建议处理方向：${this.getProblemTypeLabel(String(classification.result))}`
    } catch {
      this.suggestedHandling = '智能分流暂时不可用，建议联系人工客服。'
    } finally {
      this.isClassifyingProblem = false
    }
  }

  private getProblemTypeLabel(problemType: string): string {
    switch (problemType) {
      case 'logistics':
        return '物流配送'
      case 'refund':
        return '退款售后'
      case 'payment':
        return '支付账单'
      case 'product':
        return '商品咨询'
      default:
        return '其他问题'
    }
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: '帮助与客服',
          onLeftClick: () => this.stackPath.pop()
        })
        Scroll() {
          Column({ space: 12 }) {
            Column({ space: 8 }) {
              Image($r('app.media.ic_user_service'))
                .width(44)
                .height(44)
              Text('有什么可以帮你？')
                .fontSize(18)
                .fontWeight(FontWeight.Bold)
                .fontColor($r('[ui_components].color.black'))
              Text('先查看常见问题，也可以尝试联系人工客服')
                .fontSize(12)
                .fontColor($r('[ui_components].color.gray'))
            }
            .width('100%')
            .padding(24)
            .backgroundColor($r('[ui_components].color.white'))
            .borderRadius(10)

            Column() {
              Text('常见问题')
                .fontSize(15)
                .fontWeight(500)
                .fontColor($r('[ui_components].color.black'))
                .width('100%')
                .padding({ left: 14, top: 14, right: 14, bottom: 8 })
              ForEach(this.questions, (item: ServiceQuestion, index: number) => {
                Column() {
                  Row() {
                    Text(item.question)
                      .fontSize(14)
                      .fontColor($r('[ui_components].color.text'))
                    Blank()
                    Text(this.expandedQuestionIndex === index ? '收起' : '查看')
                      .fontSize(12)
                      .fontColor($r('[ui_components].color.red'))
                  }
                  .width('100%')
                  .padding(14)
                  .onClick(() => {
                    this.expandedQuestionIndex = this.expandedQuestionIndex === index ? -1 : index
                  })
                  if (this.expandedQuestionIndex === index) {
                    Text(item.answer)
                      .fontSize(13)
                      .fontColor($r('[ui_components].color.gray'))
                      .lineHeight(21)
                      .width('100%')
                      .padding({ left: 14, right: 14, bottom: 14 })
                  }
                  Divider()
                    .strokeWidth(0.5)
                    .color($r('[ui_components].color.border'))
                    .margin({ left: 14, right: 14 })
                }
              })
            }
            .width('100%')
            .backgroundColor($r('[ui_components].color.white'))
            .borderRadius(10)

            Column({ space: 8 }) {
              Text('订单问题智能分流')
                .fontSize(15)
                .fontWeight(500)
                .fontColor($r('[ui_components].color.black'))
                .width('100%')
              TextInput({ placeholder: '例如：订单一直没有发货，应该怎么办？', text: this.problemDescription })
                .width('100%')
                .height(44)
                .onChange((value: string) => {
                  this.problemDescription = value
                })
              Button(this.isClassifyingProblem ? '判断中...' : '智能分流')
                .width('100%')
                .height(42)
                .fontSize(14)
                .backgroundColor($r('[ui_components].color.red'))
                .enabled(!this.isClassifyingProblem)
                .onClick(() => {
                  void this.suggestProblemHandling()
                })
              if (this.suggestedHandling) {
                Text(this.suggestedHandling)
                  .fontSize(13)
                  .fontColor($r('[ui_components].color.gray'))
                  .lineHeight(20)
                  .width('100%')
              }
            }
            .width('100%')
            .padding(14)
            .backgroundColor($r('[ui_components].color.white'))
            .borderRadius(10)

            Button('联系人工客服')
              .width('100%')
              .height(44)
              .fontSize(14)
              .backgroundColor($r('[ui_components].color.black'))
              .onClick(() => this.showHumanServiceUnavailable())

            Text('说明：智能分流只提供处理建议，不会直接修改订单或执行退款。')
              .fontSize(11)
              .fontColor($r('[ui_components].color.gray'))
              .lineHeight(18)
              .width('100%')
              .padding({ left: 4, right: 4, bottom: 16 })
          }
          .padding(12)
        }
        .layoutWeight(1)
        .scrollBar(BarState.Off)
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('[ui_components].color.under'))
    }
    .hideTitleBar(true)
    .padding({ top: this.topHeight })
  }
}
