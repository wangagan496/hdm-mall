import { GlobalVariable } from 'constants'
import { HDMUser } from 'models'
import { auth, storeManager, userSession } from 'storage'
import { cameraPlugin, locationPlugin, photoPlugin, sensorPlugin } from 'device'
import { common } from '@kit.AbilityKit'
import { webview } from '@kit.ArkWeb'
import { mergeBridgeUser } from './userBridgePresentation'

// 网页通过 window.nativeApp 调用这里提供的 App 能力。
const BRIDGE_NAME: string = 'nativeApp'
// 只允许 App 自带的本地网页调用这些鸿蒙方法。
const LOCAL_PAGES_ONLY: string =
  '{"javascriptProxyPermission":{"urlPermissionList":' +
    '[{"scheme":"resource","host":"rawfile","port":"","path":""}],"methodList":[]}}'

class HDMWebBridge {
  hasUnsavedProfile: boolean = false
  unsavedProfileReason: string = ''
  profileDraftRetained: boolean = false
  private flushId: number = 0
  private flushToken: string = ''
  private flushCallback: ((saved: boolean) => void) | undefined = undefined

  beginProfileFlush(id: number, token: string, callback: (saved: boolean) => void): void {
    this.flushId = id
    this.flushToken = token
    this.profileDraftRetained = false
    this.flushCallback = callback
  }

  cancelProfileFlush(): void { this.flushCallback = undefined }

  setProfileDraftRetained(token: string, retained: boolean): void {
    if (token && token === this.flushToken && auth.getUserInfo()?.token === token) this.profileDraftRetained = retained
  }

  completeProfileFlush(id: number, token: string, saved: boolean): void {
    if (id !== this.flushId || !token || token !== this.flushToken || auth.getUserInfo()?.token !== token) return
    const callback = this.flushCallback
    this.flushCallback = undefined
    if (saved) this.hasUnsavedProfile = false
    callback?.(saved)
  }

  setProfileDirty(dirty: boolean, token: string, reason?: string): void {
    if (token && auth.getUserInfo()?.token === token) {
      this.hasUnsavedProfile = dirty
      this.unsavedProfileReason = dirty ? (reason || '') : ''
    }
  }

  async expireSession(token: string): Promise<boolean> {
    const expired: boolean = await userSession.expireSession(token)
    if (expired) {
      this.hasUnsavedProfile = false
    }
    return expired
  }
  getApiBaseUrl(): string {
    return GlobalVariable.BASE_URL
  }
  private getContext(): common.UIAbilityContext {
    const context = AppStorage.get<common.UIAbilityContext>(GlobalVariable.ABILITY_CONTEXT_KEY)
    if (!context) {
      throw new Error('HDMWebBridge: UIAbilityContext 未初始化')
    }
    return context
  }

  // 网页通过 window.nativeApp.getUser() 调用此方法。
  getUser(): HDMUser | undefined {
    // 读取 App 保存的当前登录用户。
    const appUser: HDMUser | undefined = auth.getUserInfo()
    // 将读取结果返回给调用此方法的网页。
    return appUser
  }

  async updateUser(webUser: HDMUser): Promise<void> {
    const currentAppUser: HDMUser | undefined = auth.getUserInfo()
    const updatedAppUser: HDMUser = mergeBridgeUser(currentAppUser, webUser)
    // 保存到手机本地，下次启动 App 时还能恢复这份用户资料。
    await storeManager.saveProfileForSession(updatedAppUser, currentAppUser?.token || '')
    if (auth.getUserInfo()?.token !== currentAppUser?.token ||
      storeManager.getUserInfo()?.token !== currentAppUser?.token) {
      throw new Error('登录状态已变化，请重新打开资料页')
    }
    // 更新 App 当前运行中的用户资料，让已打开的页面也能读到新值。
    auth.updateCurrentUser(updatedAppUser)
  }

  async removeUser(): Promise<void> {
    await userSession.logout()
  }

  pickerCamera(): Promise<string> {
    return cameraPlugin.pickerCamera(this.getContext())
  }

  pickerPhoto(): Promise<string> {
    return photoPlugin.pickerPhoto()
  }

