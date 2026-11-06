import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMUser, PendingTradeInfo } from 'models'
import { HDMNavBar } from 'ui_components'
import { auth, localGoodsStore, storeManager } from 'storage'
import { authCart } from 'storage'
import { huaweiLoginAPI, loginAPI, registerAPI, isAuthNetworkError, isAuthRequestError } from '../../data/api'
import { LoginParams } from '../../domain/models'
import { loginComponentManager, LoginWithHuaweiIDButton } from '@kit.AccountKit'
import { BusinessError } from '@kit.BasicServicesKit'

@Component
export struct LoginView {
  @State
  loginForm: LoginParams = {
    account: '',
    password: ''
  }
  @State hasAcceptedTerms: boolean = false
  @State submitting: boolean = false
  @State isRegistrationMode: boolean = false
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

  hasAccountAndPassword(): boolean {
    return this.loginForm.account.length > 0 && this.loginForm.password.length > 0
  }

  async submitAccountLogin() {
    if (this.submitting) {
      return
    }
    if (!this.hasAcceptedTerms) {
      this.safeToast('请先勾选协议')
      return
    }
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(this.loginForm.account)) {
      this.safeToast('账号须为3～32位字母、数字或下划线')
      return
    }
    if (this.loginForm.password.length < 8 || this.loginForm.password.length > 128) {
      this.safeToast('密码长度须为8～128位')
      return
    }
    this.submitting = true
    try {
      // 注册入口先创建账号，再用同一份账号密码登录。
      if (this.isRegistrationMode) {
        await registerAPI(this.loginForm)
        this.isRegistrationMode = false
      }
      const user = await loginAPI(this.loginForm)
      await this.saveLoginAndRefreshCart(user)
      this.safeToast('登录成功')
      await this.finishLogin(user)
    } catch (error) {
      if (isAuthNetworkError(error as Error)) {
        this.safeToast(this.isRegistrationMode ? '注册时网络异常，请稍后重试' : '登录时网络异常，请稍后重试')
      } else if (!isAuthRequestError(error as Error)) {
        // 请求已成功但本地保存登录信息失败，拦截器不会提示，这里补一句。
        this.safeToast('登录信息保存失败，请重试')
      }
    } finally {
      this.submitting = false
    }
  }

  private async saveLoginAndRefreshCart(user: HDMUser): Promise<void> {
    // 先保存供下次启动恢复的资料，再更新当前页面使用的登录状态。
    await storeManager.saveUserInfo(user)
    if (storeManager.getUserInfo()?.token !== user.token) {
      throw new Error('登录状态已变化，请重新登录')
    }
    auth.updateCurrentUser(user)
    try {
      await localGoodsStore.migrateLegacyData()
    } catch {
      // 旧版全局收藏迁移失败不应把已经成功的登录回报为失败。
    }
    await authCart.updateCartCount()
  }

  private async finishLogin(user: HDMUser): Promise<void> {
    if (auth.getUserInfo()?.token !== user.token) return
    const paths = this.stackPath.getAllPathName()
    if (paths.length === 0 || paths[paths.length - 1] !== PAGE_PATH.LOGIN_PAGE) return
    this.stackPath.pop()
    if (GlobalVariable.DEMO_ORDER_FLOW || this.stackPath.getAllPathName().includes(PAGE_PATH.GOODS_PAGE)) return
    try {
      const raw: string = storeManager.getPendingTrade()
      if (raw) {
        const trade: PendingTradeInfo = JSON.parse(raw) as PendingTradeInfo
        if (trade.accountId === user.id && trade.entry && trade.created <= Date.now() && Date.now() - trade.created <= 30 * 60_000) {
          this.stackPath.pushPath({ name: PAGE_PATH.GOODS_PAGE, param: trade.entry })
        }
      }
    } catch { }
  }

  private async handleHuaweiLogin(
    error: BusinessError,
    response: loginComponentManager.HuaweiIDCredential
  ): Promise<void> {
    if (error) {
      if (error.code === 1001502012) {
        this.safeToast('已取消华为登录')
      } else if (error.code === 1001502003) {
        this.safeToast('华为登录配置无效：请核对 Client ID、包名和 Profile')
      } else {
        this.safeToast('华为登录失败，请检查账号服务配置')
      }
      return
    }
    const authorizationCode: string = response?.authorizationCode || ''
    if (!authorizationCode) {
      this.safeToast('未获取到华为授权码，请重试')
      return
    }
    if (this.submitting) {
      return
    }
    this.submitting = true
    try {
      const user = await huaweiLoginAPI({ code: authorizationCode })
      await this.saveLoginAndRefreshCart(user)
      this.safeToast('华为登录成功')
      await this.finishLogin(user)
    } catch {
      this.safeToast('华为登录换取商城账号失败，请稍后重试')
    } finally {
      this.submitting = false
    }
  }

  private updateHuaweiAgreementStatus(): void {
    this.huaweiController
      .setAgreementStatus(
        this.hasAcceptedTerms ? loginComponentManager.AgreementStatus.ACCEPTED : loginComponentManager.AgreementStatus.NOT_ACCEPTED
      )
      .setEnabled(this.hasAcceptedTerms)
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
              Text(this.isRegistrationMode ? '注册账号' : '账号密码登录')
                .fontSize(18)
                .fontColor($r('[ui_components].color.black'))
                .width('100%')
                .fontWeight(500)
                .margin({ bottom: 10 })
              TextInput({ placeholder: '账号：3～32位字母、数字或下划线', text: $$this.loginForm.account })
                .placeholderColor($r('[ui_components].color.gray'))
                .placeholderFont({ size: 14 })
                .form()
              TextInput({ placeholder: '请输入至少8位密码', text: $$this.loginForm.password })
                .type(InputType.Password)
                .showPasswordIcon(false)
                .placeholderColor($r('[ui_components].color.gray'))
                .placeholderFont({ size: 14 })
                .form()

              Row({ space: 4 }) {
                Checkbox()
                  .select(this.hasAcceptedTerms)
                  .width(12)
                  .aspectRatio(1)
                  .selectedColor($r('[ui_components].color.black'))
                  .mark({ size: 10, strokeWidth: 1 })
                  .onClick(() => {
                    this.hasAcceptedTerms = !this.hasAcceptedTerms
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

              Button(this.submitting ? '处理中...' : this.isRegistrationMode ? '注册并登录' : '登录')
                .backgroundColor($r('[ui_components].color.black'))
                .enabled(this.hasAccountAndPassword() && !this.submitting)
                .fontColor($r('[ui_components].color.white'))
                .form()
                .onClick(() => {
                  this.submitAccountLogin()
                })

              Row() {
                Blank()
                Text(this.isRegistrationMode ? '已有账号，去登录' : '没有账号，去注册')
                  .fontColor('#007DFB')
                  .fontSize(12)
                  .onClick(() => {
                    if (!this.submitting) {
                      this.isRegistrationMode = !this.isRegistrationMode
                    }
                  })
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
              .visibility(Visibility.None)
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
