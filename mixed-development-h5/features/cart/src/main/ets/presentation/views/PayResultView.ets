import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMGuess, HDMNavBar } from 'ui_components'
import { PayResultParams } from 'models'
import { demoOrderStore } from 'storage'
import { getOrderDetailAPI } from '../../data/api'
import { getOrderStateText, mergeOrderState } from '../utils/OrderPresentation'

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
  @State effectiveState: number = 0
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
      const overlay = demoOrderStore.getOverlay(this.orderId)
      const evaluation = demoOrderStore.getEvaluation(this.orderId)
      this.effectiveState = mergeOrderState(order, overlay, evaluation)
      const isPaid: boolean = this.effectiveState >= 2 && this.effectiveState <= 5
      this.payResult = isPaid || this.payResult
    } catch {
      const overlay = demoOrderStore.getOverlay(this.orderId)
      if (overlay && overlay.advancedState >= 2) {
        this.effectiveState = overlay.advancedState
        this.payResult = true
        this.checking = false
        return
      }
      this.checkFailed = true
    } finally {
      this.checking = false
    }
  }

  private getStateHint(): string {
    if (this.payResult) {
      if (this.effectiveState === 2) {
        return '支付成功，商家将尽快为你发货'
      }
      if (this.effectiveState === 3) {
        return '商家已发货，请留意物流信息'
      }
      if (this.effectiveState === 4) {
        return '快去评价，分享你的使用体验'
      }
      if (this.effectiveState === 5) {
        return '订单已完成，感谢你的支持'
      }
      return '支付成功'
    }
    if (this.effectiveState === 1) {
      return '订单尚未支付，可在订单页继续支付'
    }
    if (this.effectiveState === 6) {
      return '订单已取消'
    }
    return getOrderStateText(this.effectiveState)
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: this.checking ? '确认支付结果' : this.payResult ? '支付成功' : '未付款'
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
                  .fillColor(this.payResult ? '#07C160' : '#B0171F')
                Text(this.checkFailed ? '支付结果待确认' : (this.payResult ? '支付成功' : '未付款'))
                  .fontSize(20)
                  .fontWeight(600)
              }
              if (this.checking) {
                Text('正在确认支付结果…')
                  .fontSize(13)
                  .fontColor($r('[ui_components].color.gray'))
              } else if (this.checkFailed) {
                Text('网络开小差了，请稍后在订单列表查看状态')
                  .fontSize(13)
                  .fontColor($r('[ui_components].color.gray'))
                Button('重新查询')
                  .fontSize(13)
                  .height(32)
                  .onClick(() => this.checkOrderStatus())
              } else {
                Text(this.getStateHint())
                  .fontSize(13)
                  .fontColor($r('[ui_components].color.gray'))
              }
              Row({ space: 12 }) {
                Button('返回首页')
                  .backgroundColor($r('[ui_components].color.black'))
                  .fontSize(14)
                  .height(36)
                  .onClick(() => {
                    this.stackPath.popToIndex(-1)
                    this.stackPath.clear()
                  })
                Button(this.payResult ? '查看订单' : '去支付')
                  .fontSize(14)
                  .height(36)
                  .backgroundColor(this.payResult ? $r('[ui_components].color.white') : $r('[ui_components].color.red'))
                  .fontColor(this.payResult ? $r('[ui_components].color.black') : Color.White)
                  .border({ width: this.payResult ? 0.5 : 0, color: $r('[ui_components].color.border') })
                  .onClick(() => {
                    if (this.payResult) {
                      this.stackPath.pushPath({ name: PAGE_PATH.ORDER_PAGE, param: 0 })
                    } else {
                      this.stackPath.replacePath({ name: PAGE_PATH.PAY_PAGE, param: this.orderId })
                    }
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
