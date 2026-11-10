import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMUser, PendingTradeInfo } from 'models'
import { HDMNavBar } from 'ui_components'
import { auth, localGoodsStore, storeManager, consentManager, deviceFixturePassword } from 'storage'
import { authCart } from 'storage'
import { huaweiLoginAPI, loginAPI, registerAPI, isAuthNetworkError, isAuthRequestError } from '../../data/api'
import { LoginParams } from '../../domain/models'
import { loginComponentManager, LoginWithHuaweiIDButton } from '@kit.AccountKit'
import { BusinessError } from '@kit.BasicServicesKit'
import { util } from '@kit.ArkTS'

@Component
export struct LoginView {
  @State
  loginForm: LoginParams = {
    account: '',
    password: ''
  }
  @State hasAcceptedTerms: boolean = false
  @State consentAlreadyAccepted: boolean = false
  @State termsError: boolean = false
  @State documentTitle: string = ''
  @State documentText: string = ''
  private documentGeneration: number = 0
  private agreementScroller: Scroller | undefined = undefined
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
      this.showTermsError()
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
    await consentManager.report(user.token, user.id || '')
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
    if (user.status === 'deleting') { this.stackPath.pushPath({ name: 'AccountDeletionView' }); return }
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

  aboutToAppear():void {
    this.agreementScroller=new Scroller()
    this.consentAlreadyAccepted=consentManager.accepted()
    this.hasAcceptedTerms=this.consentAlreadyAccepted
    this.updateHuaweiAgreementStatus()
    if(!this.hasAcceptedTerms)void this.requestLoginConsent()
  }
  private async requestLoginConsent():Promise<void> {
    try {
      this.hasAcceptedTerms=await consentManager.request(this.getUIContext(),'login')
      this.consentAlreadyAccepted=this.hasAcceptedTerms
      this.updateHuaweiAgreementStatus()
      if(!this.hasAcceptedTerms)this.stackPath.pop()
    }catch {this.safeToast('同意记录保存失败，请重试')}
  }
  private async fillFixtureForm(account: string): Promise<void> {
    const password = await deviceFixturePassword(account)
    if (password && this.loginForm.account === account && !this.submitting) this.loginForm.password = password
  }
  aboutToDisappear():void {this.closeAgreement();this.loginForm.password=''}
  private showTermsError():void {this.termsError=true;this.agreementScroller?.scrollEdge(Edge.Bottom)}
  private toggleTerms():void {
    if(this.submitting||this.consentAlreadyAccepted)return
    this.hasAcceptedTerms=!this.hasAcceptedTerms;this.termsError=false;this.updateHuaweiAgreementStatus()
    void (this.hasAcceptedTerms?consentManager.accept('login'):consentManager.clear()).catch(()=>{this.hasAcceptedTerms=false;this.safeToast('同意记录保存失败，请重试')})
  }
  private async openAgreement(kind:string):Promise<void> {
    const generation=++this.documentGeneration
    this.documentTitle=kind==='privacy'?'隐私政策':'用户协议';this.documentText='正在打开正文'
    try {
      const bytes=await this.getUIContext().getHostContext()!.resourceManager.getRawFileContent(kind==='privacy'?'privacy-policy.txt':'user-agreement.txt')
      if(generation===this.documentGeneration)this.documentText=util.TextDecoder.create('utf-8').decodeToString(bytes)
    }catch {if(generation===this.documentGeneration)this.documentText='正文暂时无法打开，请返回后重试'}
  }
  private closeAgreement():void {this.documentGeneration++;this.documentTitle='';this.documentText=''}

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
      if(this.documentTitle) {
        Column() {
          HDMNavBar({title:this.documentTitle,onLeftClick:()=>this.closeAgreement()})
          Scroll() {Text(this.documentText).id('agreement-body').width('100%').fontSize(16).fontColor($r('[ui_components].color.text')).padding(20)}.layoutWeight(1).width('100%')
        }.height('100%').width('100%').backgroundColor($r('[ui_components].color.white'))
      } else {
      Scroll(this.agreementScroller) {
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
                .onChange((value: string) => { this.loginForm.account = value; void this.fillFixtureForm(value) })
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
                if (!this.consentAlreadyAccepted) {
                Checkbox()
                  .select(this.hasAcceptedTerms)
                  .width(24)
                  .aspectRatio(1)
                  .selectedColor($r('[ui_components].color.black'))
                  .mark({ size: 10, strokeWidth: 1 })
                  .onClick(() => {
                    this.toggleTerms()
                  })
                }
                Text() {
                  Span(this.consentAlreadyAccepted ? '已同意' : '查看并同意')
                  Span('《隐私政策》')
                    .fontColor('#007DFB')
                    .onClick(()=>this.openAgreement('privacy'))
                  Span('和')
                  Span('《用户协议》')
                    .fontColor('#007DFB')
                    .onClick(()=>this.openAgreement('terms'))
                }
                .layoutWeight(1)
                .fontSize(14)
                .fontColor($r('[ui_components].color.gray'))
              }.id('terms-row').width('100%').constraintSize({minHeight:44}).padding(6)
                .border({width:this.termsError?1:0,color:$r('[ui_components].color.red')}).borderRadius(8).onClick(()=>this.toggleTerms())
              if(this.termsError){Text('请先阅读并勾选协议').id('terms-error').fontSize(14).fontColor($r('[ui_components].color.red')).width('100%')}

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
        }
      }
      }.width('100%').height('100%')
      }
    }
    .padding({
      top: this.topHeight
    })
    .hideTitleBar(true)
    .onBackPressed(()=>{if(this.documentTitle){this.closeAgreement();return true}return false})
  }
}

@Builder
function LoginViewBuilder() {
  LoginView()
}
