import { GlobalVariable } from 'constants'
import { HDMUser, IDENTITY_ENTRIES, IdentityEntry, IdentityLayout, IdentityLayoutUpdate, sameIdentitySession } from 'models'
import { BusinessError } from 'network'
import { auth, identityLayouts } from 'storage'
import { HDMNavBar } from 'ui_components'

@Component
export struct IdentityLayoutView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('onSessionChange') user: HDMUser = {} as HDMUser
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @State hiddenEntries: string[] = []
  @State revision: number = -1
  @State busy: boolean = false
  @State status: string = ''
  private active: boolean = false
  private operation: number = 0

  aboutToAppear(): void { this.active = true; void this.load() }
  aboutToDisappear(): void { this.active = false; this.operation++ }

  private onSessionChange(): void {
    if (this.active) void this.load()
  }

  private current(operation: number, user: HDMUser): boolean {
    return this.active && operation === this.operation && sameIdentitySession(auth.getUserInfo(), user)
  }

  private adopt(layout: IdentityLayout): void {
    this.hiddenEntries = layout.hiddenEntries.slice()
    this.revision = layout.revision
  }

  private async load(): Promise<void> {
    const operation = ++this.operation
    const user = this.user
    this.busy = true
    this.hiddenEntries = []
    this.revision = -1
    this.status = '正在加载'
    try {
      const result = await identityLayouts.read(user)
      if (this.current(operation, user) && result) { this.adopt(result); this.status = '' }
    } catch {
      if (this.current(operation, user)) this.status = '入口暂时无法加载，请重试'
    } finally {
      if (operation === this.operation) this.busy = false
    }
  }

  private setVisible(entry: IdentityEntry, visible: boolean): void {
    if (entry.locked || this.busy || this.revision < 0) return
    const rest = this.hiddenEntries.filter(id => id !== entry.id)
    if (!visible) rest.push(entry.id)
    this.hiddenEntries = rest
    this.status = ''
  }

  private lockedReason(id: string): string {
    if (id === 'buyer-family') return '含亲友代付、代收的订单，始终显示'
    if (id === 'buyer-service' || id === 'merchant-service') return '联系人工客服，始终显示'
    return '订单和售后结果，始终显示'
  }

  private async save(): Promise<void> {
    if (this.busy || this.revision < 0) return
    const operation = ++this.operation
    const user = this.user
    const update: IdentityLayoutUpdate = { hiddenEntries: this.hiddenEntries.slice(), expectedRevision: this.revision }
    this.busy = true
    this.status = ''
    try {
      const result = await identityLayouts.save(user, update)
      if (this.current(operation, user) && result) { this.adopt(result); this.status = '已保存' }
    } catch (error) {
      if (!this.current(operation, user)) return
      const failure = error as BusinessError
      if (failure.httpStatus === 409) {
        await this.load()
        if (sameIdentitySession(auth.getUserInfo(), user) && this.revision >= 0) {
          this.status = '入口设置已在别处更新，已加载最新设置，请重新选择'
        }
      } else {
        this.status = '暂时无法确认是否已保存，请重试'
      }
    } finally {
      if (operation === this.operation) this.busy = false
    }
  }

  build() {
    NavDestination() {
      Column({ space: 12 }) {
        HDMNavBar({ title: '入口整理', onLeftClick: () => this.stackPath.pop() })
        Text(this.user.identity === 'merchant' ? '店主身份' : '买家身份')
          .fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('[ui_components].color.text'))
          .width('100%').padding({ left: 16, right: 16 })
        Scroll() {
          Column({ space: 2 }) {
            ForEach(this.user.identity === 'merchant' ? IDENTITY_ENTRIES.merchant : IDENTITY_ENTRIES.buyer,
              (entry: IdentityEntry) => {
                Row({ space: 8 }) {
                  Column({ space: 4 }) {
                    Text(entry.label).fontSize(16).fontColor($r('[ui_components].color.text')).width('100%')
                    if (entry.locked) {
                      Text(this.lockedReason(entry.id))
                        .fontSize(12).fontColor($r('[ui_components].color.gray')).width('100%')
                    }
                  }.layoutWeight(1)
                  if (entry.locked) {
                    Text('始终显示').id('identity-entry-locked-' + entry.id)
                      .fontSize(12).fontColor($r('[ui_components].color.text'))
                      .padding({ left: 8, right: 8, top: 4, bottom: 4 }).borderRadius(4)
                      .backgroundColor($r('[ui_components].color.under'))
                  } else {
                    Toggle({ type: ToggleType.Switch, isOn: !this.hiddenEntries.includes(entry.id) })
                      .id('identity-entry-' + entry.id)
                      .accessibilityText(entry.label)
                      .selectedColor($r('[ui_components].color.red'))
                      .enabled(!this.busy && this.revision >= 0)
                      .onChange(visible => this.setVisible(entry, visible))
                  }
                }.width('100%').constraintSize({ minHeight: 56 }).padding({ left: 16, right: 16, top: 8, bottom: 8 })
                  .backgroundColor($r('[ui_components].color.white'))
              }, (entry: IdentityEntry) => entry.id)
          }.width('100%')
        }.align(Alignment.Top).layoutWeight(1).width('100%')
        if (this.status) {
          Text(this.status).id('identity-layout-status').fontSize(14).fontColor($r('[ui_components].color.text'))
            .width('100%').padding({ left: 16, right: 16 })
        }
        if (!this.busy && this.revision < 0) {
          Button('重新加载').fontColor($r('[ui_components].color.text'))
            .backgroundColor($r('[ui_components].color.white')).onClick(() => this.load())
        }
        Button(this.busy ? '处理中' : '保存').id('identity-layout-save')
          .width('92%').height(44).backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary'))
          .enabled(!this.busy && this.revision >= 0).onClick(() => this.save())
      }.width('100%').height('100%').padding({ top: this.safeTop, bottom: this.safeBottom + 12 })
        .backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true)
  }
}
