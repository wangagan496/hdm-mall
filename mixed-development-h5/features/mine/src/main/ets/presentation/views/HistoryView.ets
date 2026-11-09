import { GlobalVariable } from 'constants'
import { HDMUser, LocalGoodsItem } from 'models'
import { auth, localGoodsStore } from 'storage'
import { HDMConfirm, HDMEmpty, HDMNavBar } from 'ui_components'
import { LocalGoodsRow } from '../components/LocalGoodsRow'

@Builder
function HistoryViewBuilder() {
  HistoryView()
}

@Component
export struct HistoryView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @State
  browsedGoods: LocalGoodsItem[] = []
  @State clearing: boolean = false
  @State removing: boolean = false
  @State loaded: boolean = false
  @State errorText: string = ''
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('reloadForCurrentAccount')
  user: HDMUser = { token: '', account: '', nickname: '', avatar: '' }
  @StorageProp(GlobalVariable.APP_FOREGROUND_SEQUENCE) @Watch('refreshAfterForeground') foregroundSequence: number = 0
  private isPageActive: boolean = false
  private pageGeneration: number = 0
  private sessionToken: string = ''
  private sessionAccount: string = ''
  private dialogSequence: number = 0
  @Consume
  stackPath: NavPathStack

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }
  @State showClearDialog: boolean = false

  @Builder
  ClearHistoryBuilder() {
    HDMConfirm({
      message: '确定清空全部浏览足迹吗？',
      confirmText: '清空浏览足迹', busy: this.clearing,
      onConfirm: this.createClearAction(),
      onCancel: this.createCancelClearAction()
    })
  }

  private openClearDialog(): void {
    if (!this.canManageHistory() || this.browsedGoods.length === 0) return
    this.dialogSequence++; this.showClearDialog = true
  }
  private createClearAction(): () => void {
    const generation: number = this.pageGeneration, token: string = this.sessionToken, dialog: number = this.dialogSequence
    return (): void => { this.clearHistoryAndRefresh(generation, token, dialog) }
  }
  private createCancelClearAction(): () => void {
    const generation: number = this.pageGeneration, token: string = this.sessionToken, dialog: number = this.dialogSequence
    return (): void => {
      if (this.isCurrent(generation, token) && dialog === this.dialogSequence && !this.clearing) {
        this.showClearDialog = false; this.dialogSequence++
      }
    }
  }
  private async clearHistoryAndRefresh(generation: number, token: string, dialog: number): Promise<void> {
    if (!this.isCurrent(generation, token) || dialog !== this.dialogSequence || !this.showClearDialog ||
      !this.canManageHistory() || this.browsedGoods.length === 0) return
    this.showClearDialog = false; this.dialogSequence++
    this.clearing = true
    try {
      await localGoodsStore.clearHistory()
      if (!this.isCurrent(generation, token)) return
      this.loadLocalHistory()
    } catch {
      if (this.isCurrent(generation, token)) this.safeToast('清空失败，请稍后重试')
    } finally {
      if (this.isCurrent(generation, token)) this.clearing = false
    }
  }

  aboutToAppear(): void {
    this.isPageActive = true
    this.loadLocalHistory()
  }

  aboutToDisappear(): void {
    this.isPageActive = false; this.pageGeneration++; this.dialogSequence++
    this.loaded = false; this.removing = false; this.clearing = false; this.showClearDialog = false
  }
  private showLocalGoods(): void { if (!this.isPageActive) this.aboutToAppear() }
  private refreshAfterForeground(): void {
    if (this.isPageActive && !this.removing && !this.clearing) this.loadLocalHistory()
  }
  private reloadForCurrentAccount(): void {
    if (this.synchronizeSession() && this.isPageActive) this.loadLocalHistory()
  }
  private synchronizeSession(): boolean {
    const token: string = this.user.token || '', account: string = this.user.account || ''
    if (token === this.sessionToken && account === this.sessionAccount) return false
    this.sessionToken = token; this.sessionAccount = account; this.pageGeneration++; this.dialogSequence++
    this.browsedGoods = []; this.loaded = false; this.removing = false; this.clearing = false
    this.showClearDialog = false; this.errorText = ''
    return true
  }
  private isCurrent(generation: number, token: string): boolean {
    const current: HDMUser | undefined = auth.getUserInfo()
    return this.isPageActive && generation === this.pageGeneration && token === this.sessionToken &&
      token === (this.user.token || '') && token === (current?.token || '') &&
      this.sessionAccount === (this.user.account || '') && this.sessionAccount === (current?.account || '')
  }
  private canManageHistory(): boolean {
    return this.loaded && !this.removing && !this.clearing && this.isCurrent(this.pageGeneration, this.sessionToken)
  }
  private createRowGuard(goodsId: string): () => boolean {
    const generation: number = this.pageGeneration, token: string = this.sessionToken
    return (): boolean => this.isCurrent(generation, token) && this.canManageHistory() && !this.showClearDialog &&
      this.browsedGoods.some(item => item.id === goodsId)
  }
  private createRemoveAction(goodsId: string): (id: string) => void {
    const canUse: () => boolean = this.createRowGuard(goodsId)
    return (id: string): void => { if (id === goodsId && canUse()) this.removeHistoryAndRefresh(goodsId) }
  }

  private loadLocalHistory(): void {
    this.synchronizeSession()
    if (!this.isCurrent(this.pageGeneration, this.sessionToken)) return
    this.dialogSequence++; this.showClearDialog = false
    // 这里只读当前账号的本机记录，没有向服务端请求。
    this.loaded = false; this.errorText = ''
    try { this.browsedGoods = localGoodsStore.getHistory().slice(); this.loaded = true }
    catch { this.errorText = '足迹读取失败，请重试' }
  }

  private async removeHistoryAndRefresh(goodsId: string): Promise<void> {
    if (!this.canManageHistory() || this.showClearDialog || !this.browsedGoods.some(item => item.id === goodsId)) return
    const generation: number = this.pageGeneration, token: string = this.sessionToken
    this.removing = true
    try {
      await localGoodsStore.removeHistory(goodsId)
      if (!this.isCurrent(generation, token)) return
      this.loadLocalHistory()
    } catch {
      if (this.isCurrent(generation, token)) this.safeToast('删除失败，请稍后重试')
    } finally {
      if (this.isCurrent(generation, token)) this.removing = false
    }
  }

  private goHome(): void {
    if (!this.isCurrent(this.pageGeneration, this.sessionToken)) return
    this.stackPath.clear()
    AppStorage.setOrCreate<number>('currentTabIndex', 0)
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: '我的足迹',
          onLeftClick: () => this.stackPath.pop()
        })
        if (this.errorText) {
          Text(this.errorText).fontColor($r('[ui_components].color.red')).padding(12)
          Button('重新读取足迹').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') }).onClick(() => this.loadLocalHistory())
        }
        if (this.loaded && this.browsedGoods.length === 0) {
          Column() {
            HDMEmpty({
              tip: '还没有浏览足迹',
              buttonText: '去逛逛',
              onBtnClick: () => this.goHome()
            })
          }
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else {
          Row() {
            Text('最近浏览')
              .fontSize(13)
              .fontColor($r('[ui_components].color.gray'))
            Blank()
            Text('清空')
              .fontSize(13)
              .fontColor($r('[ui_components].color.red'))
              .padding({ left: 12, top: 8, right: 4, bottom: 8 })
              .enabled(this.canManageHistory())
              .onClick(() => this.openClearDialog())
          }
          .width('100%')
          .padding({ left: 12, right: 12 })

          List({ space: 1 }) {
            ForEach(this.browsedGoods, (item: LocalGoodsItem) => {
              ListItem() {
                LocalGoodsRow({
                  item: item,
                  actionText: '删除',
                  interactive: this.canManageHistory() && !this.showClearDialog,
                  canOpen: this.createRowGuard(item.id),
                  onAction: this.createRemoveAction(item.id)
                })
              }
            }, (item: LocalGoodsItem) => this.pageGeneration.toString() + ':' + JSON.stringify(item))
          }
          .layoutWeight(1)
          .scrollBar(BarState.Off)
          .padding({ bottom: 8 })
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('[ui_components].color.under'))
    }
    .hideTitleBar(true)
    .onShown(() => this.showLocalGoods())
    .onHidden(() => this.aboutToDisappear())
    .bindContentCover($$this.showClearDialog, this.ClearHistoryBuilder())
    .padding({ top: this.topHeight })
  }
}
