import {test} from 'node:test'
import assert from 'node:assert/strict'
import {sourceOf,execute,deferred,tick} from './native-harness.mjs'
const source=sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/views/PayView.ets')
const body=source.slice(source.indexOf('struct PayView {'),source.indexOf('  build()')).replace('struct PayView','export class PayView').replace(/@\w+(?:\([^)]*\))?\s*/g,'')+'\n}'
test('UX16 收银台确认中只查当前订单，邀请未知核对付款人，不自动付款且离页取消',async()=>{
 const timers=new Map(),queries=[],writes=[];let timer=0
 const timerAPI={setTimeout:(fn,d)=>{timers.set(++timer,{fn,d});return timer},clearTimeout:id=>timers.delete(id)}
 const recovery=execute(sourceOf('mixed-development-h5/commons/storage/src/main/ets/RecoveryQuery.ets'),{},timerAPI)
 const {PayView}=execute(body,{}, {...recovery,...timerAPI, auth:{getUserInfo:()=>({token:'a'})},getOrderDetailAPI:(id,token)=>{const d=deferred();queries.push({id,token,...d});return d.promise},startPaymentAPI:()=>writes.push('pay'),getPayerRelationsPageAPI:()=>writes.push('relations'),readPhoneClockMillis:()=>0})
 const p=new PayView();p.sessionToken='a';p.sessionOrderId='o';p.orderId='o';p.order={id:'o',orderState:1,paymentState:'confirming'};p.loading=false;p.loadedToken='a';p.safeToast=()=>{}
 p.scheduleCashierCheck();p.scheduleCashierCheck();assert.equal(timers.size,1)
 const job=timers.entries().next().value;timers.delete(job[0]);job[1].fn();await tick();assert.equal(queries.length,1)
 const same=p.checkCashierStatus();assert.equal(queries.length,1)
 queries[0].resolve({id:'o',orderState:1,paymentState:'review',invitedPayerAccount:'亲友甲'});await same;await tick()
 assert.equal(p.order.invitedPayerAccount,'亲友甲');assert.equal(timers.size,1);assert.equal(writes.length,0)
 p.aboutToDisappear();assert.equal(timers.size,0)
})
test('UX20 待确认支付显示中性等待状态，查看本单为主按钮且取消降级',()=>{
 const result=sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/views/PayResultView.ets')
 assert.match(result,/if \(this\.isCheckingPayment \|\| this\.paymentResultUnconfirmed\)[\s\S]*?LoadingProgress\(\)/)
 assert.match(result,/Button\(this\.shouldOpenCashier\(\) \? '去支付' : '查看本单'\)[\s\S]*?Button\('全部订单'\)/)
 assert.match(result,/Button\('取消订单'\)[\s\S]*?\.backgroundColor\(Color\.Transparent\)/)
 assert.doesNotMatch(result,/Button\('查看本单'\)[\s\S]{0,500}ic_public_close_filled/)
})
