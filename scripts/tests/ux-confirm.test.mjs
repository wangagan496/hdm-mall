import {test} from 'node:test'
import assert from 'node:assert/strict'
import {pageMethods,sourceOf,deferred} from './native-harness.mjs'
const root='mixed-development-h5/'
test('UX22 默认动词兼容，异步确认与外部忙碌均禁止重复点击',async()=>{
 const C=pageMethods(root+'commons/ui-components/src/main/ets/components/HDMConfirm.ets','HDMConfirm'),p=new C(),d=deferred();let count=0,cancel=0
 assert.equal(p.confirmText,'确定');assert.equal(p.cancelText,'取消');p.onConfirm=()=>{count++;return d.promise};p.onCancel=()=>cancel++
 const a=p.confirm();await p.confirm();p.cancel();assert.equal(count,1);assert.equal(cancel,0);d.resolve();await a
 p.busy=true;await p.confirm();p.cancel();assert.equal(count,1);assert.equal(cancel,0);p.busy=false;p.cancel();assert.equal(cancel,1)
})
test('UX22 全部确认调用方提供具体动词与忙碌状态',()=>{
 for(const [path,verb] of [['cart/CartView','清空购物车'],['mine/AddressView','删除地址'],['mine/HistoryView','清空浏览足迹'],['mine/SettingView','退出账号']]){
  const [module,page]=path.split('/'),s=sourceOf(root+'features/'+module+'/src/main/ets/presentation/views/'+page+'.ets')
  assert.ok(s.includes("confirmText: '"+verb+"'"));assert.match(s,/HDMConfirm\(\{[\s\S]*?busy:/)
 }
})
