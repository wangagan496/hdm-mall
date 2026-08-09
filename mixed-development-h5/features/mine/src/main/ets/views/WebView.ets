import { promptAction } from '@kit.ArkUI'
import { auth, cameraPlugin, GlobalVariable, HDMUser, locationPlugin, photoPlugin, sensorPlugin } from 'basic'
import { webview } from '@kit.ArkWeb'

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
  // 测试的网页准备一个
  src = ''

  aboutToAppear(): void {
    this.src = 'http://192.168.2.5:5173'
  }

  // 页面视图控制器
  controller = new webview.WebviewController()
  // 目标：点击返回箭头，判断网页是否有二级页面或更多页面，如果有则返回上一级，没有则返回
  // 1、onRefreshAccessedHistory获取历史页面信息
  // 2、将历史信息存到一个index中
  @State historyCurrentIndex: number = 0

  // 3、通过判断index是否大于0，来确定是否有二级页面

  onWebBack() {
    if (this.historyCurrentIndex > 0) {
      this.controller.backward()
    } else {
      this.stackPath.pop()
    }
  }

  onWebInit() {

    // registerJavaScriptProxy({对象}，‘对象名’，[方法列表])
    // 1、使用registerJavaScriptProxy在web端的window对象下注册一个对象
    // 2、在web端调用window.haronyos.showToast()，可以达成执行鸿蒙端弹窗的效果
    this.controller.registerJavaScriptProxy({
      //  查询用户信息
      queryUser: (): HDMUser => auth.getUserInfo()!,
      //   更新用户信息
      updateUser: (user: HDMUser): void => auth.setUserInfo(user),
      //   移除用户信息
      removeUser: (): void => auth.clearUserInfo(),
      pickerCamera: (): Promise<string> => cameraPlugin.pickerCamera(), // 调用相机
      pickerPhoto: (): Promise<string> => photoPlugin.pickerPhoto(), // 调用相册
      vibrator: (): void => sensorPlugin.vibrator(), // 震动
      getAreaColumns: (): string => locationPlugin.getAreaColumns(), // 获取省市区
    },
      'mk',
      ['queryUser', 'updateUser', 'removeUser', 'pickerCamera', 'pickerPhoto', 'vibrator', 'getAreaColumns'])
  }

  build() {
    NavDestination() {
      Column() {
        // 导航条
        Row() {
          Row() {
            Image($r("[basic].media.ic_public_left"))
              .iconStyle()
              .onClick(() => {
                this.onWebBack()
              })
            Image($r('[basic].media.ic_public_close'))
              .iconStyle()
              .onClick(() => {
                this.stackPath.pop()
              })

          }
          .width(100)

          Text(this.title)
            .fontSize(16)
            .fontWeight(500)
            .fontColor($r('[basic].color.black'))
            .layoutWeight(1)
            .maxLines(1)
            .textAlign(TextAlign.Center)
            .textOverflow({ overflow: TextOverflow.MARQUEE })
          Row() {
            Blank()
            Image($r('[basic].media.ic_public_more'))
              .iconStyle()
              .bindMenu(this.MenuBuilder)
          }
          .width(100)
        }
        .height(50 + this.safeTop)
        .backgroundColor($r('[basic].color.white'))
        .padding({ top: this.safeTop })

        Stack({ alignContent: Alignment.Top }) {
          if (this.loading) {
            Progress({ type: ProgressType.Linear, value: this.progress, total: 100 })
              .style({ strokeWidth: 2, enableSmoothEffect: true })
              .color($r('[basic].color.red'))
              .zIndex(1)
          }
          Web({ src: this.src, controller: this.controller })
            .onAppear(() => {
              this.onWebInit()
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
              console.log('title:', data.title)
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
        })
      MenuItem({ content: '分类' })
        .onClick(() => {
        })
      MenuItem({ content: '购物袋' })
        .onClick(() => {
        })
      MenuItem({ content: '我的' })
        .onClick(() => {
        })
      MenuItem({ content: '刷新一下' })
        .onClick(() => {
          this.controller.refresh()
        })
    }
    .width(100)
    .fontColor($r('[basic].color.text'))
    .font({ size: 14 })
    .radius(4)
  }
}

@Extend(Image)
function iconStyle() {
  .width(24)
  .aspectRatio(1)
  .fillColor($r('[basic].color.text'))
  .margin(13)
}