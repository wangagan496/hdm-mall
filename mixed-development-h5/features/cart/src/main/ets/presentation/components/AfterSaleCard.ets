import { pasteboard } from '@kit.BasicServicesKit'
import { util } from '@kit.ArkTS'
import { RequestAxios } from 'network'
import { AfterSalePhotos, pickProductImage } from 'ui_components'
import { GlobalVariable } from 'constants'
import { HDMUser, AfterSale, AfterSaleBody, AfterSalePhoto, afterSaleStatus, afterSaleKind, formatBeijingTime, amountInputCents, returnShippingError, shippingCompensationText } from 'models'
import { afterSaleActions } from 'storage'
import { orderWriteFailure } from '../utils/OrderWriteFailure'

@Component
export struct AfterSaleCard {
  @Prop sale: AfterSale
  @Prop owner: boolean = false
  @Prop ready: boolean = false
  onComplete: () => void = () => {}
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('changedAccount') user: HDMUser = {} as HDMUser
  @State carrier: string = ''
  @State trackingNo: string = ''
  @State shippingAmount: string = ''
  @State shippingPhotos: AfterSalePhoto[] = []
  @State busy: boolean = false
  @State pending: boolean = false
  @State message: string = ''
  private active: boolean = false
  private generation: number = 0
  aboutToAppear(): void {this.active=true;this.pending=afterSaleActions.pending(this.user.id||'',this.sale.orderId)!==null}
  aboutToDisappear(): void {this.active=false;this.generation++}
  private changedAccount(): void {this.generation++;this.carrier='';this.trackingNo='';this.shippingAmount='';this.shippingPhotos=[];this.busy=false;this.pending=false;this.message=''}
  private async chooseShippingPhoto():Promise<void> {
    if(this.busy||this.pending||!this.owner||!this.ready)return
    const generation=this.generation,token=this.user.token||'';this.busy=true
    try {const bytes=await pickProductImage();if(this.current(generation,token)&&bytes)this.shippingPhotos=[{bytes,requestKey:util.generateRandomUUID()}]}
    catch {if(this.current(generation,token))this.message='运单读取失败，请重新选择JPEG图片'}
    finally {if(this.current(generation,token))this.busy=false}
  }
  private current(generation:number,token:string):boolean{return this.active&&this.generation===generation&&!!token&&token===this.user.token}
  private async photo(path:string):Promise<string>{const generation=this.generation,token=this.user.token||'';const bytes=await RequestAxios.getImageForSession(path,token);if(!this.current(generation,token))throw new Error('会话已变化');return 'data:image/jpeg;base64,'+new util.Base64Helper().encodeToStringSync(new Uint8Array(bytes))}
  private async copyAddress():Promise<void> {
    const address=this.sale.returnAddress;if(!address||!this.owner||!this.ready)return
    try {await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN,address.receiver+' '+address.contact+' '+address.address));this.message='退货地址已复制'}catch{this.message='复制失败，请手动记录地址'}
  }
  private deadlineText():string {
    return this.sale.state==='pending'?'商家最晚 '+formatBeijingTime(this.sale.reviewDeadline)+' 处理，超时自动同意':
      '商家最晚 '+formatBeijingTime(this.sale.inspectDeadline||0)+' 验收，超时自动退款'
  }
  private requestWithdraw():void {
    if(!this.owner||!this.ready||this.busy||this.pending||!['pending','awaiting-return'].includes(this.sale.state))return
    const generation=this.generation,token=this.user.token||''
    this.getUIContext().showAlertDialog({title:'撤回售后申请',message:'撤回后需在售后期内重新申请',
      primaryButton:{value:'继续售后',action:()=>{}},secondaryButton:{value:'确认撤回',action:()=>{if(this.current(generation,token))void this.act('withdraw')}}})
  }
  private async act(action:string):Promise<void> {
    if(this.busy||!this.ready||!this.owner)return
    const token=this.user.token||'',generation=this.generation
    if(!this.current(generation,token))return
    if(!this.pending&&action==='ship-back'&&(!this.carrier.trim()||!/^[A-Za-z0-9-]{5,60}$/.test(this.trackingNo.trim()))){this.message='请填写快递公司和正确的单号';return}
    if(!this.pending&&action==='ship-back'){this.message=returnShippingError(this.shippingAmount,this.shippingPhotos.length);if(this.message)return}
    this.busy=true;this.message=''
    try {
      if(this.pending)await afterSaleActions.resume(this.sale.orderId,token)
      else {
        const body:AfterSaleBody=action==='ship-back'?{carrier:this.carrier.trim(),trackingNo:this.trackingNo.trim(),shippingAmountCents:amountInputCents(this.shippingAmount)}:{}
        await afterSaleActions.start(this.sale.orderId,'/member/after-sales/'+encodeURIComponent(this.sale.id)+'/'+action,body,action==='ship-back'?this.shippingPhotos:[],token)
      }
      if(this.current(generation,token)){this.pending=false;this.onComplete()}
    }catch(error){if(this.current(generation,token)){this.pending=afterSaleActions.pending(this.user.id||'',this.sale.orderId)!==null;this.message=this.pending?'操作结果待确认，请重试确认':orderWriteFailure(error as Error).message||'操作未完成，请刷新后重试'}}
    finally{if(this.current(generation,token))this.busy=false}
  }
  build() {
    Column({space:10}) {
      Text(afterSaleStatus(this.sale)).id('after-sale-state-'+this.sale.id).fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('[ui_components].color.text')).width('100%')
      Text(afterSaleKind(this.sale.kind)+' · '+(this.sale.amountCents===0?(this.sale.amountMessage||'货款 0 元，无需退款'):'¥'+(this.sale.amountCents/100).toFixed(2)+'，退回 '+this.sale.payerAccount)).fontColor($r('[ui_components].color.text')).width('100%')
      if(shippingCompensationText(this.sale)){Text(shippingCompensationText(this.sale)).id('after-sale-shipping-result').fontColor($r('[ui_components].color.text')).width('100%')}
      if(this.sale.state==='pending') {
        Text(this.deadlineText()).fontColor($r('[ui_components].color.gray')).fontSize(13)
        if(this.owner){Button('撤回申请').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).id('after-sale-withdraw').enabled(this.ready&&!this.busy&&!this.pending).onClick(()=>this.requestWithdraw())}
      }
      if(this.sale.state==='awaiting-return'&&this.owner&&this.sale.returnAddress) {
        Column({space:6}) {
          Text('收件人：'+this.sale.returnAddress.receiver).fontColor($r('[ui_components].color.text'))
          Text('电话：'+this.sale.returnAddress.contact).fontColor($r('[ui_components].color.text'))
          Text('地址：'+this.sale.returnAddress.address).fontColor($r('[ui_components].color.text'))
          Row(){Blank();Button('复制退货地址').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).onClick(()=>this.copyAddress())}.width('100%')
        }.id('after-sale-return-address').width('100%').alignItems(HorizontalAlign.Start)
        Button('不退了，撤回申请').id('after-sale-withdraw').enabled(this.ready&&!this.busy&&!this.pending).backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).onClick(()=>this.requestWithdraw())
        Text('请在 '+formatBeijingTime(this.sale.returnDeadline||0)+' 前填写寄回单号，逾期关闭').fontColor($r('[ui_components].color.gray')).fontSize(13)
        Text('快递公司').fontColor($r('[ui_components].color.text')).width('100%')
        TextInput({text:this.carrier,placeholder:'填写快递公司'}).id('after-sale-carrier').fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.under')).enabled(!this.pending&&!this.busy).onChange((value:string)=>this.carrier=value)
        Text('寄回单号').fontColor($r('[ui_components].color.text')).width('100%')
        TextInput({text:this.trackingNo,placeholder:'填写寄回单号'}).id('after-sale-tracking').fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.under')).enabled(!this.pending&&!this.busy).onChange((value:string)=>this.trackingNo=value)
        Text('实付运费（元）').fontColor($r('[ui_components].color.text')).width('100%')
        TextInput({text:this.shippingAmount,placeholder:'0.01–100元，最多两位小数'}).id('after-sale-shipping-amount').type(InputType.NUMBER_DECIMAL).fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.under')).enabled(!this.pending&&!this.busy).onChange((value:string)=>this.shippingAmount=value)
        Text('运单截图必填，1张JPEG，不超过512KB').fontColor($r('[ui_components].color.gray')).fontSize(13)
        if(this.shippingPhotos.length){Image('data:image/jpeg;base64,'+this.shippingPhotos[0].bytes).width(120).height(100).objectFit(ImageFit.Contain)}
        Button(this.shippingPhotos.length?'更换运单截图':'选择运单截图').id('after-sale-shipping-photo').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red')).border({width:1,color:$r('[ui_components].color.red')}).enabled(this.ready&&!this.pending&&!this.busy).onClick(()=>this.chooseShippingPhoto())
        Button('提交寄回信息').backgroundColor($r('[ui_components].color.red')).fontColor(Color.White).id('after-sale-ship-back').enabled(this.ready&&!this.pending&&!this.busy).onClick(()=>this.act('ship-back'))
      }
      if(this.sale.state==='returned') {
        if(this.owner){Text((this.sale.carrier||'')+' '+(this.sale.trackingNo||'')).fontColor($r('[ui_components].color.text'))}
        Text(this.deadlineText()).fontColor($r('[ui_components].color.gray')).fontSize(13)
      }
      if(this.sale.rejectReason){Text(this.sale.rejectReason).fontColor($r('[ui_components].color.red')).width('100%')}
      if(this.owner&&this.sale.shippingAmountCents){Text('已填写运费 ¥'+(this.sale.shippingAmountCents/100).toFixed(2)).fontColor($r('[ui_components].color.text'))}
      if(this.owner&&this.sale.shippingImage){AfterSalePhotos({images:[this.sale.shippingImage],loadImage:(path:string):Promise<string>=>this.photo(path)})}
      if(this.owner&&(this.sale.images||[]).length>0){AfterSalePhotos({images:this.sale.images||[],loadImage:(path:string):Promise<string>=>this.photo(path)})}
      if(this.message){Text(this.message).fontColor($r('[ui_components].color.text'))}
      if(this.pending&&this.owner){Button('重试确认结果').backgroundColor($r('[ui_components].color.red')).fontColor(Color.White).id('after-sale-retry').enabled(!this.busy&&this.ready).onClick(()=>this.act('withdraw'))}
    }.alignItems(HorizontalAlign.Start).width('100%').padding(14).backgroundColor($r('[ui_components].color.white')).borderRadius(12)
  }
}
