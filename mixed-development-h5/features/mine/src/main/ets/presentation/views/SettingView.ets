import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMUser } from 'models'
import { userSession } from 'storage'
import { HDMNavBar, HDMCell, HDMCellGroup, HDMConfirm } from 'ui_components'


@Builder
function SettingsViewBuilder() {
  SettingsView()
}

@Component
export struct SettingsView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY)
  user: HDMUser = {} as HDMUser
  @Consume
  stackPath: NavPathStack
  @State showLogoutConfirm: boolean = false
  @State loggingOut: boolean = false

  @Builder
  LogoutConfirmBuilder() {
    HDMConfirm({
      message: '确定要退出账号吗',
      onConfirm: () => this.logoutAndCloseSettings(),
      onCancel: () => {
        if (!this.loggingOut) {
          this.showLogoutConfirm = false
        }
      }
    })
  }

  private async logoutAndCloseSettings(): Promise<void> {
    if (this.loggingOut) {
      return
    }
    this.loggingOut = true
    try {
      await userSession.logout()
      if (!userSession.serverLogoutConfirmed) {
        this.getUIContext().getPromptAction().showToast({ message: '本机已退出，服务端尚未确认注销' })
      }
      this.showLogoutConfirm = false
      this.stackPath.pop()
    } catch {
      this.getUIContext().getPromptAction().showToast({ message: '本机已退出，但登录资料清理失败，请重试' })
    } finally {
      this.loggingOut = false
    }
  }

  private openProfileEditor(): void {
    this.stackPath.pushPathByName('WebView', null)
  }

  @Builder
  ProfileBuilder() {
    RelativeContainer() {
      Image($r("[ui_components].media.ic_public_right"))
        .width(24)
        .aspectRatio(1)
        .fillColor($r("[ui_components].color.gray"))
        .alignRules({
          right: {
            anchor: '__container__',
            align: HorizontalAlign.End
          },
          center: {
            anchor: 'avatar',
            align: VerticalAlign.Center
          }
        })
      Image(this.user.avatar)
        .width(50)
        .aspectRatio(1)
        .borderRadius(25)
        .id("avatar")
      Column({ space: 4 }) {
        Text(this.user.nickname || this.user.account)
          .fontColor($r('[ui_components].color.black'))
          .fontWeight(500)
        Text('账号名：' + this.user.account)
          .fontColor($r('[ui_components].color.gray'))
          .fontSize(12)
      }
      .alignItems(HorizontalAlign.Start)
      .alignRules({
        left: {
          anchor: 'avatar',
          align: HorizontalAlign.End
        },
        center: {
          anchor: 'avatar',
          align: VerticalAlign.Center
        }
      })
      .margin({
        left: 8
      })
    }
    .width("100%")
    .height(80)
    .padding({ top: 16, bottom: 16 })
    .onClick(() => this.openProfileEditor())
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: '设置',
          onLeftClick: () => {
            // 点击返回
            this.stackPath.pop()
          }
        })
        Column({ space: 8 }) {
          HDMCellGroup() {
            // 个人资料入口：头像、昵称和账号
            this.ProfileBuilder()
          }

          HDMCellGroup() {
            HDMCell({
              title: '收货地址管理',
              onRightClick: () => this.stackPath.pushPathByName(PAGE_PATH.ADDRESS_PAGE, null)
            })
            // 以下设置目前只有展示入口，尚未配置操作。
            Text('账号安全、消息、隐私与通用设置暂未开放')
              .fontSize(12)
              .fontColor($r('[ui_components].color.gray'))
              .padding(16)
          }

          HDMCellGroup() {
            HDMCell({
              title: '退出登录', onRightClick: () => {
                this.showLogoutConfirm = true
              }
            })

          }
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('[ui_components].color.under'))
    }
    .hideTitleBar(true)
    .bindContentCover($$this.showLogoutConfirm, this.LogoutConfirmBuilder())
    .padding({
      top: this.topHeight
    })

  }
}
