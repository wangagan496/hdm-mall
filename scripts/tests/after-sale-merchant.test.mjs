import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageMethods, deferred, tick } from './native-harness.mjs'
const path='mixed-development-h5/features/mine/src/main/ets/presentation/views/AfterSaleManageView.ets'
function fixture(api={getForSession:async()=>({items:[],page:1,pages:0})}) {
 const calls=[]
 const Page=pageMethods(path,'AfterSaleManageView',{}, {GlobalVariable:{},RequestAxios:api,afterSaleActions:{pending:()=>null,start:async(...args)=>calls.push(args),resume:async(...args)=>calls.push(['resume',...args])},Date,Math,$r:value=>value})
 const page=new Page();page.user={id:'merchant',token:'old',role:'merchant'};page.active=true;page.synchronize()
 return {page,calls,api}
}
test('商家验收默认全量，可部分或零入库，越界时不发送请求',async()=>{
 const {page,calls}=fixture();const sale={id:'sale',orderId:'order',state:'returned',items:[{skuId:'sku',count:3}]}
 page.open(sale,'inspect');assert.equal(page.lines[0].restockCount,3)
 page.lines[0].restockCount=4;await page.submit();assert.equal(calls.length,0);assert.match(page.message,/数量/)
 page.lines[0].restockCount=0;await page.submit();assert.equal(calls.length,1);assert.equal(calls[0][2].items[0].restockCount,0)
})
test('商家首次同意校验地址，拒绝校验原因，未知结果重试沿用旧操作',async()=>{
 const f=fixture();const {page,calls}=f;const sale={id:'sale',orderId:'order',state:'pending',kind:'return-quality',items:[]}
 page.open(sale,'approve');await page.submit();assert.equal(calls.length,0);assert.match(page.message,/地址|电话|收件/)
 page.receiver='收件人';page.contact='13800138000';page.address='北京市测试街道1号';await page.submit();assert.equal(calls.length,1);assert.equal(calls[0][2].returnAddress.receiver,'收件人')
 page.open(sale,'reject');page.reason='不行';await page.submit();assert.equal(calls.length,1)
 page.pending=true;await page.submit();assert.equal(calls[1][0],'resume')
})
test('商家筛选乱序和退出账号后的迟到响应不覆盖当前数据',async()=>{
 const first=deferred(),second=deferred();let n=0
 const {page}=fixture({getForSession:(url)=>url.includes('/settings/')?Promise.resolve(null):++n===1?first.promise:second.promise})
 const a=page.load(1);page.filter='returned';const b=page.load(1)
 second.resolve({items:[{id:'new'}],page:1,pages:1});await b
 first.resolve({items:[{id:'old'}],page:1,pages:1});await a;assert.equal(page.items[0].id,'new')
 page.user={id:'buyer',token:'new',role:'buyer'};page.accountChanged();await tick();assert.equal(page.items.length,0);assert.equal(page.editorOpen,false)
})
test('商家成功提示使用正文色，错误提示保留红色',()=>{
 const {page}=fixture();page.message='处理已完成';page.messageType='success';assert.equal(page.messageColor(),'[ui_components].color.text')
 page.message='处理未完成，请重试';page.messageType='error';assert.equal(page.messageColor(),'[ui_components].color.red')
})
