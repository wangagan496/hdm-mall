import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf, pageMethods, deferred } from './native-harness.mjs'
const base='mixed-development-h5/features/mine/src/main/ets/'
const presenter=()=>execute(sourceOf(base+'presentation/utils/AuditPresentation.ets'),{models:{formatBeijingTime:n=>String(n)}})
const merchant={id:'seller',role:'merchant',token:'session'}
function page(request){
 const p=presenter()
 const Page=pageMethods(base+'presentation/views/AuditLogView.ets','AuditLogView',{}, {...p,GlobalVariable:{},RequestAxios:{getForSession:request}})
 const view=new Page();view.user={...merchant};view.stackPath={pushPath:value=>view.navigation=value};view.active=true
 return view
}
test('AL客户端01 改价库存金额与退款文案，不显示技术字段',()=>{
 const p=presenter()
 assert.equal(p.auditActionLabel('sku.price'),'改价')
 assert.equal(p.auditChange({action:'sku.price',summary:{spec:'标准款',before:1900,after:2200}}),'标准款 ¥19.00 → ¥22.00')
 assert.equal(p.auditChange({action:'stock.adjust',summary:{before:20,after:18,reason:'盘点更正'}}),'库存 20 → 18，原因：盘点更正')
 assert.equal(p.auditChange({action:'refund.create',summary:{amountCents:4742,payerAccount:'device_buyer',reason:'after-sale'}}),'退款 ¥47.42 退回 device_buyer（售后退款）')
 assert.equal(p.auditChange({action:'settings.return_address',summary:{note:'已修改'}}),'已修改')
 assert.equal(p.auditActionLabel('aftersale.inspect'),'售后验收并退款')
 assert.doesNotMatch(p.auditChange({action:'access.denied',summary:{interface:'GET /merchant/orders/:id'}}),/merchant|GET|id/)
})
test('AL客户端02 分页与对象筛选请求、切换分段回首页',async()=>{
 const calls=[];const view=page(async url=>{calls.push(url);return {items:[],page:1,pages:3,counts:50}})
 view.productId='product a';await view.load(2)
 assert.match(calls[0],/page=2/);assert.match(calls[0],/productId=product%20a/)
 view.chooseGroup('shipping');await new Promise(r=>setImmediate(r))
 assert.equal(view.group,'shipping');assert.equal(view.filterSelected('shipping'),true);assert.match(calls[1],/page=1/)
})
test('AL客户端03 旧请求晚回不能覆盖新筛选',async()=>{
 const old=deferred();let n=0
 const view=page(()=>++n===1?old.promise:Promise.resolve({items:[{id:2}],page:1,pages:1}))
 const first=view.load(1);await view.chooseGroup('inventory');await new Promise(r=>setImmediate(r))
 old.resolve({items:[{id:1}],page:1,pages:1});await first
 assert.equal(view.items[0].id,2)
})
test('AL客户端04 切换买家或离开页面清除数据并拒绝迟到结果',async()=>{
 const pending=deferred();let calls=0;const view=page(()=>{calls++;return pending.promise})
 const first=view.load(1);view.user={id:'buyer',role:'buyer',token:'other'};view.accountChanged()
 pending.resolve({items:[{id:1}],page:1,pages:1});await first
 assert.equal(view.items.length,0);assert.equal(calls,1)
 view.open({orderId:'x'});assert.equal(view.navigation,undefined)
})
test('AL客户端05 商品和订单定向跳转，设置行不跳转',()=>{
 const view=page(async()=>({items:[],page:1,pages:0}))
 view.open({orderId:'o',productId:'p'});assert.equal(view.navigation.name,'MerchantOrderView');assert.equal(view.navigation.param,'o')
 view.open({productId:'p'});assert.equal(view.navigation.name,'ProductEditView');assert.equal(view.navigation.param,'p')
 view.navigation=undefined;view.open({});assert.equal(view.navigation,undefined)
})
test('AL客户端06 读取失败可重试，不显示旧页数据',async()=>{
 const view=page(async()=>{throw Error('offline')});view.items=[{id:1}]
 await view.load(1);assert.equal(view.items.length,0);assert.equal(view.loading,false);assert.match(view.message,/重试/)
})

test('商家页翻页与重试按钮使用主色描边，不用系统蓝', () => {
  const dir = 'mixed-development-h5/features/mine/src/main/ets/presentation/views/'
  for (const file of ['AuditLogView.ets','InventoryView.ets','MerchantOrderView.ets','ProductEditView.ets','ProductManageView.ets','AfterSaleManageView.ets']) {
    const source = sourceOf(dir + file)
    for (const label of ['上一页','下一页','重试']) {
      const plain = source.split("Button('" + label + "')").slice(1)
      for (const rest of plain) assert.ok(rest.startsWith('.backgroundColor('), file + ' ' + label)
    }
  }
})
