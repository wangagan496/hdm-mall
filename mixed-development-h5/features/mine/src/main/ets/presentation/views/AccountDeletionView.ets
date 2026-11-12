import { GlobalVariable, PAGE_PATH } from 'constants'
import { HDMUser } from 'models'
import { auth, localGoodsStore, storeManager, userSession, deviceFixturePassword } from 'storage'
import { RequestAxios } from 'network'
import { util } from '@kit.ArkTS'
import { HDMNavBar } from 'ui_components'

interface DeletionMatter { id: string; kind: string; message: string; productName: string; createdAt: number }
interface DeletionStatus { status: string; dueAt?: number; canCancel: boolean; message: string; matters: DeletionMatter[] }
interface DeletionRequest { password: string; acknowledged: boolean; requestKey: string }
interface CancelDeletionRequest { requestKey: string }

@Component
export struct AccountDeletionView {
  @StorageProp(GlobalVariable.USER_INFO_KEY) user: HDMUser = {} as HDMUser
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) topHeight: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.APP_FOREGROUND_SEQUENCE) @Watch('refreshAfterForeground') foregroundSequence: number = 0
  @Consume stackPath: NavPathStack
  @State info: DeletionStatus = { status: 'active', canCancel: false, message: '', matters: [] }
  @State password: string = ''
  @State acknowledged: boolean = false
  @State busy: boolean = false
  @State loaded: boolean = false
  @State error: string = ''
  @State explanationExpanded: boolean = false
  private generation: number = 0
  private visible: boolean = false

  aboutToAppear(): void { this.shown() }
  private shown(): void { this.visible = true; void this.refresh(); void this.fillFixtureForm() }
  private hidden(): void { this.visible = false; this.generation++; this.password = '' }
  private refreshAfterForeground(): void { if (this.visible) void this.refresh() }
  private async fillFixtureForm(): Promise<void> {
    const token = this.user.token, sequence = this.generation
    const password = await deviceFixturePassword(this.user.account)
    if (password && auth.getUserInfo()?.token === token && sequence === this.generation) this.password = password
  }
  aboutToDisappear(): void { this.hidden() }
  private orderDate(timestamp: number): string {
    const date = new Date(timestamp + 8 * 3600000)
    return date.getUTCFullYear() + '年' + (date.getUTCMonth() + 1) + '月' + date.getUTCDate() + '日下单'
  }

  private async refresh(): Promise<void> {
    const sequence = ++this.generation, token = this.user.token
    try {
      const info = await RequestAxios.getForSession<DeletionStatus>('/member/account-deletion', token)
      if (sequence !== this.generation || auth.getUserInfo()?.token !== token) return
      this.info = info; this.loaded = true; this.error = ''
    } catch { if (sequence === this.generation) this.error = '注销状态读取失败，请重试' }
  }

  private async actionKey(action: string): Promise<string> {
    const store = storeManager.getStore(), name = 'accountDeletion:' + this.user.id + ':' + action
    let key = store.getSync(name, '') as string
    if (!key) { key = util.generateRandomUUID(); store.putSync(name, key); await store.flush() }
    return key
  }

  private async submitDeletion(): Promise<void> {
    if (this.busy || !this.acknowledged || this.password.length < 8 || this.user.role === 'merchant') return
    this.busy = true; this.error = ''
    const token = this.user.token
    try {
      const body: DeletionRequest = { password: this.password, acknowledged: true, requestKey: await this.actionKey('request') }
      await RequestAxios.postWithSession<DeletionStatus>('/member/account-deletion', body, token)
      this.password = ''
      if (auth.getUserInfo()?.token !== token) return
      try { await localGoodsStore.clearPersonalData() }
      finally {
        // A confirmed deletion must end this session even if local cleanup fails.
        if (auth.getUserInfo()?.token === token) await userSession.logout()
      }
      this.stackPath.clear()
      AppStorage.setOrCreate('currentTabIndex', 0)
    } catch {
      this.password = ''
      this.error = '申请结果尚未确认，请重新登录查看注销状态；请勿重复申请'
    } finally { this.busy = false }
  }

  private async cancelDeletion(): Promise<void> {
    if (this.busy || !this.info.canCancel) return
    this.busy = true
    const token = this.user.token
    try {
      const body: CancelDeletionRequest = { requestKey: await this.actionKey('cancel') }
      await RequestAxios.postWithSession<DeletionStatus>('/member/account-deletion/cancel', body, token)
      if (auth.getUserInfo()?.token !== token) return
      const user = JSON.parse(JSON.stringify(this.user)) as HDMUser
      user.status = 'active'
      user.deletionDueAt = undefined
      await storeManager.saveUserInfo(user)
      auth.updateCurrentUser(user)
      const store = storeManager.getStore()
      store.deleteSync('accountDeletion:' + user.id + ':request')
      store.deleteSync('accountDeletion:' + user.id + ':cancel')
      await store.flush()
      await this.refresh()
      this.getUIContext().getPromptAction().showToast({ message: '已撤销注销，已取消的订单和解除的亲友关系不会恢复' })
    } catch { this.error = '撤销结果未确认，请重新进入核对；冷静期内可重试' }
    finally { this.busy = false }
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({ title: this.info.status === 'deleting' ? '注销申请已提交' : '注销账号', onLeftClick: () => this.stackPath.pop() })
        Scroll() {
          Column({ space: 16 }) {
            Text(this.info.message).id('deletion-status').fontSize(20).fontWeight(FontWeight.Medium).width('100%')
            if (this.info.status === 'deleting') {
              Text(this.explanationExpanded ? '收起注销说明' : '查看注销说明').fontColor($r('[ui_components].color.text'))
                .onClick(() => this.explanationExpanded = !this.explanationExpanded)
            }
            if (this.info.status !== 'deleting' || this.explanationExpanded) {
            Text('删除范围：昵称、头像、个人资料、收货地址、购物车、收藏和足迹、亲友关系、登录状态。').width('100%')
            Text('保留范围：订单、付款、退款、售后和评价依法保留，账号显示为“已注销用户”；交易完成起保存不少于三年，期满清除订单收货地址和售后照片，仅用于售后、对账和纠纷处理。').width('100%')
            Text('提交后所有设备退出登录。未付款订单会在提交后自动取消；付款确认中的订单继续核对，已付订单和售后照常处理，退款退回原付款人，亲友关系解除，待你代付的邀请取消。').width('100%')
            Text('15天内使用原账号密码登录可撤销注销；已取消的订单和解除的亲友关系不会恢复。冷静期内仍可申请售后和取消已付款订单，不能下新单、加购、发起邀请或修改资料。').width('100%')
            Text('仅申请注销的账号：待收货订单在发货15天后自动收货，之后仍可申请售后；冷静期满且售后期和未完成事项全部结束才删除资料。').width('100%')
            }
            ForEach(this.info.matters, (matter: DeletionMatter) => {
              Button({ type: ButtonType.Normal }) {
                Column({ space: 8 }) {
                  Text(matter.productName).fontSize(17).fontWeight(FontWeight.Medium).width('100%')
                    .fontColor($r('[ui_components].color.text'))
                  Text(this.orderDate(matter.createdAt)).fontSize(14).width('100%').fontColor($r('[ui_components].color.text'))
                  Text(matter.message).fontSize(16).width('100%').fontColor($r('[ui_components].color.text'))
                }.width('100%').alignItems(HorizontalAlign.Start)
              }.width('100%').height('auto').padding(16).borderRadius(12)
                .backgroundColor($r('[ui_components].color.white'))
                .onClick(() => this.stackPath.pushPath({ name: PAGE_PATH.ORDER_DETAIL_PAGE, param: matter.id }))
            }, (matter: DeletionMatter) => matter.id)
            if (this.user.role === 'merchant') {
              Text('商家账号请联系管理员处理')
            } else if (this.info.status === 'deleting') {
              Button('撤销注销').id('cancel-deletion').enabled(this.loaded && this.info.canCancel && !this.busy)
                .backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red'))
                .border({ width: 1, color: $r('[ui_components].color.red') })
                .onClick(() => this.cancelDeletion())
              Button('查看订单').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.text'))
                .onClick(() => this.stackPath.pushPath({ name: PAGE_PATH.ORDER_PAGE, param: 0 }))
            } else {
              Text('当前密码').width('100%')
              TextInput({ placeholder: '输入当前密码确认注销', text: $$this.password }).type(InputType.Password).showPasswordIcon(false).id('deletion-password')
              Row({ space: 8 }) {
                Checkbox().select(this.acknowledged).onChange((value: boolean) => this.acknowledged = value)
                Text('我已了解上述影响')
              }
              Button(this.busy ? '正在提交' : '提交注销申请').id('submit-deletion')
                .enabled(this.loaded && this.acknowledged && this.password.length >= 8 && !this.busy)
                .backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary'))
                .onClick(() => this.submitDeletion())
            }
            if (this.error) { Text(this.error).fontColor($r('[ui_components].color.red')) }
          }.padding({ top: 20, left: 20, right: 20, bottom: 48 }).width('100%')
        }.layoutWeight(1).width('100%')
      }.height('100%').width('100%').backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true).padding({ top: this.topHeight, bottom: this.safeBottom }).onShown(() => this.shown()).onHidden(() => this.hidden())
  }
}

@Builder
function AccountDeletionViewBuilder() { AccountDeletionView() }
