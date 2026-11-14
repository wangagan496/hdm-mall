import { webview } from '@kit.ArkWeb'

// 独立控制器，不注册账号、文件或设备能力桥接，也不传递应用 token。
@Component
export struct SandboxCashier {
  @Prop checkoutUrl: string = ''
  onClose: () => void = () => {}
  private controller: webview.WebviewController = new webview.WebviewController()
  @State blocked: boolean = false

  private allowsNavigation(value: string): boolean {
    // 只允许支付宝 HTTPS 网页；自定义协议/外部应用跳转留待真实兼容性验收。
    return /^https:\/\/([a-z0-9-]+\.)*(alipay\.com|alipaydev\.com)(?::443)?(?:[/?#]|$)/i.test(value)
  }

  build() {
    Column({ space: 8 }) {
      Text('沙箱测试，不会真实扣款').fontSize(16).fontWeight(600).id('sandbox-payment-notice')
      Text('请使用沙箱买家账号；页面返回不代表付款成功。').fontSize(12)
      if (this.blocked) {
        Text('该付款跳转暂不支持，请关闭收银台并核对结果。').fontSize(14)
      }
      Web({ src: this.checkoutUrl, controller: this.controller })
        .javaScriptAccess(true)
        .fileAccess(false)
        .domStorageAccess(true)
        .mixedMode(MixedMode.None)
        .onLoadIntercept((event) => {
          if (!event) return true
          const blocked: boolean = !this.allowsNavigation(event.data.getRequestUrl())
          if (blocked) this.blocked = true
          return blocked
        })
        .layoutWeight(1)
      Button('关闭并核对付款结果').id('sandbox-close-cashier').onClick(() => this.onClose())
        .backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary'))
    }.width('100%').layoutWeight(1).padding(12)
  }
}