  vibrator(): void {
    sensorPlugin.vibrate()
  }

  getAreaColumns(): string {
    return locationPlugin.getAreaColumns(this.getContext())
  }
}

@Builder
function WebViewBuilder() {
  WebView()
}

@Component
struct WebView {
  // 网页开始加载时显示进度条，进度达到 100 后隐藏。
  @State isPageLoading: boolean = true
  // 进度
  @State pageLoadProgress: number = 0
  @Consume
  stackPath: NavPathStack
  // 当前网页的标题
  @State title: string = '惠多美'
  // 从本地存储中获取顶部安全距离
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  // 发布包加载随应用交付的 H5，避免依赖局域网开发服务器。
  src = $rawfile('index.html')

  // 页面视图控制器
  controller = new webview.WebviewController()
  private readonly bridgeObject: HDMWebBridge = new HDMWebBridge()
  // 大于 0 表示网页内部还有上一页；否则返回鸿蒙页面。
  @State webHistoryIndex: number = 0
  private leaveSequence: number = 0
  private leaving: boolean = false
  private leaveTimer: number = -1

  goBackOrCloseWebPage() {
    this.confirmLeave(() => this.goBackNow())
  }

  private confirmLeave(action: () => void): void {
    if (this.leaving) return
    if (!this.bridgeObject.hasUnsavedProfile) {
      action()
      return
    }
    const token: string = auth.getUserInfo()?.token || ''
    const sequence: number = ++this.leaveSequence
    this.leaving = true
    const finish = (saved: boolean): void => {
      if (sequence !== this.leaveSequence || auth.getUserInfo()?.token !== token) return
      if (this.leaveTimer !== -1) clearTimeout(this.leaveTimer)
      this.leaveTimer = -1
      this.bridgeObject.cancelProfileFlush()
      this.leaving = false
      if (saved) { action(); return }
      this.showRetainedDraftDialog(action, sequence, token)
    }
    this.bridgeObject.beginProfileFlush(sequence, token, finish)
    this.leaveTimer = setTimeout(() => finish(false), 3000)
    try {
      this.controller.runJavaScript(`window.dispatchEvent(new CustomEvent('native-profile-flush',{detail:${sequence}}))`)
        .catch(() => finish(false))
    } catch { finish(false) }
  }

  private showRetainedDraftDialog(action: () => void, sequence: number, token: string): void {
    this.getUIContext().showAlertDialog({
      title: '还有未保存的资料',
      message: this.bridgeObject.profileDraftRetained ? '本次输入已保留为本机草稿，下次打开可继续编辑。' :
        '暂时未能保留草稿，请继续编辑并重试保存。',
      primaryButton: { value: '继续编辑', action: () => {} },
      secondaryButton: { value: this.bridgeObject.profileDraftRetained ? '保留草稿退出' : '继续编辑', action: () => {
        if (sequence !== this.leaveSequence || auth.getUserInfo()?.token !== token || !this.bridgeObject.profileDraftRetained) return
        this.bridgeObject.hasUnsavedProfile = false
        this.leaveSequence++
        action()
      } }
    })
  }

  private goBackNow(): void {
    if (this.webHistoryIndex > 0) {
      try {
        this.controller.backward()
      } catch {
        this.stackPath.pop()
      }
    } else {
      this.stackPath.pop()
    }
  }

  // 菜单直达 Tab：先弹回 Tabs 根页面，再复用 CartView 空态同款 SWITCH_TAB 事件切 Tab。
  private switchToTab(tabIndex: number): void {
    this.confirmLeave(() => this.switchToTabNow(tabIndex))
  }

  private switchToTabNow(tabIndex: number): void {
    try {
      this.stackPath.popToIndex(-1)
    } catch {
    }
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext
    context.eventHub.emit(GlobalVariable.SWITCH_TAB, tabIndex)
  }

  aboutToDisappear(): void {
    this.leaveSequence++
    this.leaving = false
    if (this.leaveTimer !== -1) clearTimeout(this.leaveTimer)
    this.leaveTimer = -1
    this.bridgeObject.cancelProfileFlush()
    try {
      this.controller.deleteJavaScriptRegister(BRIDGE_NAME)
    } catch {
      // Web 组件尚未完成挂载或已释放时无需重复注销。
    }
  }

