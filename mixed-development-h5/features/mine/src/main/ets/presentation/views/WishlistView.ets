import { util } from '@kit.ArkTS'
import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMUser, ReturnPolicyGoods, WishlistConfirmInput, WishlistItem, returnPolicyLabel } from 'models'
import { HDMNavBar } from 'ui_components'
import { cancelWishlistAPI, confirmWishlistAPI, getWishlistAPI } from '../../data/api'
import {
  formatSpendingYuan,
  formatWishlistCooldownTime,
  wishlistActionErrorMessage,
  wishlistItemHeadline,
  wishlistStateLabel
} from '../utils/SpendingSettingPresentation'

interface WishlistFailureResult {
  goods?: ReturnPolicyGoods[]
  returnPolicyToken?: string
}

interface WishlistFailureBody {
  reason?: string
  result?: WishlistFailureResult
}

interface WishlistFailureResponse {
  status?: number
  data?: WishlistFailureBody
}

interface WishlistRequestError extends Error {
  httpStatus?: number
  reason?: string
  result?: WishlistFailureResult
  response?: WishlistFailureResponse
}

@Component
export struct WishlistView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = {} as HDMUser

  @State items: WishlistItem[] = []
  @State loading: boolean = false
  @State busyId: string = ''
  @State message: string = ''
  @State pendingPolicyItemId: string = ''
  @State pendingPolicyToken: string = ''
  @State pendingPolicyGoods: ReturnPolicyGoods[] = []
  @State pendingPolicyConfirmed: boolean = false

  private active: boolean = false
  private query: number = 0
  private sessionSeq: number = 0
  private confirmKeys: Map<string, string> = new Map<string, string>()

  private clearPendingPolicy(): void {
    this.pendingPolicyItemId = ''
    this.pendingPolicyToken = ''
    this.pendingPolicyGoods = []
    this.pendingPolicyConfirmed = false
  }

  private allowed(): boolean {
    return this.active && this.user.identity !== 'merchant' && !!this.user.id && !!this.user.token
  }

  private sameSession(seq: number, token: string, account: string): boolean {
    return this.allowed() && seq === this.sessionSeq && token === this.user.token && account === this.user.id
  }

  private current(query: number, token: string, account: string): boolean {
    return this.allowed() && query === this.query && token === this.user.token && account === this.user.id
  }

  private accountChanged(): void {
    this.query++
    this.sessionSeq++
    this.items = []
    this.loading = false
    this.busyId = ''
    this.message = ''
    this.clearPendingPolicy()
    this.confirmKeys.clear()
    if (this.active) {
      void this.load()
    }
  }

  aboutToDisappear(): void {
    this.active = false
    this.query++
    this.sessionSeq++
    this.loading = false
    this.busyId = ''
    this.clearPendingPolicy()
  }

  private shown(): void {
    if (!this.active) {
      this.active = true
    }
    void this.load()
  }

  private async load(preserveMessage: boolean = false): Promise<void> {
    if (!this.allowed()) {
      this.message = '请登录买家账号后查看待买清单'
      return
    }
    const query = ++this.query
    const token = this.user.token || ''
    const account = this.user.id || ''
    this.loading = true
    if (!preserveMessage) {
      this.message = ''
    }
    try {
      const list = await getWishlistAPI(token)
      if (!this.current(query, token, account)) {
        return
      }
      this.items = list || []
    } catch {
      if (this.current(query, token, account) && !preserveMessage) {
        this.message = '待买清单读取失败，请重试'
      }
    } finally {
      if (this.current(query, token, account)) {
        this.loading = false
      }
    }
  }

  private async cancelItem(item: WishlistItem): Promise<void> {
    if (this.busyId || !this.allowed()) {
      return
    }
    const sessionSeq = this.sessionSeq
    const token = this.user.token || ''
    const account = this.user.id || ''
    this.busyId = item.id
    this.message = ''
    try {
      await cancelWishlistAPI(item.id, token)
      if (!this.sameSession(sessionSeq, token, account)) {
        return
      }
      if (this.pendingPolicyItemId === item.id) {
        this.clearPendingPolicy()
      }
      this.message = '已取消该待买记录'
      await this.load(true)
    } catch (error) {
      if (!this.sameSession(sessionSeq, token, account)) {
        return
      }
      const err = error as WishlistRequestError
      const status = err.httpStatus || err.response?.status || 0
      this.message = wishlistActionErrorMessage(status, err.response?.data?.reason, err.message)
    } finally {
      if (this.sameSession(sessionSeq, token, account)) {
        this.busyId = ''
      }
    }
  }

  private confirmKeyFor(item: WishlistItem, policyTokenTag: string = ''): string {
    const quoteVersionKey = item.id + ':' + String(item.quotedTotalCents) + ':' + String(item.promotionRevision ?? '') + ':' + policyTokenTag
    const existing = this.confirmKeys.get(quoteVersionKey)
    if (existing) {
      return existing
    }
    const fresh = util.generateRandomUUID(true)
    this.confirmKeys.set(quoteVersionKey, fresh)
    return fresh
  }

  private async confirmItem(item: WishlistItem, withFreshPolicy: boolean = false): Promise<void> {
    if (this.busyId || !this.allowed()) {
      return
    }
    if (withFreshPolicy && (!this.pendingPolicyConfirmed || !this.pendingPolicyToken || this.pendingPolicyItemId !== item.id)) {
      this.message = '请先了解并勾选新的商品退货限制后再确认下单'
      return
    }
    const sessionSeq = this.sessionSeq
    const token = this.user.token || ''
    const account = this.user.id || ''
    this.busyId = item.id
    this.message = ''
    const payload: WishlistConfirmInput = withFreshPolicy
      ? {
          requestKey: this.confirmKeyFor(item, this.pendingPolicyToken),
          expectedAmountCents: item.quotedTotalCents,
          returnPolicyConfirmed: true,
          expectedReturnPolicyToken: this.pendingPolicyToken
        }
      : {
          requestKey: this.confirmKeyFor(item),
          expectedAmountCents: item.quotedTotalCents
        }
    try {
      const res = await confirmWishlistAPI(item.id, payload, token)
      if (!this.sameSession(sessionSeq, token, account)) {
        return
      }
      this.clearPendingPolicy()
      this.stackPath.replacePath({ name: PAGE_PATH.PAY_PAGE, param: res.orderId })
    } catch (error) {
      if (!this.sameSession(sessionSeq, token, account)) {
        return
      }
      const err = error as WishlistRequestError
      const status = err.httpStatus || err.response?.status || 0
      const reason = err.reason || err.response?.data?.reason
      const failureResult = err.result || err.response?.data?.result
      this.message = wishlistActionErrorMessage(status, reason, err.message)
      if ((reason === 'RETURN_POLICY_CHANGED' || reason === 'RETURN_POLICY_CONFIRM_REQUIRED') && failureResult?.returnPolicyToken) {
        this.pendingPolicyItemId = item.id
        this.pendingPolicyToken = failureResult.returnPolicyToken
        this.pendingPolicyGoods = failureResult.goods || []
        this.pendingPolicyConfirmed = false
      } else if (reason === 'PRICE_CHANGED' || status === 409) {
        await this.load(true)
      }
    } finally {
      if (this.sameSession(sessionSeq, token, account)) {
        this.busyId = ''
      }
    }
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: '待买清单',
          onLeftClick: () => this.stackPath.pop()
        })
        Scroll() {
          Column({ space: 12 }) {
            Text('触发冷静阈值的商品会暂存此处（不生成订单、不占用库存）。冷静期结束后可由您本人按最新报价确认下单或直接取消。')
              .id('wishlist-rule-note').fontSize(13).fontColor($r('[ui_components].color.gray')).width('100%')

            if (this.message) {
              Text(this.message).id('wishlist-message').fontSize(14).fontColor($r('[ui_components].color.red')).width('100%')
            }

            if (!this.loading && this.items.length === 0) {
              Column({ space: 10 }) {
                Text('当前没有待买记录').id('wishlist-empty').fontSize(15).fontColor($r('[ui_components].color.gray'))
                Button('去花钱设置').id('wishlist-open-settings')
                  .backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.text'))
                  .border({ width: 1, color: $r('[ui_components].color.border') })
                  .onClick(() => { this.stackPath.pushPath({ name: 'SpendingSettingView' }) })
              }.width('100%').padding(24).backgroundColor($r('[ui_components].color.white')).borderRadius(12)
            } else {
              ForEach(this.items, (item: WishlistItem, index: number) => {
                Column({ space: 8 }) {
                  Row({ space: 8 }) {
                    Text(wishlistItemHeadline(item)).fontSize(15).fontWeight(FontWeight.Medium).fontColor($r('[ui_components].color.text')).layoutWeight(1)
                    Text(wishlistStateLabel(item)).id('wishlist-status-' + index).fontSize(12)
                      .fontColor(item.readyToConfirm ? $r('[ui_components].color.red') : $r('[ui_components].color.gray'))
                  }.width('100%')

                  Text(`冷静截至（北京时间）：${formatWishlistCooldownTime(item.cooldownUntil)}`)
                    .id('wishlist-cooldown-' + index).fontSize(13).fontColor($r('[ui_components].color.gray')).width('100%')

                  Text(`当前报价：${formatSpendingYuan(item.quotedTotalCents)}` +
                    (item.ruleVersion !== null ? ` · 依据规则 v${item.ruleVersion}` : ''))
                    .id('wishlist-quote-' + index).fontSize(14).fontColor($r('[ui_components].color.text')).width('100%')

                  if (item.priceChanged) {
                    Text(item.currentQuotedTotalCents === null
                      ? '部分商品已下架或不可购买，当前无法下单'
                      : `最新实时报价已变为 ${formatSpendingYuan(item.currentQuotedTotalCents)}，需本人重新核价确认`)
                      .id('wishlist-price-changed-' + index).fontSize(13).fontColor($r('[ui_components].color.red')).width('100%')
                  }

                  if (item.status === 'waiting') {
                    Row({ space: 10 }) {
                      Button(this.busyId === item.id ? '处理中' : '取消待买').id('wishlist-cancel-' + index)
                        .layoutWeight(1).height(38)
                        .backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.text'))
                        .border({ width: 1, color: $r('[ui_components].color.border') })
                        .enabled(!this.busyId).onClick(() => { void this.cancelItem(item) })

                      Button(this.busyId === item.id ? '处理中' : (item.priceChanged ? '重新核价确认' : '确认下单'))
                        .id('wishlist-confirm-' + index).layoutWeight(1).height(38)
                        .backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary'))
                        .enabled(!this.busyId && item.readyToConfirm)
                        .onClick(() => { void this.confirmItem(item) })
                    }.width('100%').padding({ top: 4 })
                  }

                  if (item.status === 'waiting' && this.pendingPolicyItemId === item.id && this.pendingPolicyToken) {
                    Column({ space: 8 }) {
                      Text('退货规则变化，请重新确认').id('wishlist-policy-title-' + index)
                        .fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('[ui_components].color.red')).width('100%')
                      ForEach(this.pendingPolicyGoods, (g: ReturnPolicyGoods) => {
                        Text(`${g.name}：${returnPolicyLabel(g)}`)
                          .fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
                      }, (g: ReturnPolicyGoods) => g.skuId)
                      Row({ space: 8 }) {
                        Checkbox().id('wishlist-policy-checkbox-' + index).select(this.pendingPolicyConfirmed)
                          .selectedColor($r('[ui_components].color.red')).size({ width: 20, height: 20 })
                          .enabled(!this.busyId)
                          .onChange((checked: boolean) => { this.pendingPolicyConfirmed = checked })
                        Text('我已了解商品最新的退货限制')
                          .fontSize(13).fontColor($r('[ui_components].color.text')).layoutWeight(1)
                          .onClick(() => { if (!this.busyId) this.pendingPolicyConfirmed = !this.pendingPolicyConfirmed })
                      }.width('100%')
                      Button(this.busyId === item.id ? '提交中' : '确认新退货规则并下单').id('wishlist-policy-confirm-' + index)
                        .width('100%').height(38)
                        .backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary'))
                        .enabled(!this.busyId && this.pendingPolicyConfirmed)
                        .onClick(() => { void this.confirmItem(item, true) })
                    }.id('wishlist-policy-panel-' + index).width('100%').padding(10).alignItems(HorizontalAlign.Start)
                      .backgroundColor($r('[ui_components].color.under')).borderRadius(8)
                      .border({ width: 1, color: $r('[ui_components].color.red') })
                  }
                }.id('wishlist-card-' + index).width('100%').padding(14).alignItems(HorizontalAlign.Start)
                  .backgroundColor($r('[ui_components].color.white')).borderRadius(12)
              }, (item: WishlistItem) => item.id + ':' + item.status + ':' + String(item.quotedTotalCents) + ':' + String(item.readyToConfirm))
            }

            Button('刷新列表').id('wishlist-reload-button').width('100%').height(42)
              .backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red'))
              .border({ width: 1, color: $r('[ui_components].color.red') })
              .enabled(!this.loading && !this.busyId).onClick(() => { void this.load() })
          }.width('100%').padding(16)
        }.layoutWeight(1).width('100%')
      }.width('100%').height('100%').padding({ top: this.safeTop, bottom: this.safeBottom }).backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true).onShown(() => this.shown()).onHidden(() => this.aboutToDisappear())
  }
}
