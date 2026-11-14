import {test} from 'node:test'
import assert from 'node:assert/strict'
import {pageMethods,sourceOf,deferred} from './native-harness.mjs'
const mine='mixed-development-h5/features/mine/src/main/ets/presentation/views/'

test('D18 商家发货先填写运单，校验通过才提交承运商和运单号',async()=>{
 const calls=[]
 const Page=pageMethods(mine+'FamilyView.ets','FamilyView',{}, {OrderState:{AWAITING_SHIPMENT:2},shipOrderAPI:async(...args)=>calls.push(args)})
 const page=new Page(),order={id:'order',canShip:true,orderState:2}
 page.user={role:'merchant',token:'session'};page.ordersToShip=[order];page.canManageFamily=()=>true
 page.submitThenRefresh=async fn=>fn('session');page.safeToast=()=>{}
 page.shipOrder(order)
 assert.equal(calls.length,0,'打开填写发货信息后才能提交')
 await page.submitShipment();assert.equal(calls.length,0)
 page.shippingCarrier='顺丰';page.shippingTrackingNo='SF12345678'
 await page.submitShipment()
 assert.equal(calls.length,1)
 assert.equal(calls[0][2].carrier,'顺丰')
 assert.equal(calls[0][2].trackingNo,'SF12345678')
})

test('D18 商家对账入口可达，处理原因校验且异步结果不会串账号',async()=>{
 assert.match(sourceOf(mine+'MineView.ets'),/merchant-reconciliation-entry/)
 const calls=[],pending=deferred()
 const Page=pageMethods(mine+'ReconciliationView.ets','ReconciliationView',{}, {
  reconciliationDay:()=> '2026-11-11',validReconciliationDate:()=>true,
  RequestAxios:{postWithSession:(...args)=>{calls.push(args);return pending.promise}}
 })
 const page=new Page();page.active=true;page.user={id:'seller',role:'merchant',token:'session'}
 page.report={differences:[{id:'diff',state:'pending'}]};page.selectedId='diff';page.reason='短'
 await page.resolve();assert.equal(calls.length,0)
 page.reason='已经核实差异原因';const task=page.resolve();await page.resolve();assert.equal(calls.length,1)
 page.user={id:'other',role:'merchant',token:'other-session'};page.accountChanged()
 pending.resolve({id:'diff',state:'resolved'});await task
 assert.equal(page.report,null)
})

test('D18 物流刷新离页或换账号释放旧锁，迟到结果不干扰新请求',async()=>{
 const pending=deferred()
 const Page=pageMethods('mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderDetailView.ets','OrderDetailView',{}, {
  GlobalVariable:{}, RequestAxios:{getForSession:()=>pending.promise}
 })
 const page=new Page();page.user={token:'old'};page.orderId='order';page.detailOrderId='order';page.detailToken='old';page.pageActive=true
 page.canOperateOrder=()=>true;page.stopPendingChecks=()=>{}
 const task=page.refreshLogistics();assert.equal(page.logisticsLoading,true)
 page.hideOrderDetail();assert.equal(page.logisticsLoading,false)
 page.pageActive=true;page.user={token:'new'};page.synchronizeDetailContext();assert.equal(page.logisticsLoading,false)
 page.logisticsLoading=true;pending.resolve({events:[]});await task
 assert.equal(page.logisticsLoading,true)
})

test('D18 对账初次加载期间的日期回调不使查询失效或永久锁住输入',async()=>{
 const pending=deferred()
 const Page=pageMethods(mine+'ReconciliationView.ets','ReconciliationView',{}, {
  reconciliationDay:()=> '2026-11-13',validReconciliationDate:()=>true,
  RequestAxios:{getForSession:()=>pending.promise}
 })
 const page=new Page();page.active=true;page.user={id:'seller',role:'merchant',token:'session'}
 const task=page.load();assert.equal(page.working,true)
 page.changeDate('2026-11-13')
 pending.resolve({date:'2026-11-13',differences:[]});await task
 assert.equal(page.working,false);assert.equal(page.report.date,'2026-11-13')
})
