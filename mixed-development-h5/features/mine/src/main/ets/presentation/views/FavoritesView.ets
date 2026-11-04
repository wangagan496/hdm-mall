import { GlobalVariable } from 'constants'
import { HDMUser, LocalGoodsItem } from 'models'
import { auth, localGoodsStore } from 'storage'
import { HDMEmpty, HDMNavBar } from 'ui_components'
import { LocalGoodsRow } from '../components/LocalGoodsRow'

@Builder
function FavoritesViewBuilder() {
  FavoritesView()
}

@Component
export struct FavoritesView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @State
  favoriteGoods: LocalGoodsItem[] = []
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('reloadForCurrentAccount')
  user: HDMUser = { token: '', account: '', nickname: '', avatar: '' }
  @StorageProp(GlobalVariable.APP_FOREGROUND_SEQUENCE) @Watch('refreshAfterForeground') foregroundSequence: number = 0
  @State removing: boolean = false
  @State loaded: boolean = false
  @State errorText: string = ''
  private isPageActive: boolean = false
  private pageGeneration: number = 0
  private sessionToken: string = ''
  private sessionAccount: string = ''
  @Consume
  stackPath: NavPathStack

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  aboutToAppear(): void {
    this.isPageActive = true
    this.loadLocalFavorites()
  }

  aboutToDisappear(): void {
    this.isPageActive = false; this.pageGeneration++; this.loaded = false; this.removing = false
  }
  private showLocalGoods(): void { if (!this.isPageActive) this.aboutToAppear() }
  private refreshAfterForeground(): void { if (this.isPageActive && !this.removing) this.loadLocalFavorites() }
  private reloadForCurrentAccount(): void {
    if (this.synchronizeSession() && this.isPageActive) this.loadLocalFavorites()
  }
  private synchronizeSession(): boolean {
    const token: string = this.user.token || '', account: string = this.user.account || ''
    if (token === this.sessionToken && account === this.sessionAccount) return false
    this.sessionToken = token; this.sessionAccount = account; this.pageGeneration++
    this.favoriteGoods = []; this.loaded = false; this.removing = false; this.errorText = ''
    return true
  }
  private isCurrent(generation: number, token: string): boolean {
    const current: HDMUser | undefined = auth.getUserInfo()
    return this.isPageActive && generation === this.pageGeneration && token === this.sessionToken &&
      token === (this.user.token || '') && token === (current?.token || '') &&
      this.sessionAccount === (this.user.account || '') && this.sessionAccount === (current?.account || '')
  }
  private canManageFavorites(): boolean {
    return this.loaded && !this.removing && this.isCurrent(this.pageGeneration, this.sessionToken)
  }
  private createRowGuard(goodsId: string): () => boolean {
    const generation: number = this.pageGeneration, token: string = this.sessionToken
    return (): boolean => this.isCurrent(generation, token) && this.canManageFavorites() &&
      this.favoriteGoods.some(item => item.id === goodsId)
  }
  private createRemoveAction(goodsId: string): (id: string) => void {
    const canUse: () => boolean = this.createRowGuard(goodsId)
    return (id: string): void => { if (id === goodsId && canUse()) this.removeFavoriteAndRefresh(goodsId) }
  }

  private loadLocalFavorites(): void {
    this.synchronizeSession()
    if (!this.isCurrent(this.pageGeneration, this.sessionToken)) return
    // 这里只读当前账号的本机记录，没有向服务端请求。
    this.loaded = false; this.errorText = ''
    try { this.favoriteGoods = localGoodsStore.getFavorites().slice(); this.loaded = true }
    catch { this.errorText = '收藏读取失败，请重试' }
  }

  private async removeFavoriteAndRefresh(goodsId: string): Promise<void> {
    if (!this.canManageFavorites() || !this.favoriteGoods.some(item => item.id === goodsId)) return
    const generation: number = this.pageGeneration, token: string = this.sessionToken
    this.removing = true
    try {
      await localGoodsStore.removeFavorite(goodsId)
      if (!this.isCurrent(generation, token)) return
      this.loadLocalFavorites()
      this.safeToast('已取消收藏')
    } catch {
      if (this.isCurrent(generation, token)) this.safeToast('操作失败，请稍后重试')
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
          title: '我的收藏',
          onLeftClick: () => this.stackPath.pop()
        })
        if (this.errorText) {
          Text(this.errorText).fontColor($r('[ui_components].color.red')).padding(12)
          Button('重新读取收藏').onClick(() => this.loadLocalFavorites())
        }
        if (this.loaded && this.favoriteGoods.length === 0) {
          Column() {
            HDMEmpty({
              tip: '还没有收藏商品',
              buttonText: '去逛逛',
              onBtnClick: () => this.goHome()
            })
          }
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else {
          List({ space: 1 }) {
            ForEach(this.favoriteGoods, (item: LocalGoodsItem) => {
              ListItem() {
                LocalGoodsRow({
                  item: item,
                  actionText: '取消收藏',
                  interactive: this.canManageFavorites(),
                  canOpen: this.createRowGuard(item.id),
                  onAction: this.createRemoveAction(item.id)
                })
              }
            }, (item: LocalGoodsItem) => this.pageGeneration.toString() + ':' + JSON.stringify(item))
          }
          .layoutWeight(1)
          .scrollBar(BarState.Off)
          .padding({ top: 8, bottom: 8 })
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('[ui_components].color.under'))
    }
    .hideTitleBar(true)
    .onShown(() => this.showLocalGoods())
    .onHidden(() => this.aboutToDisappear())
    .padding({ top: this.topHeight })
  }
}
