import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMGuess, HDMNavBar } from 'ui_components'
import { PayResultParams } from 'models'
import { getOrderDetailAPI } from '../../data/api'
import { getOrderStateText, isPaidOrderState } from '../utils/OrderPresentation'

@Builder
function PayResultViewBuilder() {
  PayResultView()
}

@Component
export struct PayResultView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @State payResult: boolean = false
  @State orderId: string = ''
  @State checking: boolean = true
  @State checkFailed: boolean = false
  @State serverOrderState: number = 0
  @Consume
  stackPath: NavPathStack

  aboutToAppear(): void {
    const params = this.stackPath.getParamByName(PAGE_PATH.PAY_RESULT_PAGE) as PayResultParams[]
    if (params && params.length && params[params.length - 1]) {
      this.payResult = params[params.length - 1].payResult
      this.orderId = params[params.length - 1].orderId
      this.checkOrderStatus()
    } else {
      this.checking = false
      this.checkFailed = true
    }
  }

  // 支付结果只以服务端 orderState 为准：2-4 已付款，1/5/6 按未付款/后续状态展示
  private async checkOrderStatus(): Promise<void> {
    if (!this.orderId) {
      this.checking = false
      this.checkFailed = true
      return
    }
    this.checking = true
    this.checkFailed = false
    try {
      const order = await getOrderDetailAPI(this.orderId)
      this.serverOrderState = order.orderState
      this.payResult = isPaidOrderState(order.orderState)
    } catch {
      this.checkFailed = true
    } finally {
      this.checking = false
    }
  }

  private getStateHint(): string {
    if (this.serverOrderState === 1) {
      return '订单尚未支付，可在订单页继续支付'
    }
    if (isPaidOrderState(this.serverOrderState)) {
      return '服务端已确认支付'
    }
    if (this.serverOrderState === 5) {
      return '订单已完成'
    }
    if (this.serverOrderState === 6) {
      return '订单已取消'
    }
    if (this.serverOrderState === 0) {
      return ''
    }
    return getOrderStateText(this.serverOrderState)
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: this.checking ? '确认支付' : this.checkFailed ? '支付结果待确认' :
            (this.payResult ? '付款成功' : '未付款')
        })
        List() {
          ListItem() {
            Column({ space: 20 }) {
              if (this.checking) {
                LoadingProgress()
                  .width(60)
                  .height(60)
                  .color($r('[ui_components].color.red'))
              } else {
                Image(this.payResult ? $r('[ui_components].media.ic_public_check_filled') :
                $r('[ui_components].media.ic_public_close_filled'))
                  .width(60)
                  .height(60)
                  .fillColor(this.payResult ? '#00C1BF' : '#B0171F')
                Text(this.checkFailed ? '支付结果待确认' : (this.payResult ? '付款成功' : '未付款'))
              }
              if (this.checking) {
                Text('正在向服务端确认订单状态…')
                  .fontSize(13)
                  .fontColor($r('[ui_components].color.gray'))
              } else if (this.checkFailed) {
                Text('暂时无法查到服务端订单状态，以上结果仅供参考')
                  .fontSize(13)
                  .fontColor($r('[ui_components].color.gray'))
                Button('重新查单')
                  .fontSize(13)
                  .height(32)
                  .onClick(() => this.checkOrderStatus())
              } else {
                Text(this.getStateHint())
                  .fontSize(13)
                  .fontColor($r('[ui_components].color.gray'))
              }
              Row({ space: 20 }) {
                Button('返回首页')
                  .backgroundColor($r('[ui_components].color.black'))
                  .fontSize(14)
                  .height(36)
                  .onClick(() => {
                    this.stackPath.popToIndex(-1)
                    this.stackPath.clear()
                  })
                Button('查看订单')
                  .fontSize(14)
                  .height(36)
                  .backgroundColor($r('[ui_components].color.white'))
                  .fontColor($r('[ui_components].color.black'))
                  .border({ width: 0.5, color: $r('[ui_components].color.border') })
                  .onClick(() => {
                    this.stackPath.pushPath({ name: PAGE_PATH.ORDER_PAGE, param: 0 })
                  })
              }
              .width('100%')
              .justifyContent(FlexAlign.Center)
            }
            .padding(40)
            .backgroundColor($r('[ui_components].color.under'))
          }

          ListItem() {
            HDMGuess()
              .height('100%')
          }
        }
        .layoutWeight(1)
        .height('100%')
        .width('100%')
        .scrollBar(BarState.Off)
      }
    }
    .hideTitleBar(true)
    .padding({
      top: this.topHeight
    })
  }
}
