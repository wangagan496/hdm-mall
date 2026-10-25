import { GlobalVariable } from 'constants'
import { FamilyRelation, HDMUser, OrderItem } from 'models'
import { HDMNavBar } from 'ui_components'
import {
  getFamilyRelationsAPI,
  inviteRelationAPI,
  updateRelationAPI,
  getFamilyOrdersAPI,
  getMerchantOrdersAPI,
  receiveOrderAPI,
  familyPayAPI,
  shipOrderAPI
} from '../../data/api'

@Builder
function FamilyViewBuilder() { FamilyView() }

@Component
struct FamilyView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged')
  user: HDMUser = { account: '', nickname: '', token: '', avatar: '' }
  @State relations: FamilyRelation[] = []
  @State orders: OrderItem[] = []
  @State merchantOrders: OrderItem[] = []
  @State account: string = ''
  @State loading: boolean = false
  @State busy: boolean = false
  @State errorText: string = ''
  private generation: number = 0
  private active: boolean = true

  aboutToAppear(): void { this.active = true; this.reload() }
  aboutToDisappear(): void { this.active = false; this.generation++ }
  private accountChanged(): void {
    this.generation++
    this.relations = []
    this.orders = []
    this.merchantOrders = []
    if (this.active && this.user.token) { this.reload() }
  }
  private async reload(): Promise<void> {
    const generation = ++this.generation
    this.loading = true
    this.errorText = ''
    try {
      const relations = await getFamilyRelationsAPI()
      const orders = await getFamilyOrdersAPI()
      let merchantOrders: OrderItem[] = []
      if (this.user.role === 'merchant') {
        merchantOrders = await getMerchantOrdersAPI()
      }
      if (!this.active || generation !== this.generation) { return }
      this.relations = relations
      this.orders = orders
      this.merchantOrders = merchantOrders
    } catch {
      if (this.active && generation === this.generation) { this.errorText = '加载失败，请重新登录或重试' }
    } finally {
      if (this.active && generation === this.generation) { this.loading = false }
    }
  }
  private async run(task: () => Promise<void>, success: string): Promise<void> {
    if (this.busy) { return }
    this.busy = true
    const account = this.user.account
    try {
      await task()
      if (!this.active || this.user.account !== account) { return }
      this.getUIContext().getPromptAction().showToast({ message: success })
      await this.reload()
    } catch {
      if (this.active && this.user.account === account) { this.errorText = '操作未完成，请刷新查看最新状态后重试' }
    } finally { this.busy = false }
  }
  private invite(): void {
    this.run(async (): Promise<void> => { await inviteRelationAPI(this.account.trim()) }, '绑定邀请已发送')
  }
  private updateRelation(id: string, action: string): void {
    this.run(async (): Promise<void> => { await updateRelationAPI(id, action) }, action === 'accept' ? '已确认绑定' : '已解除绑定')
  }
  private confirmReceipt(order: OrderItem): void {
    this.getUIContext().showAlertDialog({
      title: '确认已经收到商品？',
      message: '确认后订单将完成收货，并记录你为实际确认人。',
      primaryButton: { value: '还没收到', action: () => {} },
      secondaryButton: { value: '已收到，确认', action: () => {
        this.run(async (): Promise<void> => { await receiveOrderAPI(order.id) }, '已确认代收')
      } }
    })
  }
  private pay(order: OrderItem): void {
    this.getUIContext().showAlertDialog({
      title: '为 ' + order.ownerAccount + ' 模拟代付',
      message: '金额 ¥' + order.payMoney.toFixed(2) + '。这是测试支付，不会实际扣款。',
      primaryButton: { value: '取消', action: () => {} },
      secondaryButton: { value: '确认模拟代付', action: () => {
        this.run(async (): Promise<void> => { await familyPayAPI(order.id, order.payMoney) }, '代付成功')
      } }
    })
  }
  @Builder
  private OrderCard(order: OrderItem, merchant: boolean) {
    Column({ space: 8 }) {
      Text('下单人：' + order.ownerAccount).fontSize(16)
      Text(order.skus.map((item) => item.name).join('、')).fontSize(14).maxLines(2)
      Text('¥' + order.payMoney.toFixed(2)).fontSize(18).fontColor('#B34D36')
      Text(order.orderState === 1 ? '等待代付' : order.orderState === 2 ? '待发货' : order.orderState === 3 ? '待收货' : '已收货')
        .fontSize(12)
      if (order.receivedByAccount) { Text('收货确认人：' + order.receivedByAccount).fontSize(12) }
      if (merchant) {
        if (order.address) {
          Text(order.address.receiver + ' · ' + order.address.contact).fontSize(14)
          Text(order.address.fullLocation + ' ' + order.address.address).fontSize(14)
        }
        Button('确认发货').enabled(!this.busy).onClick(() => {
          this.run(async (): Promise<void> => { await shipOrderAPI(order.id) }, '已发货')
        })
      } else {
        if (order.canPay) { Button('确认模拟代付').enabled(!this.busy).onClick(() => this.pay(order)) }
        if (order.canReceive) { Button('确认代收').enabled(!this.busy).onClick(() => this.confirmReceipt(order)) }
      }
    }.width('100%').alignItems(HorizontalAlign.Start).padding(16).backgroundColor(Color.White).borderRadius(12)
  }
  build() {
    NavDestination() {
      Column() {
        HDMNavBar({ title: '亲友中心', onLeftClick: () => this.stackPath.pop() })
        Scroll() {
          Column({ space: 12 }) {
            Text('添加代付与代收亲友').fontSize(20).fontWeight(FontWeight.Bold)
            Text('对方确认后，可以受邀代付；你的亲友代付订单发货后，所有已绑定代收亲友均可确认收货。本人付款订单不支持代收。')
              .fontSize(13).fontColor('#666666')
            TextInput({ placeholder: '输入亲友的商城账号', text: $$this.account }).maxLength(32)
            Button('发送绑定邀请').enabled(!this.busy && this.account.trim().length >= 3).onClick(() => this.invite())
            Button(this.loading ? '加载中...' : '刷新').enabled(!this.loading && !this.busy).onClick(() => this.reload())
            if (this.errorText) { Text(this.errorText).fontColor('#B34D36') }
            ForEach(this.relations, (relation: FamilyRelation) => {
              Column({ space: 8 }) {
                Text(relation.ownerAccount === this.user.account ? '我的亲友：' + relation.friendAccount : relation.ownerAccount + ' 邀请我作为代付与代收亲友')
                Text(relation.status === 'accepted' ? '已绑定' : '待确认').fontSize(12)
                if (relation.status === 'pending' && relation.friendAccount === this.user.account) {
                  Button('同意绑定').enabled(!this.busy).onClick(() => this.updateRelation(relation.id, 'accept'))
                }
                Button(relation.status === 'pending' ? '取消 / 拒绝邀请' : '解除绑定').enabled(!this.busy)
                  .onClick(() => this.updateRelation(relation.id, 'revoke'))
              }.width('100%').padding(16).backgroundColor(Color.White).borderRadius(12)
            }, (relation: FamilyRelation) => relation.id)
            Text('亲友订单').fontSize(18).fontWeight(FontWeight.Bold)
            if (!this.loading && this.orders.length === 0) { Text('暂无需要代付或代收的订单').fontSize(14) }
            ForEach(this.orders, (order: OrderItem) => { this.OrderCard(order, false) }, (order: OrderItem) => order.id)
            if (this.user.role === 'merchant') {
              Text('商家待发货订单').fontSize(18).fontWeight(FontWeight.Bold)
              ForEach(this.merchantOrders, (order: OrderItem) => { this.OrderCard(order, true) }, (order: OrderItem) => order.id)
            }
          }.width('100%').padding(16).alignItems(HorizontalAlign.Start)
        }.layoutWeight(1).width('100%')
      }.width('100%').height('100%').padding({ top: this.safeTop }).backgroundColor('#F6F5F3')
    }.hideTitleBar(true)
  }
}
