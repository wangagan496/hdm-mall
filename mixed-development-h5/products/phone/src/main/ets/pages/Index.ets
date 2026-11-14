import { TabItem, BreakPointType, HDMUser, PendingTradeInfo, CreateOrderParams } from 'models'
import { GlobalVariable, BusinessVariable, PAGE_PATH } from 'constants'
import { authCart, storeManager, checkoutFailure, getOrderByRequestAPI, consentManager, userSession } from 'storage'
import { CartView } from 'cart'
import { CategoryView } from 'category'
import { HomeView } from 'home'
import { MineView, AuditLogView, ReconciliationView, MerchantOrderView, PromotionSettingView, ReviewManageView, MerchantServiceView, CustomerServiceView } from 'mine'
import { emitter } from '@kit.BasicServicesKit'
import { common } from '@kit.AbilityKit'
// 导入抽离的常量和枚举
import { TAB_LIST, TabIndex } from '../constants/TabConstants'
import { LaunchPerf } from 'utils'

@Entry
@Component
struct Index {
  @StorageProp(GlobalVariable.BREAK_POINT_KEY) breakPoint: string = ""
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) bottomHeight: number = 0
  @StorageProp(BusinessVariable.CART_COUNT) cartCount: number = 0

  // activeIndex 决定底部选中哪个栏目；stackPath 记录详情、搜索等子页面的前进与返回。
  @StorageLink('currentTabIndex') activeIndex: number = TabIndex.HOME
  @Provide stackPath: NavPathStack = new NavPathStack()

  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('onRecoveryAccountChange') user: HDMUser = {} as HDMUser
  private recoverySequence: number = 0
  private recoveryActive: boolean = true
  private recoveringToken: string = ''

  private onRecoveryAccountChange(): void {
    this.recoverySequence++
    this.recoveringToken = ''
    void this.recoverPendingOrder()
  }

  private isCurrentRecovery(sequence: number, accountId: string, token: string): boolean {
    return this.recoveryActive && this.stackPath.getAllPathName().length === 0 &&
      sequence === this.recoverySequence && this.user.id === accountId && this.user.token === token
  }

  private async recoverPendingOrder(): Promise<void> {
    if (this.recoverPendingTrade()) return
    const accountId: string = this.user.id || ''
    const token: string = this.user.token || ''
    if (GlobalVariable.DEMO_ORDER_FLOW || !this.recoveryActive || this.stackPath.getAllPathName().length > 0 ||
      !accountId || !token || this.recoveringToken === token) return
    const sequence: number = ++this.recoverySequence
    this.recoveringToken = token
    try {
      const record = storeManager.getPendingOrder(accountId)
      if (!record) return
      try {
        const order = await getOrderByRequestAPI(record.requestKey, token)
        if (!this.isCurrentRecovery(sequence, accountId, token)) return
        await storeManager.clearPendingOrder(accountId, record.requestKey)
        if (!this.isCurrentRecovery(sequence, accountId, token) || order.orderState !== 1) return
        const result = await this.getUIContext().getPromptAction().showDialog({ title: '订单已生成',
          message: '上次提交的订单已生成，请在订单创建后15分钟内付款',
          buttons: [{ text: '稍后处理', color: '#666666' }, { text: '去付款', color: '#E64340' }] })
        if (result.index === 1 && this.isCurrentRecovery(sequence, accountId, token)) {
          this.stackPath.pushPath({ name: PAGE_PATH.PAY_PAGE, param: order.id })
        }
      } catch (error) {
        if (!this.isCurrentRecovery(sequence, accountId, token)) return
        if (checkoutFailure(error as Error).status === 404) {
          this.getUIContext().getPromptAction().showToast({ message: '正在确认是否下单成功，请勿重复提交' })
        }
      }
    } catch {
    } finally {
      if (sequence === this.recoverySequence) this.recoveringToken = ''
    }
  }

  private recoverPendingTrade(): boolean {
    if (GlobalVariable.DEMO_ORDER_FLOW || !this.recoveryActive || this.stackPath.getAllPathName().length > 0 || !this.user.token || !this.user.id) return false
    try {
      const raw = storeManager.getPendingTrade()
      if (!raw) return false
      const record = JSON.parse(raw) as PendingTradeInfo
      if (!Number.isFinite(record.created) || record.created > Date.now() || Date.now() - record.created > 30 * 60_000 ||
        (record.accountId && record.accountId !== this.user.id)) {
        void storeManager.clearPendingTrade(record.requestKey)
        return false
      }
      this.stackPath.pushPath({ name: PAGE_PATH.GOODS_PAGE, param: record.entry })
      return true
    } catch { return false }
  }

  onPageShow(): void {
    void this.recoverPendingOrder()
  }

  @Builder
  TabItemContent(item: TabItem, index: number) {
    Column({ space: 4 }) {
      Image(this.activeIndex === index ? item.active : item.normal)
        .width(24)
        .aspectRatio(1)
      Text(item.text)
        .fontColor($r('[ui_components].color.black'))
        .fontSize(12)
    }
  }

  @Builder
  getTabItemBuilder(item: TabItem, index: number) {
    Column() {
      if (index === TabIndex.CART) {
        Badge({ count: this.cartCount, style: {} }) {
          this.TabItemContent(item, index)
        }
      } else {
        this.TabItemContent(item, index)
      }
    }
    .justifyContent(FlexAlign.SpaceEvenly)
    .height(50)
  }

  // 回调保存为成员，aboutToDisappear 时按同一引用注销，避免页面重建后叠加多份监听
  private switchToRequestedTab: (index: number) => void = (index: number) => {
    this.activeIndex = index
  }
  private openSearchPage: () => void = () => {
    this.stackPath.pushPath({ name: PAGE_PATH.SEARCH_PAGE })
  }

  aboutToAppear(): void {
    this.recoveryActive = true
    void this.requestStartupConsent()
    void this.recoverPendingOrder()
    LaunchPerf.mark('tabsAboutToAppear')
    this.listenForNavigationEvents()
    authCart.updateCartCount()
  }

  private async requestStartupConsent(): Promise<void> {
    try {
      const accepted = await consentManager.request(this.getUIContext(), 'startup')
      if (!accepted && this.user.token) await userSession.logout()
      if (accepted && this.user.token) await consentManager.report(this.user.token, this.user.id || '')
    } catch {
      this.getUIContext().getPromptAction().showToast({ message: '协议确认未完成，请在登录时重试' })
    }
  }

  aboutToDisappear(): void {
    this.recoveryActive = false
    this.recoverySequence++
    this.recoveringToken = ''
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext
    context.eventHub.off(GlobalVariable.SWITCH_TAB, this.switchToRequestedTab)
    emitter.off(BusinessVariable.TO_SEARCH, this.openSearchPage)
  }

  private listenForNavigationEvents(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext
    context.eventHub.on(GlobalVariable.SWITCH_TAB, this.switchToRequestedTab)
    emitter.on(BusinessVariable.TO_SEARCH, this.openSearchPage)
  }

  build() {
    Navigation(this.stackPath) {
      Tabs({
        barPosition: new BreakPointType({ xs: BarPosition.End, sm: BarPosition.End, md: BarPosition.End, lg: BarPosition.Start }).getValue(this.breakPoint),
        index: $$this.activeIndex
      }) {
        // 直接使用引入的 TAB_LIST 变量
        ForEach(TAB_LIST, (item: TabItem, index: number) => {
          TabContent() {
            if (index === TabIndex.HOME) { HomeView() }
            else if (index === TabIndex.CATEGORY) {
              CategoryView({ isActive: this.activeIndex === TabIndex.CATEGORY })
            }
            else if (index === TabIndex.CART) { CartView({ standalone: false }) }
            else if (index === TabIndex.MINE) { MineView() }
          }
          .tabBar(this.getTabItemBuilder(item, index))
        })
      }
      .barHeight(new BreakPointType({ xs: 50, sm: 50, md: 50, lg: 220 }).getValue(this.breakPoint))
      .vertical(new BreakPointType({ xs: false, sm: false, md: false, lg: true }).getValue(this.breakPoint))
      .scrollable(false)
      .padding({ bottom: this.bottomHeight })
      .animationDuration(new BreakPointType({ xs: 100, sm: 100, md: 100, lg: 0 }).getValue(this.breakPoint))
    }
    .mode(NavigationMode.Stack)
    .navDestination(this.auditDestination)
    .titleMode(NavigationTitleMode.Mini)
    .hideTitleBar(true)
  }
  @Builder
  private auditDestination(name: string) {
    if (name === 'AuditLogView') { AuditLogView() }
    else if (name === 'ReconciliationView') { ReconciliationView() }
    else if (name === 'PromotionSettingView') { PromotionSettingView() }
    else if (name === 'MerchantOrderView') { MerchantOrderView() }
    else if (name === 'ReviewManageView') { ReviewManageView() }
    else if (name === 'MerchantServiceView') { MerchantServiceView() }
    else if (name === 'MerchantServiceThread') { CustomerServiceView() }
  }
}