  build() {
    NavDestination() {
      Column() {
        // 导航条
        Row() {
          Row() {
            Image($r("[ui_components].media.ic_public_left"))
              .iconStyle()
              .onClick(() => {
                this.goBackOrCloseWebPage()
              })
            Image($r('[ui_components].media.ic_public_close'))
              .iconStyle()
              .onClick(() => {
                this.confirmLeave(() => this.stackPath.pop())
              })

          }
          .width(100)

          Text(this.title)
            .fontSize(16)
            .fontWeight(500)
            .fontColor($r('[ui_components].color.black'))
            .layoutWeight(1)
            .maxLines(1)
            .textAlign(TextAlign.Center)
            .textOverflow({ overflow: TextOverflow.MARQUEE })
          Row() {
            Blank()
            Image($r('[ui_components].media.ic_public_more'))
              .iconStyle()
              .bindMenu(this.MenuBuilder)
          }
          .width(100)
        }
        .height(50 + this.safeTop)
        .backgroundColor($r('[ui_components].color.white'))
        .padding({ top: this.safeTop })

        Stack({ alignContent: Alignment.Top }) {
          if (this.isPageLoading) {
            Progress({ type: ProgressType.Linear, value: this.pageLoadProgress, total: 100 })
              .style({ strokeWidth: 2, enableSmoothEffect: true })
              .color($r('[ui_components].color.red'))
              .zIndex(1)
          }
          Web({ src: this.src, controller: this.controller })
            .javaScriptProxy({
              object: this.bridgeObject,
              name: BRIDGE_NAME,
              methodList: [
                'getUser', 'vibrator', 'getAreaColumns', 'getApiBaseUrl',
                'updateUser', 'removeUser', 'pickerCamera', 'pickerPhoto', 'expireSession', 'setProfileDirty',
                'setProfileDraftRetained', 'completeProfileFlush'
              ],
              controller: this.controller,
              asyncMethodList: [],
              // permission 是鸿蒙固定字段，右侧指定允许调用的网页范围。
              permission: LOCAL_PAGES_ONLY
            })
            .onProgressChange((data) => {
              //  加载进度变化时记录pageLoadProgress
              this.pageLoadProgress = data.newProgress
              //  加载完成 newProgress ===100
              if (data.newProgress === 100) {
                this.isPageLoading = false
              }
            })
            // onPageBegin  网页开始加载
            .onPageBegin(() => {
              this.isPageLoading = true
              this.pageLoadProgress = 0
            })
            // 导航完成时触发该回调，用于应用更新其访问的历史链接。
            .onRefreshAccessedHistory(() => {
              const entries = this.controller.getBackForwardEntries()
              this.webHistoryIndex = entries.currentIndex
            })
            .onTitleReceive((data) => {
              this.title = data.title
            })
        }
        .width('100%')
        .layoutWeight(1)
      }
    }
    .hideTitleBar(true)
    .onBackPressed(() => {
      this.goBackOrCloseWebPage()
      return true
    })
  }

  @Builder
  MenuBuilder() {
    Menu() {
      MenuItem({ content: '首页' })
        .onClick(() => {
          this.switchToTab(0)
        })
      MenuItem({ content: '分类' })
        .onClick(() => {
          this.switchToTab(1)
        })
      MenuItem({ content: '购物袋' })
        .onClick(() => {
          this.switchToTab(2)
        })
      MenuItem({ content: '我的' })
        .onClick(() => {
          this.switchToTab(3)
        })
      MenuItem({ content: '刷新一下' })
        .onClick(() => {
          this.confirmLeave(() => this.controller.refresh())
        })
    }
    .width(100)
    .fontColor($r('[ui_components].color.text'))
    .font({ size: 14 })
    .radius(4)
  }
}

@Extend(Image)
function iconStyle() {
  .width(24)
  .aspectRatio(1)
  .fillColor($r('[ui_components].color.text'))
  .margin(13)
}
