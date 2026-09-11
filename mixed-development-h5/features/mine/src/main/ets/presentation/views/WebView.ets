import { GlobalVariable } from 'constants'
import { HDMUser } from 'models'
import { auth, storeManager, userSession } from 'storage'
import { cameraPlugin, locationPlugin, photoPlugin, sensorPlugin } from 'device'
import { common } from '@kit.AbilityKit'
import { webview } from '@kit.ArkWeb'
import { mergeBridgeUser } from './userBridgePresentation'

const BRIDGE_NAME: string = 'mk'
const BRIDGE_PERMISSION: string =
  '{"javascriptProxyPermission":{"urlPermissionList":' +
    '[{"scheme":"resource","host":"rawfile","port":"","path":""}],"methodList":[]}}'

class HDMWebBridge {
  private getContext(): common.UIAbilityContext {
    const context = AppStorage.get<common.UIAbilityContext>(GlobalVariable.ABILITY_CONTEXT_KEY)
    if (!context) {
      throw new Error('HDMWebBridge: UIAbilityContext 未初始化')
    }
    return context
  }

  queryUser(): HDMUser | undefined {
    return auth.getUserInfo()
  }

  async updateUser(user: HDMUser): Promise<void> {
    const mergedUser: HDMUser = mergeBridgeUser(auth.getUserInfo(), user)
    await storeManager.setUserInfo(mergedUser)
    auth.setUserInfo(mergedUser)
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
  // 1、创建loading控制进度条显隐
  // 2、progress控制进度条进度
  // 3、onProgressChange函数中获取进度，当进度达到100时loading = false
  // 4、在刷新一下中调用this.controller.refresh() 刷新
  // 5、在onPageBegin中充值进度以及loading = true
  // 加载中
  @State loading: boolean = true
  // 进度
  @State progress: number = 0
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
  // 目标：点击返回箭头，判断网页是否有二级页面或更多页面，如果有则返回上一级，没有则返回
  // 1、onRefreshAccessedHistory获取历史页面信息
  // 2、将历史信息存到一个index中
  @State historyCurrentIndex: number = 0

  // 3、通过判断index是否大于0，来确定是否有二级页面

  onWebBack() {
    if (this.historyCurrentIndex > 0) {
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
    try {
      this.stackPath.popToIndex(-1)
    } catch {
    }
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext
    context.eventHub.emit(GlobalVariable.SWITCH_TAB, tabIndex)
  }

  aboutToDisappear(): void {
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
                this.onWebBack()
              })
            Image($r('[ui_components].media.ic_public_close'))
              .iconStyle()
              .onClick(() => {
                this.stackPath.pop()
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
          if (this.loading) {
            Progress({ type: ProgressType.Linear, value: this.progress, total: 100 })
              .style({ strokeWidth: 2, enableSmoothEffect: true })
              .color($r('[ui_components].color.red'))
              .zIndex(1)
          }
          Web({ src: this.src, controller: this.controller })
            .javaScriptProxy({
              object: this.bridgeObject,
              name: BRIDGE_NAME,
              methodList: [
                'queryUser', 'vibrator', 'getAreaColumns',
                'updateUser', 'removeUser', 'pickerCamera', 'pickerPhoto'
              ],
              controller: this.controller,
              asyncMethodList: [],
              permission: BRIDGE_PERMISSION
            })
            .onProgressChange((data) => {
              //  加载进度变化时记录progress
              this.progress = data.newProgress
              //  加载完成 newProgress ===100
              if (data.newProgress === 100) {
                this.loading = false
              }
            })
            // onPageBegin  网页开始加载
            .onPageBegin(() => {
              this.loading = true
              this.progress = 0
            })
            // 导航完成时触发该回调，用于应用更新其访问的历史链接。
            .onRefreshAccessedHistory(() => {
              const entries = this.controller.getBackForwardEntries()
              this.historyCurrentIndex = entries.currentIndex
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
          this.controller.refresh()
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
