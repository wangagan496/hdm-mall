import {test} from 'node:test'
import assert from 'node:assert/strict'
import {pageMethods,sourceOf,execute} from './native-harness.mjs'
import {createRequire} from 'node:module'
const path='mixed-development-h5/features/mine/src/main/ets/presentation/views/AccountDeletionView.ets'
function fixture({clearFails=false}={}){
 const calls=[],data=new Map();const user={id:'buyer',token:'session',role:'buyer'}
 const Page=pageMethods(path,'AccountDeletionView',{}, {
  GlobalVariable:{},auth:{getUserInfo:()=>user,updateCurrentUser:u=>Object.assign(user,u)},
  deviceFixturePassword:async()=>'',
  util:{generateRandomUUID:()=>crypto.randomUUID()},localGoodsStore:{clearPersonalData:async()=>{calls.push('clear');if(clearFails)throw new Error('disk failure')}},
  storeManager:{getStore:()=>({getSync:(k,d)=>data.get(k)??d,putSync:(k,v)=>data.set(k,v),deleteSync:k=>data.delete(k),flush:async()=>{}}),saveUserInfo:async()=>{}},
  userSession:{logout:async()=>calls.push('logout')},AppStorage:{setOrCreate(){}},
  RequestAxios:{postWithSession:async(...args)=>{calls.push(args);return {status:'deleting'}},getForSession:async()=>({status:'active',matters:[],message:'提交后有15天冷静期'})}
 })
 const page=new Page();page.user=user;page.stackPath={clear:()=>calls.push('home')};page.getUIContext=()=>({getPromptAction:()=>({showToast:()=>{}})})
 return {page,calls,data}
}
test('CD-L04 注销须密码和勾选，提交后清理本地、退出并回首页',async()=>{
 const f=fixture();await f.page.submitDeletion();assert.equal(f.calls.length,0)
 f.page.password='test-only-secret';f.page.acknowledged=true;await f.page.submitDeletion()
 assert.equal(f.calls[0][0],'/member/account-deletion');assert.equal(f.calls[0][1].acknowledged,true)
 assert.deepEqual(f.calls.slice(1),['clear','logout','home']);assert.equal(f.page.password,'')
 assert.equal([...f.data.values()].some(v=>String(v).includes('test-only-secret')),false)
})

test('CD-L09 注销中原生拦截器允许消费者售后操作，其他写仍拒绝',async()=>{
 const axios=createRequire(new URL('../../shoph5-vue3/package.json',import.meta.url))('axios'),sent=[]
 const {RequestAxios}=execute(sourceOf('mixed-development-h5/commons/network/src/main/ets/RequestAxios.ets'),{
  '@ohos/axios':{__esModule:true,default:{create:options=>axios.create({...options,adapter:async config=>{
   sent.push(config.url);return {status:200,config,data:{code:'1',result:'ok'},headers:{}}
  }})}},constants:{GlobalVariable:{USER_INFO_KEY:'user',SUCCESS_CODE:'1'}}
 },{AppStorage:{get:key=>key==='user'?{status:'deleting',token:'session'}:undefined}})
 for(const url of ['/member/order/test/after-sales','/member/after-sales/images','/member/order/test/cancel-requests'])assert.equal(await RequestAxios.postWithSession(url,{},'session'),'ok')
 for(const url of ['/member/order','/member/cart','/member/relations','/member/profile'])await assert.rejects(RequestAxios.postWithSession(url,{},'session'),{httpStatus:403})
 assert.equal(sent.length,3)
})
test('CD-L05 注销页列明冷静期、自动收货、保留范围及未完成事项',()=>{
 const s=sourceOf(path)
 for(const text of ['15天','三年','退款退回原付款人','已注销用户','我已了解上述影响','撤销注销','matters'])assert.ok(s.includes(text),text)
 for(const name of ['privacy-policy.txt','user-agreement.txt']){
  const text=sourceOf('mixed-development-h5/features/mine/src/main/resources/rawfile/'+name)
  assert.ok(text.includes('仍可申请售后和取消已付款订单'),name)
  assert.ok(!text.includes('只能查询和跟进已有事项'),name)
 }
})
test('CD-L06 注销已受理后本机收藏清理失败仍退出当前会话',async()=>{
 const f=fixture({clearFails:true});f.page.password='test-only-secret';f.page.acknowledged=true
 await f.page.submitDeletion()
 assert.deepEqual(f.calls.slice(1),['clear','logout']);assert.equal(f.page.password,'');assert.equal(f.page.busy,false)
})

test('CD-L07 已提交默认折叠说明，进入与回前台刷新，隐藏后不请求',async()=>{
 const f=fixture();assert.equal(f.page.explanationExpanded,false)
 let requests=0;f.page.refresh=async()=>{requests++}
 f.page.shown();assert.equal(requests,1)
 f.page.refreshAfterForeground();assert.equal(requests,2)
 f.page.hidden();f.page.refreshAfterForeground();assert.equal(requests,2)
 const s=sourceOf(path)
 for(const text of ['注销申请已提交','查看注销说明','当前密码','冷静期内仍可申请售后和取消已付款订单','matter.productName','matter.createdAt'])assert.ok(s.includes(text),text)
 for(const text of ['刷新状态','真正未付款','归库'])assert.ok(!s.includes(text),text)
 assert.ok(s.includes('Text(matter.productName)'))
 assert.ok(s.includes('Text(this.orderDate(matter.createdAt))'))
 assert.ok(s.includes('Text(matter.message)'))
})
