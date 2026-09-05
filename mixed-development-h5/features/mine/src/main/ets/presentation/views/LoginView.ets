import { GlobalVariable } from 'constants'
import { HDMUser } from 'models'
import { HDMNavBar } from 'ui_components'
import { auth, localGoodsStore, storeManager } from 'storage'
import { authCart } from 'storage'
import { huaweiLoginAPI, loginAPI } from '../../data/api'
import { LoginParams } from '../../domain/models'
import { loginComponentManager, LoginWithHuaweiIDButton } from '@kit.AccountKit'
import { BusinessError } from '@ohos.base'

@Component
export struct LoginView {
  @State
  loginForm: LoginParams = {
    account: '',
    password: ''
  }
  @State valid: boolean = false
  @State agree: boolean = false
  @State submitting: boolean = false
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @Consume
  stackPath: NavPathStack

  private readonly huaweiController: loginComponentManager.LoginWithHuaweiIDButtonController =
    new loginComponentManager.LoginWithHuaweiIDButtonController()
      .setAgreementStatus(loginComponentManager.AgreementStatus.NOT_ACCEPTED)
      .setEnabled(false)
      .onClickLoginWithHuaweiIDButton((error: BusinessError, response: loginComponentManager.HuaweiIDCredential) => {
        this.handleHuaweiLogin(error, response)
      })

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  onInput() {
    return this.loginForm.account && this.loginForm.password ? true : false
  }

  async onSubmit() {
    if (this.submitting) {
      return
    }
    if (!this.agree) {
      this.safeToast('请先勾选协议')
      return
    }
    this.submitting = true
    try {
      const user = await loginAPI(this.loginForm)
      await this.completeLogin(user)
      this.safeToast('登录成功')
      this.stackPath.pop()
    } catch {
      this.safeToast('登录失败，请稍后重试')
    } finally {
      this.submitting = false
    }
  }

  private async completeLogin(user: HDMUser): Promise<void> {
    await storeManager.setUserInfo(user)
    auth.setUserInfo(user)
    try {
      await localGoodsStore.migrateLegacyData()
    } catch {
      // 旧版全局收藏迁移失败不应把已经成功的登录回报为失败。
    }
    await authCart.updateCartCount()
  }

  private async handleHuaweiLogin(
    error: BusinessError,
    response: loginComponentManager.HuaweiIDCredential
  ): Promise<void> {
    if (error) {
      if (error.code === 1001502012) {
        this.safeToast('已取消华为登录')
      } else {
        this.safeToast('华为登录失败，请检查账号服务配置')
      }
      return
    }
    const code: string = response?.authorizationCode || ''
    if (!code) {
      this.safeToast('未获取到华为授权码，请重试')
      return
    }
    if (this.submitting) {
      return
    }
    this.submitting = true
    try {
      const user = await huaweiLoginAPI({ code })
      await this.completeLogin(user)
      this.safeToast('华为登录成功')
      this.stackPath.pop()
    } catch {
      this.safeToast('华为登录换取商城账号失败，请稍后重试')
    } finally {
      this.submitting = false
    }
  }

  private updateHuaweiAgreementStatus(): void {
    this.huaweiController
      .setAgreementStatus(
        this.agree ? loginComponentManager.AgreementStatus.ACCEPTED : loginComponentManager.AgreementStatus.NOT_ACCEPTED
      )
      .setEnabled(this.agree)
  }

  @Styles
  form() {
    .width('100%')
    .height(42)
    .padding({
      left: 16,
      right: 16,
      top: 0,
      bottom: 0
    })
  }

  build() {
    NavDestination() {
      GridRow({
        columns: {
          sm: 4,
          md: 8,
          lg: 12
        }
      }) {
        GridCol({
          span: {
            sm: 4,
            md: 6,
            lg: 8
          },
          offset: {
            sm: 0,
            md: 1,
            lg: 2
          }
        }) {
          Column() {
            HDMNavBar({
              title: '惠多美商城登录',
              onLeftClick: () => {
                this.stackPath.pop()
              }
            })
            Column({ space: 16 }) {
              Text('账号密码登录')
                .fontSize(18)
                .fontColor($r('[ui_components].color.black'))
                .width('100%')
                .fontWeight(500)
                .margin({ bottom: 10 })
              TextInput({ placeholder: '请输入账号/手机号', text: $$this.loginForm.account })
                .placeholderColor($r('[ui_components].color.gray'))
                .placeholderFont({ size: 14 })
                .form()
              TextInput({ placeholder: '请输入密码', text: $$this.loginForm.password })
                .type(InputType.Password)
                .showPasswordIcon(false)
                .placeholderColor($r('[ui_components].color.gray'))
                .placeholderFont({ size: 14 })
                .form()

              Row({ space: 4 }) {
                Checkbox()
                  .select(this.agree)
                  .width(12)
                  .aspectRatio(1)
                  .selectedColor($r('[ui_components].color.black'))
                  .mark({ size: 10, strokeWidth: 1 })
                  .onClick(() => {
                    this.agree = !this.agree
                    this.updateHuaweiAgreementStatus()
                  })
                Text() {
                  Span('查看并同意')
                  Span('《隐私条款》')
                    .fontColor('#007DFB')
                  Span('和')
                  Span('《用户协议》')
                    .fontColor('#007DFB')
                }
                .width('100%')
                .fontSize(12)
                .fontColor($r('[ui_components].color.gray'))
              }

              Button('登录')
                .backgroundColor($r('[ui_components].color.black'))// .enabled(this.valid)
                .enabled(this.onInput() && !this.submitting)
                .fontColor($r('[ui_components].color.white'))
                .form()
                .onClick(() => {
                  this.onSubmit()
                })

              Row() {
                Blank()
                Text('忘记密码')
                  .fontColor('#007DFB')
                  .fontSize(12)
              }
              .width('100%')

              Column({ space: 16 }) {
                Stack() {
                  Text()
                    .width(200)
                    .height(1)
                    .backgroundColor($r('[ui_components].color.under'))
                  Text('其他登录方式')
                    .width(100)
                    .fontSize(12)
                    .backgroundColor($r('[ui_components].color.white'))
                    .fontColor($r('[ui_components].color.text'))
                    .textAlign(TextAlign.Center)
                }

                Row() {
                  LoginWithHuaweiIDButton({
                    params: {
                      style: loginComponentManager.Style.BUTTON_RED,
                      loginType: loginComponentManager.LoginType.ID,
                      supportDarkMode: true
                    },
                    controller: this.huaweiController
                  })
                    .width('100%')
                    .height(40)
                }
                .width('100%')
              }
              .margin({ top: 200 })
            }
            .padding(30)
          }
          .width('100%')
          .height('100%')
        }
      }

    }
    .padding({
      top: this.topHeight
    })
    .hideTitleBar(true)
  }
}

@Builder
function LoginViewBuilder() {
  LoginView()
}
