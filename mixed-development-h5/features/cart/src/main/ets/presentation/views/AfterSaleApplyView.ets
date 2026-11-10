import { util } from '@kit.ArkTS'
import { GlobalVariable } from 'constants'
import { HDMNavBar } from 'ui_components'
import { HDMUser, OrderItem, OrderSku, AfterSaleLine, AfterSaleBody, AfterSalePhoto, AfterSaleQuantity, afterSaleAmount, afterSaleInputError, afterSaleKind } from 'models'
import { afterSaleActions } from 'storage'
import { pickProductImage } from 'ui_components'
import { getAfterSaleOrderAPI } from '../../data/api/afterSales'
import { orderWriteFailure } from '../utils/OrderWriteFailure'
import { returnPolicyAllowsNoReason, returnConditionRequired, returnConditionError, returnPolicyAfterSaleHint } from 'models'

@Builder
function AfterSaleApplyViewBuilder() { AfterSaleApplyView() }

@Component
export struct AfterSaleApplyView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = {} as HDMUser
  @State orderId: string = ''
  @State order: OrderItem | null = null
  @State lines: AfterSaleLine[] = []
  @State kind: string = 'return-no-reason'
  @State description: string = ''
  @State photos: AfterSalePhoto[] = []
  @State loading: boolean = false
  @State busy: boolean = false
  @State pending: boolean = false
  @State message: string = ''
  private active: boolean = true
  private generation: number = 0
  private token: string = ''
  private current(generation: number,token: string): boolean {return this.active && this.generation===generation && !!token && token===this.token && token===(this.user.token||'')}
  private accountChanged(): void {this.generation++;this.order=null;this.lines=[];this.photos=[];this.description='';this.busy=false;if(this.active)void this.load()}
  aboutToDisappear(): void {this.active=false;this.generation++}
  private async load(): Promise<void> {
    this.token=this.user.token||'';const token=this.token,generation=++this.generation
    this.loading=true;this.message=''
    try {
      const order=await getAfterSaleOrderAPI(this.orderId,token)
      if(!this.current(generation,token))return
      this.order=order
      this.lines=order.skus.filter((sku: OrderSku): boolean => (sku.afterSaleRemaining||0)>0).map((sku: OrderSku): AfterSaleLine => {
        return {skuId:sku.id,name:sku.name,spec:sku.attrsText,priceCents:Math.round(sku.realPay*100),count:sku.afterSaleRemaining||0,remaining:sku.afterSaleRemaining||0,
          returnPolicy:sku.returnPolicy,returnPolicyReason:sku.returnPolicyReason,returnPolicyNote:sku.returnPolicyNote,returnPolicyConfirmed:sku.returnPolicyConfirmed,afterSaleKinds:sku.afterSaleKinds}
      })
      this.kind=order.afterSaleKinds?.[0]||'return-no-reason'
      this.excludeRestrictedLines()
      this.pending=afterSaleActions.pending(this.user.id||'',this.orderId)!==null
      if(!order.canApplyAfterSale && !this.pending)this.message=order.afterSaleNotice||'当前订单暂不能申请售后'
    } catch {if(this.current(generation,token))this.message='订单读取失败，请重试'}
    finally {if(this.current(generation,token))this.loading=false}
  }
  private stepCount(index: number,delta: number): void {
    if(this.busy||this.pending||!this.lines[index]||!this.lineAllowed(this.lines[index]))return
    this.lines[index].count=Math.max(0,Math.min(this.lines[index].remaining||0,this.lines[index].count+delta));this.lines=this.lines.slice()
  }
  private quantityHint():string {return this.lines.some((line:AfterSaleLine):boolean=>line.count>0)?'':'请至少选择 1 件'}
  private lineAllowed(line: AfterSaleLine): boolean {
    return (!line.afterSaleKinds || line.afterSaleKinds.includes(this.kind)) && (this.kind !== 'return-no-reason' || returnPolicyAllowsNoReason(line))
  }
  private excludeRestrictedLines(): void {
    this.lines.forEach((line: AfterSaleLine) => { if (!this.lineAllowed(line)) line.count = 0 })
    this.lines = this.lines.slice()
  }
  private selectKind(kind: string): void {
    if (this.busy || this.pending || !this.order?.afterSaleKinds?.includes(kind)) return
    this.kind = kind; this.message = ''; this.excludeRestrictedLines()
  }
  private chooseCondition(index: number, condition: string): void {
    if (this.busy || this.pending || !this.lines[index] || (condition !== 'sealed' && condition !== 'unsealed')) return
    this.lines[index].conditionDeclared = condition; this.lines = this.lines.slice(); this.message = ''
  }
  private conditionText(line: AfterSaleLine, condition: string): string {
    return (condition === 'sealed' ? '未' : '已') + (line.returnPolicyReason === 'activated' ? '激活或试用' : '拆封')
  }
  private canSubmit():boolean {return !this.busy&&!this.loading&&(this.pending||!!this.order?.canApplyAfterSale&&!this.quantityHint())}
  private total(): string {return (afterSaleAmount(this.lines)/100).toFixed(2)}
  private async choosePhoto(): Promise<void> {
    if(this.busy||this.pending||this.photos.length>=3)return
    const generation=this.generation,token=this.token;this.busy=true
    try {const bytes=await pickProductImage();if(this.current(generation,token)&&bytes)this.photos=this.photos.concat([{bytes,requestKey:util.generateRandomUUID()}])}
    catch {if(this.current(generation,token))this.message='照片读取失败，请重新选择'}
    finally {if(this.current(generation,token))this.busy=false}
  }
  private requestSubmit(): void {
    if(this.busy||this.loading||!this.order)return
    if(this.pending){void this.submit();return}
    if(!this.order.canApplyAfterSale)return
    this.message=afterSaleInputError(this.lines,this.kind,this.description)
    if(this.message)return
    if(this.order.orderState===3) {
      const generation=this.generation,token=this.token
      this.getUIContext().showAlertDialog({title:'申请售后',message:'提交后视为已收到货，是否继续？',
        primaryButton:{value:'再看看',action:()=>{}},secondaryButton:{value:'确认提交',action:()=>{if(this.current(generation,token))void this.submit()}}})
    } else void this.submit()
  }
  private async submit(): Promise<void> {
    if(this.busy||this.loading||!this.current(this.generation,this.token))return
    if (!this.pending) {
      if (!this.order?.canApplyAfterSale) return
      this.message = afterSaleInputError(this.lines, this.kind, this.description)
      if (this.message) return
    }
    const generation=this.generation,token=this.token;this.busy=true;this.message=''
    try {
      if(this.pending)await afterSaleActions.resume(this.orderId,token)
      else {
        const body: AfterSaleBody={kind:this.kind,description:this.description.trim(),imageIds:[],items:this.lines.filter((line: AfterSaleLine): boolean => line.count>0).map((line: AfterSaleLine): AfterSaleQuantity => {return {skuId:line.skuId,count:line.count,
          conditionDeclared:this.kind==='return-no-reason'&&returnConditionRequired(line)?line.conditionDeclared:undefined}})}
        await afterSaleActions.start(this.orderId,'/member/order/'+encodeURIComponent(this.orderId)+'/after-sales',body,this.kind==='return-quality'?this.photos:[],token)
      }
      if(this.current(generation,token))this.stackPath.pop()
    } catch(error) {
      if(this.current(generation,token)) {
        this.pending=afterSaleActions.pending(this.user.id||'',this.orderId)!==null
        this.message=this.pending?'售后结果待确认，输入已保留，请重试确认':orderWriteFailure(error as Error).message||'提交未完成，请核对输入后重试'
      }
    } finally {if(this.current(generation,token))this.busy=false}
  }
  @Builder
  private Form() {
    Column({space:14}) {
      ForEach(this.lines,(line: AfterSaleLine,index: number)=>{
        Column({space:6}) {
          Text(line.name+' · '+line.spec).fontColor($r('[ui_components].color.text')).width('100%')
          Text('下单单价 ¥'+(line.priceCents/100).toFixed(2)+'，可售后 '+String(line.remaining||0)+' 件').fontSize(13).fontColor($r('[ui_components].color.gray'))
          if (returnPolicyAfterSaleHint(line)) {
            Text(returnPolicyAfterSaleHint(line)).id('after-sale-policy-'+index).fontSize(14).fontColor($r('[ui_components].color.text')).width('100%')
          }
          if (!this.lineAllowed(line)) {
            Text('该商品不适用当前类型，未选入本次申请；可切换为质量问题退货后增加数量。')
              .fontSize(13).fontColor($r('[ui_components].color.red')).width('100%')
          }
          Text('申请数量').fontColor($r('[ui_components].color.text')).width('100%')
          Row({space:16}) {
            Button('−').id('after-sale-count-minus-'+index).enabled(!this.busy&&!this.pending&&this.lines[index].count>0).backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).onClick(()=>this.stepCount(index,-1))
            Text(String(this.lines[index].count)).id('after-sale-count-'+index).fontColor($r('[ui_components].color.text'))
            Button('+').id('after-sale-count-plus-'+index).enabled(!this.busy&&!this.pending&&this.lineAllowed(line)&&this.lines[index].count<(this.lines[index].remaining||0)).backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).onClick(()=>this.stepCount(index,1))
          }.width('100%')
          if (this.kind === 'return-no-reason' && this.lines[index].count > 0 && returnConditionRequired(line)) {
            Text('请如实选择商品状态').fontColor($r('[ui_components].color.text')).width('100%')
            ForEach(['sealed', 'unsealed'], (condition: string) => {
              Button(this.conditionText(line, condition) + (this.lines[index].conditionDeclared === condition ? ' ✓ 已选' : ''))
                .id('after-sale-condition-' + index + '-' + condition).width('100%')
                .backgroundColor(this.lines[index].conditionDeclared === condition ? $r('[ui_components].color.red') : $r('[ui_components].color.white'))
                .fontColor(this.lines[index].conditionDeclared === condition ? $r('[ui_components].color.loading_foreground') : $r('[ui_components].color.text'))
                .border({width:1,color:$r('[ui_components].color.border')}).enabled(!this.busy && !this.pending)
                .onClick(() => this.chooseCondition(index, condition))
            })
            if (this.lines[index].conditionDeclared === 'unsealed') {
              Text(returnConditionError(line, this.lines[index].conditionDeclared)).fontSize(14).fontColor($r('[ui_components].color.red')).width('100%')
            }
          }
        }.width('100%').padding(12).backgroundColor($r('[ui_components].color.white')).borderRadius(12)
      },(line: AfterSaleLine)=>line.skuId)
      Text('售后类型').fontColor($r('[ui_components].color.text')).width('100%')
      ForEach(this.order?.afterSaleKinds||[],(kind:string)=>{
        Button(afterSaleKind(kind)+(this.kind===kind?' ✓ 已选':'')).id('after-sale-kind-'+kind).width('100%')
          .backgroundColor(this.kind===kind?$r('[ui_components].color.red'):$r('[ui_components].color.white'))
          .fontColor(this.kind===kind?Color.White:$r('[ui_components].color.text')).enabled(!this.busy&&!this.pending)
          .onClick(()=>this.selectKind(kind))
      })
      // 七日无理由退货 / 质量问题退货 / 少件漏发仅退款
      Text(this.kind==='return-no-reason'?'退货运费由买家承担':'运费由商家承担').fontSize(13).fontColor($r('[ui_components].color.gray')).width('100%')
      Text(this.kind==='return-no-reason'?'说明（选填）':'问题说明（5–200字）').fontColor($r('[ui_components].color.text')).width('100%')
      TextArea({text:this.description,placeholder:'请描述需要处理的问题'}).id('after-sale-description').height(100).maxLength(200).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.white')).enabled(!this.busy&&!this.pending).onChange((value:string)=>this.description=value)
      if(this.kind==='return-quality') {
        Text('照片（选填，最多3张）').fontColor($r('[ui_components].color.text')).width('100%')
        ForEach(this.photos,(photo:AfterSalePhoto,index:number)=>{
          Row({space:8}) {
            Image('data:image/jpeg;base64,'+photo.bytes).width(72).height(72).objectFit(ImageFit.Cover)
            Button('移除照片 '+(index+1)).backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(!this.busy&&!this.pending).onClick(()=>this.photos=this.photos.filter((_photo:AfterSalePhoto,i:number):boolean=>i!==index))
          }
        },(photo:AfterSalePhoto)=>photo.requestKey)
        Button('选择照片').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).enabled(!this.busy&&!this.pending&&this.photos.length<3).onClick(()=>this.choosePhoto())
      }
    }.width('100%').padding(16)
  }
  build() {
    NavDestination() {
      Column() {
        HDMNavBar({title:'申请售后',onLeftClick:()=>this.stackPath.pop()})
        if(this.message){Text(this.message).id('after-sale-message').fontColor($r('[ui_components].color.red')).padding(12)}
        if(this.loading){LoadingProgress().width(40).height(40)}
        Scroll(){this.Form()}.align(Alignment.Top).layoutWeight(1).width('100%')
        Column({space:8}) {
          Text('预计退款 ¥'+this.total()+'，退回 '+(this.order?.payerAccount||'实际付款人账号')).id('after-sale-estimate').fontColor($r('[ui_components].color.text')).fontSize(15)
          if(!this.pending&&this.quantityHint()){Text(this.quantityHint()).fontColor($r('[ui_components].color.red'))}
          Button(this.busy?'正在提交':this.pending?'重试确认结果':'提交申请').id('after-sale-submit').width('100%').backgroundColor($r('[ui_components].color.red')).enabled(this.canSubmit()).onClick(()=>this.requestSubmit())
          if(!this.order&&!this.loading){Button('重新加载').onClick(()=>this.load())}
        }.padding(16).width('100%')
      }.width('100%').height('100%').padding({top:this.safeTop,bottom:this.safeBottom}).backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true).onReady((context:NavDestinationContext)=>{this.orderId=context.pathInfo.param as string;void this.load()})
    .onShown(()=>{this.active=true}).onHidden(()=>{this.active=false;this.generation++;this.busy=false})
  }
}
