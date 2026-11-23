import { GlobalVariable } from 'constants'
import { HDMUser, reviewLabel } from 'models'
import { RequestAxios } from 'network'
import { HDMNavBar } from 'ui_components'

interface Field {label:string;quote:string;result:string;note:string}
interface Original {score:number;content:string;items:Field[]}
interface CaseItem {id:string;status:string;reason:string;images:string[];original:Original;corrections:string[]}
interface Queue {items:CaseItem[]}
interface Decision {kind:string;reason:string}
class AcceptReview {}

@Component
export struct ReviewQueueView {
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('refresh') user:HDMUser={} as HDMUser
  @StorageProp(GlobalVariable.SAFE_AREA_TOP) top:number=0
  @StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) bottom:number=0
  @State items:CaseItem[]=[]
  @State selected:string=''
  @State kind:string='maintain'
  @State reason:string=''
  @State message:string=''
  @State busy:boolean=false
  private sequence:number=0
  private active:boolean=false
  private async refresh():Promise<void>{
    const token=this.user.token,seq=++this.sequence
    this.items=[];this.selected='';this.reason='';this.kind='maintain';this.message='';this.busy=false
    if(!token||!this.active)return
    this.busy=true
    try{
      const page=await RequestAxios.getForSession<Queue>('/platform/reviews',token)
      if(seq===this.sequence)this.items=page.items
    }catch(error){if(seq===this.sequence)this.message=(error as Error).message}
    finally{if(seq===this.sequence)this.busy=false}
  }
  private async submit(id:string,accept:boolean):Promise<void>{
    if(this.busy || !this.active)return
    const token=this.user.token,seq=this.sequence
    this.busy=true
    const url='/platform/reviews/'+encodeURIComponent(id)
    try{
      if(accept)await RequestAxios.postWithSession<object>(url+'/accept',new AcceptReview(),token)
      else await RequestAxios.postWithSession<object>(url+'/conclude',{kind:this.kind,reason:this.reason.trim()} as Decision,token)
      if(seq===this.sequence)await this.refresh()
    }catch(error){if(seq===this.sequence)this.message=(error as Error).message}
    finally{if(seq===this.sequence)this.busy=false}
  }
  build(){
    NavDestination(){
      Column(){
        HDMNavBar({title:'平台复核'})
        Scroll(){
          Column({space:12}){
            Button('刷新待复核评价').enabled(!this.busy).onClick(()=>this.refresh())
            if(this.message){Text(this.message)}
            if(!this.message && !this.busy && !this.items.length){Text('暂无待复核评价')}
            ForEach(this.items,(item:CaseItem)=>{
              Column({space:8}){
                Text(reviewLabel(item.status)+' · 商品 '+item.original.score+' 分')
                Text(item.original.content)
                ForEach(item.original.items,(f:Field)=>{
                  Text(f.label+' · '+f.quote+' · '+(f.result==='matches'?'符合':f.result==='mismatch'?'不符':'没注意')+' '+f.note)
                })
                Text('登记理由：'+item.reason)
                ForEach(item.images,(path:string)=>{Image(GlobalVariable.BASE_URL+path).width('100%').height(160).objectFit(ImageFit.Contain)})
                ForEach(item.corrections,(s:string)=>{Text('更正理由：'+s)})
                if(item.status!=='under-review'){Button('受理').enabled(!this.busy).onClick(()=>this.submit(item.id,true))}
                else if(this.selected!==item.id){
                  Button('填写结论').onClick(()=>{this.selected=item.id;this.reason='';this.kind='maintain'})
                }else{
                  ForEach(['maintain','hide','correct'],(k:string)=>{
                    Button((this.kind===k?'✓ ':'')+reviewLabel(k)).onClick(()=>{this.kind=k})
                  })
                  TextArea({placeholder:'请写明结论理由（5至200字）',text:this.reason}).maxLength(200).onChange((s:string)=>{this.reason=s})
                  Button('提交结论').enabled(!this.busy && this.reason.trim().length>=5).onClick(()=>this.submit(item.id,false))
                }
              }.width('100%').alignItems(HorizontalAlign.Start).padding(12).backgroundColor($r('[ui_components].color.white'))
            },(item:CaseItem)=>item.id+item.status)
          }.padding(12).width('100%')
        }.layoutWeight(1).width('100%')
      }.width('100%').height('100%').padding({top:this.top,bottom:this.bottom}).backgroundColor($r('[ui_components].color.under'))
    }.hideTitleBar(true).onShown(()=>{this.active=true;void this.refresh()}).onHidden(()=>{this.active=false;void this.refresh()})
  }
}
