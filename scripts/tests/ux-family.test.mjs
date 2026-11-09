import {test} from 'node:test'
import assert from 'node:assert/strict'
import {pageMethods,deferred,tick,sourceOf} from './native-harness.mjs'
const path='mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets'
test('UX18 未知代收只核对对应卡片，保留关系输入且禁止自动重发',async()=>{
 const queries=[],timers=new Map();let timer=0, writes=0,loads=0
 const P=pageMethods(path,'FamilyView',{}, {OrderState:{AWAITING_RECEIPT:3},setTimeout:fn=>{timers.set(++timer,fn);return timer},clearTimeout:id=>timers.delete(id),
 getFamilyOrderDetailAPI:(id,token)=>{const d=deferred();queries.push({id,token,...d});return d.promise}, cancelActionFailure:()=>({status:0,reason:''})})
 const p=new P();Object.assign(p,{user:{token:'a',role:'buyer'},sessionToken:'a',sessionRole:'buyer',loadedToken:'a',friendAccount:'尚未提交的亲友',familyOrders:[{id:'o',orderState:3,canReceive:true},{id:'b',orderState:1,canPay:true}]})
 p.safeToast=()=>{};p.loadFamilyCenter=async()=>loads++
 await p.submitThenRefresh(async()=>{writes++;throw new Error('offline')},'已代收','o')
 assert.equal(p.errorText,'');assert.equal(p.pendingFamilyOrders.includes('o'),true);assert.equal(timers.size,1)
 const [id,fn]=timers.entries().next().value;timers.delete(id);fn();await tick();assert.equal(queries[0].id,'o')
 queries[0].resolve({id:'o',orderState:4,canReceive:false});await tick()
 assert.equal(p.familyOrders[0].orderState,4);assert.equal(p.familyOrders[1].id,'b');assert.equal(p.friendAccount,'尚未提交的亲友');assert.equal(loads,0);assert.equal(writes,1);assert.equal(timers.size,0)
 assert.equal(p.pendingFamilyOrders.length,0)
})
test('UX18 亲友中心顶部角色分组与次级关系管理入口',()=>{
 const s=sourceOf(path);for(const label of ['待我付款','待我收货','待处理','关系管理','商家发货'])assert.ok(s.includes(label),label)
 assert.match(s,/if \(this\.relationsExpanded\)/)
})
test('UX18 亲友筛选显示数量与选中态，关系分页置于列表后且单页隐藏',()=>{
 const s=sourceOf(path)
 for(const token of ['familyGroupCount','familyGroupLabel','familyEmptyText','$r(\'[ui_components].color.under\')','$r(\'[ui_components].color.text\')'])assert.ok(s.includes(token),token)
 assert.match(s,/familyGroupLabel\(item\.key, item\.label\)/)
 assert.doesNotMatch(s,/Button\(this\.loading \? '加载中\.\.\.' : '刷新'\)/)
 assert.match(s,/ForEach\(this\.visibleFamilyOrders[\s\S]*?if \(this\.familyPages > 1\)/)
 assert.match(s,/if \(this\.relationPages > 1\)/)
 assert.match(s,/Button\(this\.relationsExpanded \? '收起关系管理' : '关系管理'\)/)
 assert.doesNotMatch(s,/fontColor\('#[0-9A-Fa-f]{6}'\)|backgroundColor\('#[0-9A-Fa-f]{6}'\)|backgroundColor\(Color\.White\)/)
})
test('UX18 默认跳到首个有内容的亲友筛选，并显示当前筛选空态文案',()=>{
 const P=pageMethods(path,'FamilyView',{}, {OrderState:{}})
 const p=new P();p.familyOrders=[{id:'receipt',canReceive:true},{id:'pay',canPay:true}];p.pendingFamilyOrders=[]
 assert.equal(p.familyGroupCount('pay'),1);assert.equal(p.familyGroupLabel('receipt','待我收货'),'待我收货 1')
 p.familyGroup='pay';assert.equal(p.familyEmptyText(),'暂时没有需要你付款的订单')
 p.familyOrders=[];assert.equal(p.familyGroupCount('all'),0);assert.equal(p.familyEmptyText(),'暂时没有需要你付款的订单')
})

test('UX18 全量计数叠加本地未确认操作，单卡核对更新数量且不重载其他卡片',async()=>{
 const P=pageMethods(path,'FamilyView',{}, {OrderState:{},getFamilyOrderDetailAPI:async()=>({id:'o',canReceive:false,orderState:4})})
 const p=new P();Object.assign(p,{user:{token:'a',role:'buyer'},sessionToken:'a',sessionRole:'buyer',loadedToken:'a',
  familyGroup:'receipt',familyGroupCounts:{pay:5,receipt:11,pending:0,all:30},familyPages:2,
  familyOrders:[{id:'o',canReceive:true}],pendingFamilyOrders:['o']})
 assert.equal(p.familyGroupCount('pending'),1)
 await p.checkFamilyOrder('o')
 assert.equal(p.familyGroupCount('receipt'),10);assert.equal(p.familyGroupCount('pending'),0)
 assert.equal(p.familyGroupCount('all'),30);assert.equal(p.familyPages,1)
})
