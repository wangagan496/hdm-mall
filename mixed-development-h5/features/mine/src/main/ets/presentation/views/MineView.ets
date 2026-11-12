import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMUser } from 'models'
import { HDMGuess, HDMNavCol } from 'ui_components'
import { getGuessLikeAPI, getOrderAttentionCountAPI } from '../../data/api'
import { RequestAxios } from 'network'

interface AccountNotice { id: string; message: string; created: number }
interface ServiceUnread { count: number }

@Component
export struct MineView {
  @StorageProp('privacyConsentAccepted') privacyConsentAccepted: boolean = false
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  safeTop: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('reloadAttentionForAccount')
  // user: HDMUser = {} as HDMUser
  // user: Partial<HDMUser> = {}
  user: HDMUser = {
    avatar: '',
    token: '',
    nickname: "",
    account: ""
  }
  @Consume
  stackPath: NavPathStack
  @State attentionCount: number = 0
  @State serviceUnread: number = 0
  @State accountNotice: string = ''
  private attentionVisible: boolean = false
  private attentionToken: string = ''
  private attentionSequence: number = 0

  aboutToAppear(): void {
    this.attentionVisible = true
    this.refreshOrderAttention()
  }

  aboutToDisappear(): void {
    this.setAttentionVisible(false)
  }

  private setAttentionVisible(visible: boolean): void {
    if (this.attentionVisible === visible) return
    this.attentionVisible = visible
    this.attentionSequence++
    if (visible) this.refreshOrderAttention()
  }

  private reloadAttentionForAccount(): void {
    this.attentionToken = ''
    this.attentionSequence++
    this.attentionCount = 0
    this.serviceUnread = 0
    this.refreshOrderAttention()
  }

  private refreshAttentionOnOrdersReturn(): void {
    this.attentionVisible = true
    this.refreshOrderAttention()
  }

  private async refreshOrderAttention(): Promise<void> {
    const token: string = this.user.token || ''
    const sequence: number = ++this.attentionSequence
    this.attentionToken = token
    void this.refreshAccountNotice(token, sequence)
    void this.refreshServiceUnread(token, sequence)
    if (!token || !this.attentionVisible) {
      this.attentionCount = 0
      return
    }
    try {
      const result = await getOrderAttentionCountAPI(token)
      if (sequence === this.attentionSequence && token === this.attentionToken && token === (this.user.token || '')) {
        this.attentionCount = result.count
      }
    } catch {
      if (sequence === this.attentionSequence && token === this.attentionToken) this.attentionCount = 0
    }
  }

  private async refreshAccountNotice(token: string, sequence: number): Promise<void> {
    if (!token) { this.accountNotice = ''; return }
    try {
      const notices = await RequestAxios.getForSession<AccountNotice[]>('/member/account-notices', token)
      if (sequence === this.attentionSequence && token === this.user.token) this.accountNotice = notices.length ? notices[0].message : ''
    } catch { }
  }

  private async refreshServiceUnread(token: string, sequence: number): Promise<void> {
    if (!token || !this.attentionVisible || this.user.role === 'merchant') { this.serviceUnread = 0; return }
    try {
      const result = await RequestAxios.getForSession<ServiceUnread>('/member/service/unread', token)
      if (this.attentionVisible && sequence === this.attentionSequence && token === this.attentionToken && token === this.user.token) this.serviceUnread = result.count
    } catch { }
  }

  private openService(): void {
    if (!this.user.token) { this.stackPath.pushPath({ name: PAGE_PATH.LOGIN_PAGE }); return }
    this.stackPath.pushPath({ name: this.user.role === 'merchant' ? 'MerchantServiceView' : PAGE_PATH.CUSTOMER_SERVICE_PAGE,
      onPop: () => this.refreshAttentionOnOrdersReturn() })
  }

  private openOrders(orderState: number): void {
    if (!this.user.token) {
      this.stackPath.pushPath({ name: PAGE_PATH.LOGIN_PAGE })
      return
    }
    this.refreshOrderAttention()
    this.stackPath.pushPath({
      name: PAGE_PATH.ORDER_PAGE,
      param: orderState,
      onPop: () => this.refreshAttentionOnOrdersReturn()
    })
  }

