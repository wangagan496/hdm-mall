import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf, pageMethods, deferred } from './native-harness.mjs'

const modelPath='mixed-development-h5/commons/models/src/main/ets/AfterSaleModels.ets'
const flowPath='mixed-development-h5/commons/storage/src/main/ets/AfterSaleActions.ets'
test('售后申请按下单整数分计算部分数量，非法数量不能提交',()=>{
 const {afterSaleAmount,afterSaleInputError}=execute(sourceOf(modelPath))
 const items=[{skuId:'s',name:'商品',spec:'标准',priceCents:10,count:3,remaining:3}]
 assert.equal(afterSaleAmount(items),30)
 items[0].count=2;assert.equal(afterSaleAmount(items),20)
 assert.equal(afterSaleInputError(items,'return-no-reason',''),'')
 items[0].count=4;assert.match(afterSaleInputError(items,'return-no-reason',''),/数量/)
 items[0].count=1;assert.match(afterSaleInputError(items,'return-quality',''),/说明/)
 assert.equal(afterSaleInputError(items,'refund-missing','少了一个商品'),'')
})
test('售后卡片每种状态显示白话，不暴露内部状态码',()=>{
 const {afterSaleStatus}=execute(sourceOf(modelPath))
 for(const [state,label] of Object.entries({pending:'待商家处理','awaiting-return':'请寄回',returned:'等待商家验收',refunding:'退款中',refunded:'已退款',rejected:'已拒绝',withdrawn:'已撤回',closed:'已关闭','refund-rejected':'商家拒绝退款'})) assert.equal(afterSaleStatus({state,refundState:''}),label)
 assert.equal(afterSaleStatus({state:'refunding',refundState:'failed'}),'退款失败，正在重试')
})
function fixture() {
 const disk=new Map(),calls=[];let user={id:'buyer',token:'token'}
 const store={getSync:(k,d)=>disk.get(k)??d,putSync:(k,v)=>disk.set(k,v),flush:async()=>{}}
 const api={postWithSession:async(url,body,token)=>{calls.push({url,body:structuredClone(body),token});return {afterSaleId:'sale',orderId:'order',appliedState:'pending'}},postMultipartForSession:async()=>({imageId:'img'})}
 const {AfterSaleActions}=execute(sourceOf(flowPath),{'@kit.ArkTS':{util:{generateRandomUUID:()=> 'fixed-key',Base64Helper:class{decodeSync(){return new Uint8Array([255,216,255])}}}},network:{RequestAxios:api},'./Auth':{auth:{getUserInfo:()=>user}},'./StoreManager':{storeManager:{getStore:()=>store,getUserInfo:()=>user}}})
 return {flow:new AfterSaleActions(),disk,calls,api,store,setUser:value=>{user=value}}
}
test('售后未知结果持久保留同号同参，重放成功后清理',async()=>{
 const f=fixture();let fail=true
 f.api.postWithSession=async(url,body,token)=>{f.calls.push({url,body:structuredClone(body),token});if(fail)throw Error('connection lost');return {afterSaleId:'sale',orderId:'order',appliedState:'pending'}}
 await assert.rejects(f.flow.start('order','/member/order/order/after-sales',{kind:'refund-missing',items:[{skuId:'s',count:1}],description:'少了一个商品',imageIds:[]},[],'token'))
 assert.ok(f.flow.pending('buyer','order'));fail=false
 await f.flow.resume('order','token')
 assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.flow.pending('buyer','order'),null)
 assert.ok([...f.disk.values()].every(v=>!v.includes('token')))
})
test('售后持久化失败不发请求，会话切换不借用新凭证',async()=>{
 const f=fixture();f.store.flush=async()=>{throw Error('disk')}
 await assert.rejects(f.flow.start('order','/member/order/order/after-sales',{kind:'refund-missing'},[],'token'));assert.equal(f.calls.length,0)
 f.store.flush=async()=>{};f.setUser({id:'other',token:'other-token'})
 await assert.rejects(f.flow.resume('order','token'));assert.equal(f.calls.length,0)
})
test('售后明确业务拒绝清理操作意图，网络错误保留',async()=>{
 const f=fixture();f.api.postWithSession=async()=>{throw {response:{status:409}}}
 await assert.rejects(f.flow.start('order','/member/order/order/after-sales',{kind:'refund-missing'},[],'token'))
 assert.equal(f.flow.pending('buyer','order'),null)
})
test('买家页面包含收货确认和退款对象，订单详情及列表都有售后入口',()=>{
 const apply=sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/views/AfterSaleApplyView.ets')
 for(const text of ['提交后视为已收到货','预计退款','退回','七日无理由退货','质量问题退货','少件漏发仅退款'])assert.ok(apply.includes(text),text)
 assert.match(apply,/afterSaleActions\.resume/)
 for(const page of ['OrderDetailView','OrderView'])assert.match(sourceOf(`mixed-development-h5/features/cart/src/main/ets/presentation/views/${page}.ets`),/AFTER_SALE_APPLY_PAGE/)
 assert.match(sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderView.ets'),/售后中/)
})

test('买家申请迟到响应不覆盖新账号，收货确认弹窗失效后不能提交',async()=>{
 const old=deferred();let response=old.promise;const calls=[]
 const Page=pageMethods('mixed-development-h5/features/cart/src/main/ets/presentation/views/AfterSaleApplyView.ets','AfterSaleApplyView',{}, {
  GlobalVariable:{},getAfterSaleOrderAPI:()=>response,afterSaleActions:{pending:()=>null,start:async(...args)=>{calls.push(args)}},afterSaleInputError:()=>'',afterSaleAmount:()=>100,orderWriteFailure:()=>({}),
 })
 const page=new Page();page.orderId='order';page.user={id:'buyer',token:'token'}
 const task=page.load();response=Promise.resolve({id:'order',skus:[],afterSaleKinds:['return-no-reason'],orderState:3,canApplyAfterSale:true,payerAccount:'new'})
 page.user={id:'new',token:'new-token'};page.accountChanged()
 await new Promise(resolve=>setTimeout(resolve,0));old.resolve({id:'old',skus:[],payerAccount:'old'});await task
 assert.equal(page.order.payerAccount,'new')
 let dialog;page.getUIContext=()=>({showAlertDialog:value=>{dialog=value}})
 page.requestSubmit();assert.match(dialog.message,/提交后视为已收到货/)
 page.aboutToDisappear();dialog.secondaryButton.action();assert.equal(calls.length,0)
})

test('照片上传响应丢失继续用原上传号，申请成功前不会换申请号',async()=>{
 const f=fixture(),uploads=[];let first=true
 f.api.postMultipartForSession=async(...args)=>{uploads.push(args);if(first){first=false;throw Error('network')}return {imageId:'img'}}
 await assert.rejects(f.flow.start('order','/member/order/order/after-sales',{kind:'return-quality',imageIds:[]},[{bytes:'jpeg',requestKey:'image-key'}],'token'))
 await f.flow.resume('order','token')
 assert.equal(uploads[0][2],uploads[1][2]);assert.equal(uploads[0][5],uploads[1][5]);assert.deepEqual(f.calls[0].body.imageIds,['img'])
})
