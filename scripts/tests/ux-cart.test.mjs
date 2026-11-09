import {test} from 'node:test'
import assert from 'node:assert/strict'
import {pageMethods,execute,sourceOf,deferred,tick} from './native-harness.mjs'
const path='mixed-development-h5/features/cart/src/main/ets/presentation/views/CartView.ets'
function fixture(onBadge=async()=>{}){const calls=[],paths=[],messages=[],timers=[];const {CartOperationHelper}=execute(sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/utils/CartOperations.ets'))
 const P=pageMethods(path,'CartView',{}, {CartOperations:CartOperationHelper,RequestAxios:{putForSession:(url,body,token)=>{const d=deferred();calls.push({url,body,token,...d});return d.promise}},authCart:{updateCartCount:onBadge},PAGE_PATH:{CHECK_ORDER_PAGE:'checkout'},setTimeout:fn=>{timers.push(fn);return timers.length},clearTimeout:()=>{}})
 const p=new P();p.user={token:'a'};p.cartToken='a';p.cartList=[{skuId:'a',count:1,selected:true,price:10},{skuId:'b',count:1,selected:true,price:20}];p.stackPath={pushPath:x=>paths.push(x)};p.getUIContext=()=>({getPromptAction:()=>({showToast:x=>messages.push(x.message)}),getHostContext:()=>({eventHub:{off(){}}})});p.recalculateCartSummary()
 return {p,calls,paths,messages,flush:async()=>{for(const fn of timers.splice(0))fn();await tick()}}
}
test('UX13 连点合并绝对值，不锁其他行，结算等待后只进入一次',async()=>{
 const f=fixture(),a=f.p.cartList[0],b=f.p.cartList[1];const jobs=[]
 for(let n=2;n<=6;n++)jobs.push(f.p.changeGoodsQuantity(a,n))
 jobs.push(f.p.changeGoodsSelection(a,false));jobs.push(f.p.changeGoodsQuantity(b,3));assert.equal(a.count,6);assert.equal(a.selected,false);assert.equal(b.count,3)
 const checkout=f.p.openCheckoutPage();f.p.openCheckoutPage();await f.flush();assert.equal(f.calls.length,2);assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].body)),{count:6,selected:false});assert.equal(f.calls[0].token,'a');assert.equal(f.paths.length,0)
 f.calls.forEach(x=>x.resolve());await Promise.all(jobs);await checkout;assert.equal(f.paths.length,1)
})
test('UX13 保存中再次输入串行发送最新值，失败只回滚该行并停止自动结算',async()=>{
 const f=fixture(),a=f.p.cartList[0];const first=f.p.changeGoodsQuantity(a,2);await f.flush();f.p.changeGoodsQuantity(a,5);assert.equal(f.calls.length,1)
 f.calls[0].resolve();await tick();await f.flush();assert.equal(f.calls.length,2);assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1].body)),{count:5})
 const checkout=f.p.openCheckoutPage();f.calls[1].reject(new Error('offline'));await first;await checkout;assert.equal(a.count,2);assert.equal(f.p.cartList[1].count,1);assert.equal(f.paths.length,0);assert.equal(f.messages.length,1)
})
test('UX13 角标刷新不覆盖在途目标，换账号后旧回包和结算失效',async()=>{
 const f=fixture(),a=f.p.cartList[0];const task=f.p.changeGoodsQuantity(a,4);await f.flush();let loads=0;f.p.loadCartList=async()=>loads++
 f.p.reloadCartAfterChange();assert.equal(loads,0);const checkout=f.p.openCheckoutPage();f.p.user={token:'b'};f.calls[0].resolve();await task;await checkout;assert.equal(f.paths.length,0);assert.equal(f.messages.length,0)
})
test('UX13 账号监听前的旧行回调和已替换行不得提交',async()=>{
 const f=fixture(),old=f.p.cartList[0];f.p.user={token:'b'}
 f.p.changeGoodsQuantity(old,8);f.p.changeGoodsSelection(old,false);await f.flush()
 assert.equal(f.calls.length,0);assert.equal(old.count,1);assert.equal(old.selected,true)
 f.p.user={token:'a'};f.p.cartList=[{...old}]
 f.p.changeGoodsQuantity(old,9);await f.flush();assert.equal(f.calls.length,0)
})
test('UX13 行保存的角标广播不重载自身或打断后续点击，仍刷新其他购物袋',async()=>{
 let ownLoads=0,otherLoads=0
 const other=fixture();other.p.loadCartList=async()=>otherLoads++
 const f=fixture(async origin=>{f.p.reloadCartAfterChange(origin);other.p.reloadCartAfterChange(origin)})
 f.p.loadCartList=async()=>{ownLoads++;f.p.loading=true}
 for(let n=2;n<=6;n++){
  const saved=f.p.changeGoodsQuantity(f.p.cartList[0],n);await f.flush()
  assert.equal(f.calls.length,n-1);f.calls.at(-1).resolve();await saved
  assert.equal(ownLoads,0)
 }
 assert.equal(otherLoads,5);assert.equal(f.p.cartList[0].count,6)
 f.p.reloadCartAfterChange();assert.equal(ownLoads,1)
})