  // @StorageProp(auth.KEY) user: MkUser = {} as MkUser
  build() {
    Column() {
      Scroll() {
        Column() {
          // header
          Column() {
            Row() {
              Blank()
              if (this.user.token) {
                Image($r('[ui_components].media.ic_public_settings'))
                  .width(24)
                  .aspectRatio(1)
                  .focusable(true)
                  .accessibilityText('设置')
                  .onClick(() => {
                    this.stackPath.pushPath({
                      name: PAGE_PATH.SETTINGS_PAGE
                    })
                  })
              }
            }
            .width('100%')
            .height(50)


            Row({ space: 16 }) {
              // 头像
              Image(this.user.avatar || $r('app.media.ic_user_avatar'))
                .width(40)
                .aspectRatio(1)
                .borderRadius(20)
              if (this.user.token) {
                Text(this.user.nickname || this.user.account)
                  .fontColor($r('[ui_components].color.black'))
                  .fontWeight(500)
                Blank()
                Text('编辑资料')
                  .fontSize(12)
                  .fontColor($r('[ui_components].color.gray'))
                Image($r('[ui_components].media.ic_public_right'))
                  .width(20)
                  .aspectRatio(1)
                  .fillColor($r('[ui_components].color.gray'))
              } else {
                Text('立即登录')
                  .fontColor($r('[ui_components].color.black'))
                  .fontWeight(500)
              }
            }
            .width('100%')
            .height(72)
            .focusable(true)
            .accessibilityText(this.user.token ? '头像和个人资料，点击编辑' : '头像，点击登录')
            .onClick(() => {
              if (this.user.token) {
                this.stackPath.pushPathByName('WebView', null)
              } else {
                this.stackPath.pushPath({
                  name: PAGE_PATH.LOGIN_PAGE
                })
              }
            })

            if (!this.user.token && !this.privacyConsentAccepted) {
              Text('你还未同意协议，同意后可登录').fontSize(13).padding(8)
                .onClick(() => this.stackPath.pushPath({ name: PAGE_PATH.LOGIN_PAGE }))
            }

            Row({ space: 8 }) {
              Image($r('app.media.ic_user_vip'))
                .width(24)
                .aspectRatio(1)
              Text('升级惠多美商城会员，尊享无限免邮')
                .fontSize(12)
                .fontColor('#7E2C1A')
                .layoutWeight(1)
              Button('立即开通')
                .width(64)
                .height(24)
                .fontSize(10)
                .padding(0)
                .backgroundColor('#7E2C1A')
                .fontColor(Color.White)
            }
            .padding({ left: 8, right: 8 })
            .width('100%')
            .height(40)
            .borderRadius({ topLeft: 10, topRight: 10 })
            .linearGradient({
              angle: 110,
              colors: [['#F9D8AB', 0], ['#F9E3CC', 1]]
            })

          }
          .padding({ left: 16, right: 16, top: this.safeTop })
          .linearGradient({
            angle: 180,
            colors: [['#FFF1E5', 0], [$r('[ui_components].color.under'), 1]]
          })

          if (this.user.role === 'merchant') {
            Button('客服留言').id('merchant-service-entry').margin({ top: 12 }).backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).onClick(() => this.openService())
            Button('满减设置').margin({ top: 12 }).id('merchant-promotion-entry').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')})
              .onClick(() => this.stackPath.pushPath({ name: 'PromotionSettingView' }))
            Button('操作记录').margin({ top: 12 }).id('merchant-audit-entry')
              .backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red'))
              .onClick(() => this.stackPath.pushPath({ name: 'AuditLogView' }))
            Button('库存管理').margin({ top: 12 })
              .backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red'))
              .onClick(() => this.stackPath.pushPath({ name: PAGE_PATH.INVENTORY_PAGE }))
            Button('商品管理').margin({ top: 12 })
              .backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red'))
              .onClick(() => this.stackPath.pushPath({ name: PAGE_PATH.PRODUCT_MANAGE_PAGE }))
            Button($r('app.string.after_sale_manage')).margin({ top: 12 })
              .backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red'))
              .onClick(() => this.stackPath.pushPath({ name: PAGE_PATH.AFTER_SALE_MANAGE_PAGE }))
          }
          if (this.user.status === 'deleting') {
            Button('账号注销处理中 · 查看进度或撤销').fontSize(14)
              .backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red'))
              .onClick(() => this.stackPath.pushPath({ name: 'AccountDeletionView' }))
          }
          if (this.accountNotice && this.user.token) { Text(this.accountNotice).fontSize(14).padding(12).width('100%') }
          Button(this.user.role === 'merchant' ? '亲友中心 / 商家发货' : '亲友中心 · 代付与代收')
            .backgroundColor($r('[ui_components].color.red')).fontColor(Color.White)
            .margin({ top: 12, bottom: 12 })
            .onClick(() => {
              this.stackPath.pushPath({ name: this.user.token ? PAGE_PATH.FAMILY_PAGE : PAGE_PATH.LOGIN_PAGE })
            })
          // nav
          Column({ space: 8 }) {
            GridRow({ columns: 3 }) {
              GridCol() {
                HDMNavCol({
                  icon: $r('app.media.ic_user_collect'),
                  text: '我的收藏',
                  color: $r('[ui_components].color.text'),
                  onNavClick: () => {
                    this.stackPath.pushPath({ name: PAGE_PATH.FAVORITES_PAGE })
                  }
                })
              }

              GridCol() {
                HDMNavCol({
                  icon: $r('app.media.ic_user_history'),
                  text: '我的足迹',
                  color: $r('[ui_components].color.text'),
                  onNavClick: () => {
                    this.stackPath.pushPath({ name: PAGE_PATH.HISTORY_PAGE })
                  }
                })
              }

              GridCol() {
                Column() {
                HDMNavCol({
                  icon: $r('app.media.ic_user_service'),
                  text: '我的客服',
                  color: $r('[ui_components].color.text'),
                  onNavClick: () => {
                    this.openService()
                  }
                })
                if (this.serviceUnread > 0) { Text('● 有新回复').id('service-unread').fontSize(12).fontColor($r('[ui_components].color.red')) }
                }
              }
            }
            .width('100%')
            .linearGradient({
              angle: 180,
              colors: [['#FFF1E5', 0], [$r('[ui_components].color.white'), 0.15], [$r('[ui_components].color.white'), 1]]
            })
            .borderRadius(10)

            Column() {
              Row() {
                Text('我的订单')
                  .fontSize(14)
                  .layoutWeight(1)
                  .lineHeight(22)
                  .fontWeight(500)
                  .fontColor($r('[ui_components].color.black'))
                if (this.attentionCount > 0) {
                  Text('●').fontSize(10).fontColor('#D93025')
                }
              }
              .width('100%')
              .padding({ left: 8, right: 8, top: 8 })
              GridRow({ columns: 5 }) {
                GridCol() {
                  HDMNavCol({
                    icon: $r('app.media.ic_user_order'),
                    text: '全部订单',
                    onNavClick: () => this.openOrders(0)
                  })
                }

                GridCol() {
                  HDMNavCol({
                    icon: $r('app.media.ic_user_obligation'),
                    text: '待付款',
                    onNavClick: () => this.openOrders(1)
                  })
                }

                GridCol() {
                  HDMNavCol({
                    icon: $r('app.media.ic_user_unreceived'),
                    text: '待发货',
                    onNavClick: () => this.openOrders(2)
                  })
                }

                GridCol() {
                  HDMNavCol({
                    icon: $r('app.media.ic_user_unshipped'),
                    text: '待收货',
                    onNavClick: () => this.openOrders(3)
                  })
                }

                GridCol() {
                  HDMNavCol({
                    icon: $r('app.media.ic_user_unevaluated'),
                    text: '待评价',
                    onNavClick: () => this.openOrders(4)
                  })
                }
              }
              .width('100%')
            }
            .backgroundColor($r('[ui_components].color.white'))
            .borderRadius(10)
          }
          .padding({ left: 8, right: 8 })

          HDMGuess({ loader: getGuessLikeAPI })
            .margin({
              top: 10,
              bottom: 10
            })
        }
      }
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('[ui_components].color.under'))
    .onVisibleAreaChange([0.0], (visible: boolean) => this.setAttentionVisible(visible))
  }
}
