import { util } from '@kit.ArkTS'
import { GlobalVariable } from 'constants'
import { HDMUser, AfterSale, AfterSaleAddress, AfterSaleBody, AfterSaleLine, AfterSaleRestock, AfterSalePage, AfterSaleCounts, afterSaleStatus, afterSaleKind, formatBeijingTime, returnConditionLabel } from 'models'
import { RequestAxios } from 'network'
import { afterSaleActions } from 'storage'
import { HDMNavBar, AfterSalePhotos } from 'ui_components'
import { amountInputCents, shippingAdjustmentError, shippingCompensationText } from 'models'

@Builder
function AfterSaleManageViewBuilder() { AfterSaleManageView() }

@Component
export struct AfterSaleManageView {
  @Consume stackPath: NavPathStack
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) safeTop: number = 0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('accountChanged') user: HDMUser = {} as HDMUser
  @State items: AfterSale[] = []
  @State filter: string = 'pending'
  @State page: number = 1
  @State pages: number = 0
  @State loading: boolean = false
  @State busy: boolean = false
  @State pending: boolean = false
  @State message: string = ''
  @State messageType: string = 'error'
  @State stateCounts: AfterSaleCounts = {pending:0,returned:0,all:0}
  @State addressTouched: string[] = []
  @State addressSubmitted: boolean = false
  @State defaultAddress: AfterSaleAddress | null = null
  @State editorOpen: boolean = false
  @State selected: AfterSale | null = null
  @State action: string = ''
  @State receiver: string = ''
  @State contact: string = ''
  @State address: string = ''
  @State reason: string = ''
  @State shippingCompensation: string = ''
  @State shippingReason: string = ''
  @State lines: AfterSaleLine[] = []
  @State now: number = Date.now()
  private active: boolean = false
  private token: string = ''
  private accountId: string = ''
  private generation: number = 0
  private query: number = 0
  private timer: number = -1
  private serverOffset: number = 0
  private messageColor():ResourceColor {return this.messageType==='success'?$r('[ui_components].color.text'):$r('[ui_components].color.red')}
  private filterSelected(filter:string):boolean {return this.filter===filter}
  private filterLabel(filter:string):string {return filter==='pending'?'待处理 '+this.stateCounts.pending:filter==='returned'?'待验收 '+this.stateCounts.returned:'全部 '+this.stateCounts.all}
  private lateInspection():boolean {return !!this.selected?.inspectionPending&&['refunding','refunded','completed'].includes(this.selected?.state||'')}
  private actionLabel():string {
    if(this.pending)return '重试确认结果'
    if(this.action==='inspect'&&this.lateInspection())return '确认补验收，仅记录入库'
    const principal=this.selected?.amountCents||0
    const shipping=this.action==='inspect'?Math.max(0,amountInputCents(this.shippingCompensation)):0
    const amount=' ¥'+((principal+shipping)/100).toFixed(2)
    if(this.action==='address')return '保存退货地址'
    if(this.action==='inspect')return principal+shipping===0?'验收完成，无需退款':'验收并退款'+amount
    if(this.action==='approve')return this.selected?.kind==='refund-missing'?(principal===0?'同意售后，无需货款退款':'同意并退款'+amount):'同意并发送退货地址'
    return this.action==='refund-reject'?'拒绝退款':'拒绝申请'
  }
  private fieldError(field:string):string {
    if(!this.addressSubmitted&&!this.addressTouched.includes(field))return ''
    if(field==='receiver'&&(!this.receiver.trim()||this.receiver.trim().length>50))return '请填写收件人（最多50字）'
    if(field==='contact'&&!/^\d{6,20}$/.test(this.contact.trim()))return '请填写6到20位联系电话'
    if(field==='address'&&(!this.address.trim()||this.address.trim().length>300))return '请填写退货地址（最多300字）'
    return ''
  }
  private touchAddress(field:string):void {if(!this.addressTouched.includes(field))this.addressTouched=this.addressTouched.concat([field])}
  private stepRestock(index:number,delta:number):void {
    if(this.busy||this.pending||!this.lines[index])return
    this.lines[index].restockCount=Math.max(0,Math.min(this.lines[index].count,Number(this.lines[index].restockCount||0)+delta));this.lines=this.lines.slice()
  }
  private amountText(sale:AfterSale):string {
    if(sale.amountCents===0)return sale.amountMessage||'货款 0 元，无需退款'
    const amount='¥'+(sale.amountCents/100).toFixed(2)
    if(sale.state==='refunded')return '已退款 '+amount+'，退回 '+sale.payerAccount
    if(sale.state==='refunding')return '退款中 '+amount+'，退回 '+sale.payerAccount
    if(['withdrawn','rejected','closed','refund-rejected'].includes(sale.state))return '申请金额 '+amount+'，未退款'
    return '申请退款 '+amount+'，将退回 '+sale.payerAccount
  }
  private restockText(sale:AfterSale):string {
    if(sale.kind==='refund-missing')return '少件仅退款，不涉及退货入库'
    if(sale.inspectionState==='none'||['pending','awaiting-return','closed','withdrawn','rejected'].includes(sale.state))return ''
    const total=(sale.items||[]).reduce((sum:number,line:AfterSaleLine):number=>sum+line.count,0)
    if(sale.inspectionPending)return '已寄回待验收 '+total+' 件（不入可售库存）'
    const stored=(sale.items||[]).reduce((sum:number,line:AfterSaleLine):number=>sum+(line.restockCount||0),0)
    return '退回 '+total+' 件，合格入库 '+stored+' 件，不合格 '+(total-stored)+' 件（不入可售库存）'
  }
  private synchronize(): void {
    if (this.token === (this.user.token || '') && this.accountId === (this.user.id || '')) return
    this.token=this.user.token||'';this.accountId=this.user.id||'';this.generation++;this.query++
    this.items=[];this.stateCounts={pending:0,returned:0,all:0};this.selected=null;this.lines=[];this.defaultAddress=null;this.editorOpen=false
    this.shippingCompensation='';this.shippingReason=''
    this.receiver='';this.contact='';this.address='';this.reason='';this.message='';this.busy=false;this.pending=false;this.loading=false
  }
  private current(generation:number,token:string):boolean {
    return this.active && generation===this.generation && !!token && token===this.token && token===this.user.token && this.accountId===this.user.id && this.user.role==='merchant'
  }
  private accountChanged():void {this.synchronize();if(this.active)void this.load(1)}
  aboutToAppear():void {this.shown()}
  aboutToDisappear():void {this.active=false;this.generation++;this.query++;this.loading=false;this.busy=false;this.editorOpen=false;if(this.timer!==-1){clearInterval(this.timer);this.timer=-1}}
  private shown():void {
    if(this.active)return
    this.active=true;void this.load(this.page)
    this.timer=setInterval(()=>{this.now=Date.now()+this.serverOffset;if(!this.loading&&!this.busy&&!this.editorOpen)void this.load(this.page)},30000)
  }
  private async load(page:number):Promise<void> {
    this.synchronize();const generation=this.generation,token=this.token,query=++this.query
    if(!this.current(generation,token)){this.messageType='error';this.message='请使用商家账号登录';return}
    this.loading=true
    try {
      const result=await RequestAxios.getForSession<AfterSalePage>('/merchant/after-sales?state='+this.filter+'&page='+page+'&pageSize=10',token)
      if(!this.current(generation,token)||query!==this.query)return
      this.items=result.items;this.page=result.page;this.pages=result.pages;this.stateCounts=result.stateCounts||{pending:0,returned:0,all:0}
      if(result.items[0]?.serverNow){this.serverOffset=(result.items[0].serverNow||0)-Date.now();this.now=Date.now()+this.serverOffset}
      if(this.page>1&&this.page>this.pages){await this.load(Math.max(1,this.pages));return}
      const address=await RequestAxios.getForSession<AfterSaleAddress|null>('/merchant/settings/return-address',token)
      if(this.current(generation,token)&&query===this.query)this.defaultAddress=address
    }catch{if(this.current(generation,token)&&query===this.query){this.messageType='error';this.message='售后信息读取失败，请稍后重试'}}
    finally{if(this.current(generation,token)&&query===this.query)this.loading=false}
  }
  private hasPending(sale:AfterSale):boolean {try{return afterSaleActions.pending(this.accountId,sale.orderId)!==null}catch{return true}}
  private open(sale:AfterSale|null,action:string):void {
    if(!this.current(this.generation,this.token)||this.busy)return
    this.selected=sale;this.action=action;this.message='';this.messageType='error';this.reason='';this.addressTouched=[];this.addressSubmitted=false
    this.pending=sale?this.hasPending(sale):false
    this.shippingCompensation=((sale?.shippingAmountCents||0)/100).toFixed(2);this.shippingReason=''
    this.receiver=this.defaultAddress?.receiver||'';this.contact=this.defaultAddress?.contact||'';this.address=this.defaultAddress?.address||''
    this.lines=(sale?.items||[]).map((line:AfterSaleLine):AfterSaleLine=>{return {skuId:line.skuId,name:line.name,spec:line.spec,priceCents:line.priceCents,count:line.count,restockCount:line.count,
      conditionDeclared:line.conditionDeclared,returnPolicyReason:line.returnPolicyReason}})
    this.editorOpen=true
  }
  private addressError():string {
    if(!this.receiver.trim()||this.receiver.trim().length>50)return '请填写收件人（最多50字）'
    if(!/^\d{6,20}$/.test(this.contact.trim()))return '请填写6到20位联系电话'
    if(!this.address.trim()||this.address.trim().length>300)return '请填写退货地址（最多300字）'
    return ''
  }
  private async submit():Promise<void> {
    const generation=this.generation,token=this.token,sale=this.selected
    if(this.busy||!this.current(generation,token)||(!sale&&this.action!=='address'))return
    this.messageType='error'
    const body:AfterSaleBody={}
    if(!this.pending) {
      if(this.action==='address'||(this.action==='approve'&&sale?.kind!=='refund-missing')) {
        this.addressSubmitted=true;this.message=this.addressError();if(this.message)return
        body.returnAddress={receiver:this.receiver.trim(),contact:this.contact.trim(),address:this.address.trim()}
      }
      if(this.action==='reject'||this.action==='refund-reject') {
        if(this.reason.trim().length<5||this.reason.trim().length>200){this.message='请填写5到200字的拒绝原因';return}
        body.reason=this.reason.trim()
      }
      if(this.action==='inspect') {
        if(!this.lateInspection()&&sale?.shippingAmountCents!==undefined&&sale?.shippingAmountCents!==null){
          this.message=shippingAdjustmentError(this.shippingCompensation,sale.shippingAmountCents,this.shippingReason);if(this.message)return
          body.shippingCompensationCents=amountInputCents(this.shippingCompensation)
          if(body.shippingCompensationCents<sale.shippingAmountCents)body.shippingAdjustmentReason=this.shippingReason.trim()
        }
        if(this.lines.some((line:AfterSaleLine):boolean=>!Number.isInteger(line.restockCount)||Number(line.restockCount)<0||Number(line.restockCount)>line.count)){this.message='请核对合格入库数量';return}
        body.items=this.lines.map((line:AfterSaleLine):AfterSaleRestock=>{return {skuId:line.skuId,restockCount:Number(line.restockCount)}})
      }
    }
    this.busy=true;this.message=''
    try {
      if(this.action==='address'&&body.returnAddress)await RequestAxios.putForSession<AfterSaleAddress>('/merchant/settings/return-address',body.returnAddress,token)
      else if(sale) {
        if(this.pending)await afterSaleActions.resume(sale.orderId,token)
        else await afterSaleActions.start(sale.orderId,'/merchant/after-sales/'+encodeURIComponent(sale.id)+'/'+this.action,body,[],token)
      }
      if(!this.current(generation,token))return
      this.pending=false;this.editorOpen=false;this.messageType='success';this.message='处理已完成';await this.load(this.page)
    }catch{if(this.current(generation,token)){this.pending=sale?this.hasPending(sale):false;this.messageType='error';this.message=this.pending?'处理结果待确认，请重试确认':'处理未完成，请核对输入并刷新后重试'}}
    finally{if(this.current(generation,token))this.busy=false}
  }
  private deadline(sale:AfterSale):number {return sale.state==='pending'?sale.reviewDeadline:sale.state==='returned'?(sale.inspectDeadline||0):0}
  private urgent(sale:AfterSale):boolean {const deadline=this.deadline(sale);return !!sale.needsReturnAddress||(deadline>0&&deadline-this.now<=12*3600000)}
  private countdown(sale:AfterSale):string {
    if(sale.needsReturnAddress)return '已到自动同意时间，请先设置默认退货地址'
    const deadline=this.deadline(sale);if(!deadline)return ''
    const hours=Math.max(0,Math.ceil((deadline-this.now)/360000)/10)
    return (sale.state==='pending'?hours+' 小时后自动同意':(Math.ceil(Math.max(0,deadline-this.now)/8640000)/10)+' 天后自动退款')+' · '+formatBeijingTime(deadline)
  }
  private async photo(path:string):Promise<string>{const generation=this.generation,token=this.token;const bytes=await RequestAxios.getImageForSession(path,token);if(!this.current(generation,token))throw new Error('会话已变化');return 'data:image/jpeg;base64,'+new util.Base64Helper().encodeToStringSync(new Uint8Array(bytes))}
  @Builder
  private Editor() {
    Column({space:12}) {
      Text(this.pending?'确认上次处理结果':this.action==='address'?'默认退货地址':this.action==='inspect'?(this.lateInspection()?'补验收入库':'验收并退款'):this.action==='approve'?'同意售后':'拒绝原因').fontSize(22).fontColor($r('[ui_components].color.text'))
      Scroll() {
        Column({space:12}) {
          if(!this.pending&&(this.action==='address'||(this.action==='approve'&&this.selected?.kind!=='refund-missing'))) {
            Text('首次填写后保存为默认退货地址').fontColor($r('[ui_components].color.text'))
            Text('收件人').width('100%').fontColor($r('[ui_components].color.text'))
            TextInput({text:this.receiver,placeholder:'收件人'}).id('after-sale-receiver').fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.under')).enabled(!this.busy).onChange((value:string)=>{this.receiver=value;this.touchAddress('receiver')})
            if(this.fieldError('receiver')){Text(this.fieldError('receiver')).width('100%').fontColor($r('[ui_components].color.red'))}
            Text('联系电话').width('100%').fontColor($r('[ui_components].color.text'))
            TextInput({text:this.contact,placeholder:'联系电话'}).id('after-sale-contact').type(InputType.PhoneNumber).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.under')).enabled(!this.busy).onChange((value:string)=>{this.contact=value;this.touchAddress('contact')})
            if(this.fieldError('contact')){Text(this.fieldError('contact')).width('100%').fontColor($r('[ui_components].color.red'))}
            Text('退货地址').width('100%').fontColor($r('[ui_components].color.text'))
            TextInput({text:this.address,placeholder:'完整退货地址'}).id('after-sale-address').fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.under')).enabled(!this.busy).onChange((value:string)=>{this.address=value;this.touchAddress('address')})
            if(this.fieldError('address')){Text(this.fieldError('address')).width('100%').fontColor($r('[ui_components].color.red'))}
          }
          if(!this.pending&&(this.action==='reject'||this.action==='refund-reject')) {
            TextArea({text:this.reason,placeholder:'拒绝原因（5–200字）'}).id('after-sale-reason').height(120).maxLength(200).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.under')).enabled(!this.busy).onChange((value:string)=>this.reason=value)
          }
          if(!this.pending&&this.action==='inspect') {
            if(!this.lateInspection()&&this.selected?.shippingAmountCents){
              Text('买家实付运费 ¥'+(this.selected.shippingAmountCents/100).toFixed(2)+'，默认按买家填写补偿').id('merchant-shipping-paid').fontColor($r('[ui_components].color.text'))
              if(this.selected.shippingImage){AfterSalePhotos({images:[this.selected.shippingImage],loadImage:(path:string):Promise<string>=>this.photo(path)})}
              Text('补偿运费（元）').fontColor($r('[ui_components].color.text')).width('100%')
              TextInput({text:this.shippingCompensation,placeholder:'默认全额补偿'}).id('merchant-shipping-amount').type(InputType.NUMBER_DECIMAL).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.under')).enabled(!this.busy).onChange((value:string)=>this.shippingCompensation=value)
              if(amountInputCents(this.shippingCompensation)<this.selected.shippingAmountCents){
                TextArea({text:this.shippingReason,placeholder:'下调原因（5–200字，买家可见）'}).id('merchant-shipping-reason').height(100).maxLength(200).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.under')).enabled(!this.busy).onChange((value:string)=>this.shippingReason=value)
              }
            }
            Text(this.lateInspection()?'退款已处理，本次只把合格的件数入库，不会再次退款':'退款按申请数量计算，只把合格的件数入库').fontColor($r('[ui_components].color.text'))
            ForEach(this.lines,(line:AfterSaleLine,index:number)=>{
              Text(line.name+' · '+line.spec+'，退回 '+line.count+' 件').fontColor($r('[ui_components].color.text'))
              if (returnConditionLabel(line.returnPolicyReason, line.conditionDeclared)) {
                Text(returnConditionLabel(line.returnPolicyReason, line.conditionDeclared)).id('merchant-condition-' + index).fontColor($r('[ui_components].color.text'))
              }
              Text('合格入库数量').fontColor($r('[ui_components].color.text'))
              Row({space:12}) {
                Button('−').id('after-sale-restock-minus-'+index).enabled(!this.busy&&!this.pending&&Number(this.lines[index].restockCount)>0).onClick(()=>this.stepRestock(index,-1)).backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text'))
                Text(String(this.lines[index].restockCount)).id('after-sale-restock-'+index).fontColor($r('[ui_components].color.text'))
                Button('+').id('after-sale-restock-plus-'+index).enabled(!this.busy&&!this.pending&&Number(this.lines[index].restockCount)<this.lines[index].count).onClick(()=>this.stepRestock(index,1)).backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text'))
                Text('不合格的不入库').fontSize(12).fontColor($r('[ui_components].color.gray'))
              }.width('100%')
            },(line:AfterSaleLine)=>line.skuId)
          }
          if(this.selected){Text(this.amountText(this.selected)).fontColor($r('[ui_components].color.text'))}
          if(this.message){Text(this.message).fontColor(this.messageColor())}
        }.width('100%')
      }.layoutWeight(1).width('100%').align(Alignment.Top)
      Button(this.busy?'处理中':this.actionLabel()).id('after-sale-confirm').backgroundColor($r('[ui_components].color.red')).enabled(!this.busy).width('100%').onClick(()=>this.submit())
      if(!this.pending&&!this.lateInspection()&&this.action==='inspect'&&this.selected?.kind==='return-no-reason') {
        Button('商品不完好，拒绝退款').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).enabled(!this.busy).onClick(()=>this.open(this.selected,'refund-reject'))
      }
    }.padding({top:28,left:20,right:20,bottom:20+this.safeBottom}).width('100%').height('100%').backgroundColor($r('[ui_components].color.white'))
  }
  @Builder
  private Card(sale:AfterSale) {
    Column({space:10}) {
      Text(afterSaleKind(sale.kind)+' · '+afterSaleStatus(sale)).fontSize(18).fontColor($r('[ui_components].color.text'))
      Text((sale.buyerAccount||'买家')+' · '+formatBeijingTime(sale.createdAt)).fontSize(12).fontColor($r('[ui_components].color.gray'))
      Text(this.amountText(sale)).fontColor($r('[ui_components].color.text'))
      if(shippingCompensationText(sale)){Text(shippingCompensationText(sale)).fontColor($r('[ui_components].color.text'))}
      if(this.countdown(sale)){Text(this.countdown(sale)).fontColor(this.urgent(sale)?$r('[ui_components].color.red'):$r('[ui_components].color.text'))}
      if(sale.description){Text('问题说明：'+sale.description).fontColor($r('[ui_components].color.text'))}
      ForEach(sale.items||[],(line:AfterSaleLine)=>{
        Text(line.name+' · '+line.spec+' × '+line.count).fontColor($r('[ui_components].color.text'))
        if((sale.items||[]).length>1&&sale.inspectionState!=='none') {
          Text(sale.inspectionPending?'已寄回待验收 '+line.count+' 件':'合格入库 '+(line.restockCount||0)+' 件，不合格 '+(line.rejectedCount||0)+' 件（不入可售库存）').fontSize(14).fontColor($r('[ui_components].color.text'))
        }
        if (returnConditionLabel(line.returnPolicyReason, line.conditionDeclared)) {
          Text(returnConditionLabel(line.returnPolicyReason, line.conditionDeclared)).fontColor($r('[ui_components].color.text'))
        }
      },(line:AfterSaleLine)=>line.skuId)
      if((sale.images||[]).length){AfterSalePhotos({images:sale.images||[],loadImage:(path:string):Promise<string>=>this.photo(path)})}
      if(this.restockText(sale)){Text(this.restockText(sale)).id('after-sale-restock-result').fontColor($r('[ui_components].color.text'))}
      if(sale.carrier){Text('寄回：'+sale.carrier+' '+sale.trackingNo).fontColor($r('[ui_components].color.text'))}
      if(sale.rejectReason){Text(sale.rejectReason).fontColor($r('[ui_components].color.red'))}
      if(this.hasPending(sale)){Button('重试确认结果').backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary')).onClick(()=>this.open(sale,'resume'))}
      else if(sale.state==='pending') {
        Row({space:12}) {
          Button('同意').id('after-sale-approve-'+sale.id).backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary')).onClick(()=>this.open(sale,'approve'))
          Button('拒绝').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).onClick(()=>this.open(sale,'reject'))
        }
      } else if(sale.inspectionPending) {
        Button(sale.state==='returned'?'验收并退款':'补验收入库').id('after-sale-inspect-'+sale.id).backgroundColor($r('[ui_components].color.red')).fontColor($r('[ui_components].color.on_primary')).onClick(()=>this.open(sale,'inspect'))
        if(sale.state==='returned'&&sale.kind==='return-no-reason'){Button('拒绝退款').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).onClick(()=>this.open(sale,'refund-reject'))}
      }
    }.alignItems(HorizontalAlign.Start).width('100%').padding(16).backgroundColor($r('[ui_components].color.white')).borderRadius(12)
  }
  build() {
    NavDestination() {
      Column() {
        HDMNavBar({title:'售后处理'})
        Row({space:8}) {
          ForEach(['pending','returned','all'],(filter:string)=>{
            Button(this.filterLabel(filter)+(this.filterSelected(filter)?' ✓':'')).id('after-sale-filter-'+filter)
              .backgroundColor(this.filterSelected(filter)?$r('[ui_components].color.red'):$r('[ui_components].color.white'))
              .fontColor(this.filterSelected(filter)?Color.White:$r('[ui_components].color.red'))
              .border({width:1,color:$r('[ui_components].color.red')}).onClick(()=>{this.filter=filter;void this.load(1)})
          })
        }.padding(10)
        Scroll() {
          Column({space:12}) {
            if(!this.defaultAddress){Text('尚未设置默认退货地址，退货申请到期后需处理').fontColor($r('[ui_components].color.red'))}
            Button('设置默认退货地址').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).onClick(()=>this.open(null,'address'))
            if(this.message){Row({space:8}) {
              Text(this.messageType==='success'?'✓':'!').fontColor(this.messageColor())
              Text(this.message).id('after-sale-manage-message').fontColor(this.messageColor())
            }.width('100%').padding(12).backgroundColor($r('[ui_components].color.under')).borderRadius(8)}
            ForEach(this.items,(sale:AfterSale)=>{this.Card(sale)},(sale:AfterSale)=>JSON.stringify(sale)+':'+this.accountId)
            if(!this.loading&&!this.items.length){Text('暂无相关售后申请').fontColor($r('[ui_components].color.text'))}
            Row({space:12}) {
              Button('上一页').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).enabled(!this.loading&&this.page>1).onClick(()=>this.load(this.page-1))
              Text(this.page+' / '+Math.max(1,this.pages)).fontColor($r('[ui_components].color.text'))
              Button('下一页').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).enabled(!this.loading&&this.page<this.pages).onClick(()=>this.load(this.page+1))
            }
          }.padding(16).width('100%')
        }.align(Alignment.Top).layoutWeight(1).width('100%')
      }.width('100%').height('100%').padding({top:this.safeTop,bottom:this.safeBottom}).backgroundColor($r('[ui_components].color.under'))
      .bindSheet($$this.editorOpen,this.Editor(),{height:SheetSize.LARGE,backgroundColor:$r('[ui_components].color.white')})
    }.hideTitleBar(true).onShown(()=>this.shown()).onHidden(()=>this.aboutToDisappear())
  }
}
