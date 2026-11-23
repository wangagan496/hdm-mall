import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync} from 'node:fs'
import {pageMethods} from './native-harness.mjs'
const src=(feature,view)=>readFileSync(new URL('../../mixed-development-h5/features/'+feature+'/src/main/ets/presentation/views/'+view+'.ets',import.meta.url),'utf8')
test('买家复核结论使用项目的北京时间分钟格式',()=>{
 const page=src('cart','EvaluationView')
 assert.ok(page.includes('formatBeijingTime(this.order.evaluation.dispute.conclusion.time)'))
})
test('评价管理支持登记、进度与证据选择',()=>{
 const page=src('mine','ReviewManageView')
 for(const label of ['登记疑似恶意差评','已登记，等待独立复核','请求更正','平台复核']) assert.ok(page.includes(label),label)
 assert.match(page,/images:.*[Ii]mages/)
})
test('普通登录之后按服务端能力显示复核入口',()=>{
 const page=src('mine','MineView')
 assert.match(page,/\/reviews\/capability/)
 assert.match(page,/if\s*\(this\.reviewer\)/)
})
test('买家评价详情保留结论且更正只提交理由',()=>{
 const page=src('cart','EvaluationView')
 assert.match(page,/平台复核/)
 assert.match(page,/请求更正/)
 assert.match(page,/\{\s*reason:\s*this\.correctionReason\.trim\(\)\s*\}/)
 assert.doesNotMatch(page,/恶意|登记商家|复核员账号/)
})

test('登记、给结论与两方更正使用公开编号，提交体只含该动作的字段',async()=>{
 const calls=[]
 const RequestAxios={postWithSession:async(path,body)=>{calls.push([path,JSON.parse(JSON.stringify(body))])}}
 const view=(name)=>pageMethods('mixed-development-h5/features/mine/src/main/ets/presentation/views/'+name+'.ets',name,{}, {RequestAxios,AcceptReview:class {}})
 const merchant=new (view('ReviewManageView'))()
 merchant.user={token:'merchant',identity:'merchant'};merchant.active=true;merchant.load=async()=>{}
 for(const mode of ['register','correct']){
   merchant.selected={id:'public',orderId:'private-order',buyerId:'private-buyer'}
   merchant.mode=mode;merchant.reason=' 核对色差记录 ';merchant.selectedImages=['/uploads/example.jpg']
   await merchant.fileDispute()
 }
 const reviewer=new (view('ReviewQueueView'))()
 reviewer.user={token:'reviewer'};reviewer.active=true;reviewer.refresh=async()=>{}
 reviewer.kind='correct';reviewer.reason=' 已核对拍摄光线 '
 await reviewer.submit('public',true);await reviewer.submit('public',false)
 assert.deepEqual(calls,[
   ['/merchant/reviews/public/dispute',{reason:'核对色差记录',images:['/uploads/example.jpg']}],
   ['/reviews/public/correction',{reason:'核对色差记录'}],
   ['/platform/reviews/public/accept',{}],
   ['/platform/reviews/public/conclude',{kind:'correct',reason:'已核对拍摄光线'}],
 ])
})
