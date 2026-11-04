import { formatOrderCountdown, secondsLeftToPay } from '../utils/OrderPresentation'

/**
 * 待付款倒计时。
 * 计时器和每秒变化的剩余秒数都封装在组件内部，每秒只重绘这一个 Text；
 * 页面级 @State 每秒自增会让整页（订单卡片、图片、按钮）跟着重新渲染。
 */
@Component
export struct OrderCountdown {
  /** 服务端返回的剩余秒数 */
  @Prop @Watch('refreshRemaining') countdown: number = 0
  /** 拿到 countdown 那一刻读的手机时钟（readPhoneClockMillis），用来算已经过了多久 */
  @Prop @Watch('refreshRemaining') baseAt: number = 0
  fontSize: number = 11
  /** 到期后显示的文案；为空则到期后不渲染任何内容 */
  expiredText: string = ''
  /** 现在还剩几秒，页面显示的就是它 */
  @State remaining: number = 0
  /** 每秒执行一次的定时器编号；-1 表示没有定时器 */
  private timer: number = -1

  /** 倒计时出现在页面上：先算一次，再每秒重算。 */
  aboutToAppear(): void {
    this.refreshRemaining()
    this.timer = setInterval(() => {
      this.refreshRemaining()
    }, 1000)
  }

  /** 倒计时从页面上移除：必须停掉定时器，否则它会在后台一直空转，越积越多。 */
  aboutToDisappear(): void {
    if (this.timer !== -1) {
      clearInterval(this.timer)
      this.timer = -1
    }
  }

  /**
   * 按“现在 − 拿到订单的时间”重算剩余秒数，不是每秒减 1：
   * App 切到后台时定时器会暂停，每秒减 1 会越显示越多。
   */
  private refreshRemaining(): void {
    const remainingSeconds: number = secondsLeftToPay(this.countdown, this.baseAt)
    if (remainingSeconds !== this.remaining) {
      this.remaining = remainingSeconds
    }
  }

  build() {
    if (this.remaining > 0) {
      Text(formatOrderCountdown(this.remaining))
        .fontSize(this.fontSize)
        .fontColor($r('[ui_components].color.red'))
    } else if (this.expiredText) {
      Text(this.expiredText)
        .fontSize(this.fontSize)
        .fontColor($r('[ui_components].color.gray'))
    }
  }
}
