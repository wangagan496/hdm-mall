import { formatOrderCountdown } from '../utils/OrderPresentation'

/**
 * 待付款倒计时。
 * 计时器和每秒变化的剩余秒数都封装在组件内部，每秒只重绘这一个 Text；
 * 页面级 @State 每秒自增会让整页（订单卡片、图片、按钮）跟着重新渲染。
 */
@Component
export struct OrderCountdown {
  /** 服务端返回的剩余秒数 */
  countdown: number = 0
  /** 拿到 countdown 时的本地时间戳，按真实流逝时间换算剩余秒数 */
  baseAt: number = 0
  fontSize: number = 11
  /** 到期后显示的文案；为空则到期后不渲染任何内容 */
  expiredText: string = ''
  @State remaining: number = 0
  private timer: number = -1

  aboutToAppear(): void {
    this.tick()
    this.timer = setInterval(() => {
      this.tick()
    }, 1000)
  }

  aboutToDisappear(): void {
    if (this.timer !== -1) {
      clearInterval(this.timer)
      this.timer = -1
    }
  }

  private tick(): void {
    const elapsed: number = Math.floor((Date.now() - this.baseAt) / 1000)
    const next: number = Math.max(this.countdown - elapsed, 0)
    if (next !== this.remaining) {
      this.remaining = next
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
