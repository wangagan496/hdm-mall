import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMUser } from 'models'
import { HDMGuess, HDMNavCol } from 'ui_components'


@Component
export struct MineView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  safeTop: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY)
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

  private showUnavailableFeature(name: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({
        message: `${name}功能正在完善中`
      })
    } catch {
      return
    }
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
                HDMNavCol({
                  icon: $r('app.media.ic_user_service'),
                  text: '我的客服',
                  color: $r('[ui_components].color.text'),
                  onNavClick: () => {
                    this.stackPath.pushPath({ name: PAGE_PATH.CUSTOMER_SERVICE_PAGE })
                  }
                })
              }
            }
            .width('100%')
            .linearGradient({
              angle: 180,
              colors: [['#FFF1E5', 0], [$r('[ui_components].color.white'), 0.15], [$r('[ui_components].color.white'), 1]]
            })
            .borderRadius(10)

            Column() {
              Text('我的订单')
                .fontSize(14)
                .width('100%')
                .padding({ left: 8, top: 8 })
                .lineHeight(22)
                .fontWeight(500)
                .fontColor($r('[ui_components].color.black'))
              GridRow({ columns: 5 }) {
                GridCol() {
                  HDMNavCol({
                    icon: $r('app.media.ic_user_order'),
                    text: '全部订单',
                    onNavClick: () => this.showUnavailableFeature('全部订单')
                  })
                }

                GridCol() {
                  HDMNavCol({
                    icon: $r('app.media.ic_user_obligation'),
                    text: '待付款',
                    onNavClick: () => this.showUnavailableFeature('待付款')
                  })
                }

                GridCol() {
                  HDMNavCol({
                    icon: $r('app.media.ic_user_unreceived'),
                    text: '待发货',
                    onNavClick: () => this.showUnavailableFeature('待发货')
                  })
                }

                GridCol() {
                  HDMNavCol({
                    icon: $r('app.media.ic_user_unshipped'),
                    text: '待收货',
                    onNavClick: () => this.showUnavailableFeature('待收货')
                  })
                }

                GridCol() {
                  HDMNavCol({
                    icon: $r('app.media.ic_user_unevaluated'),
                    text: '待评价',
                    onNavClick: () => this.showUnavailableFeature('待评价')
                  })
                }
              }
              .width('100%')
            }
            .backgroundColor($r('[ui_components].color.white'))
            .borderRadius(10)
          }
          .padding({ left: 8, right: 8 })

          HDMGuess()
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
  }
}
