import {test} from 'node:test'
import assert from 'node:assert/strict'
import {pageMethods,sourceOf} from './native-harness.mjs'
const merchant='mixed-development-h5/features/mine/src/main/ets/presentation/views/AfterSaleManageView.ets'
const buyer='mixed-development-h5/features/cart/src/main/ets/presentation/views/AfterSaleApplyView.ets'
const card='mixed-development-h5/features/cart/src/main/ets/presentation/components/AfterSaleCard.ets'
function page(path,name){return new (pageMethods(path,name,{},{$r:x=>x,GlobalVariable:{},Date,Math,afterSaleActions:{pending:()=>null},formatBeijingTime:()=> '11-11 12:58'}))()}
test('R6/R3 步进器显示和使能订阅实时数组，避免 ForEach 捕获旧行',()=>{
 for(const [path,field,prefix] of [[buyer,'count','after-sale-count'],[merchant,'restockCount','after-sale-restock']]) {
  const lines=sourceOf(path).split('\n').filter(line=>line.includes(".id('"+prefix)&&line.includes("'+index)"))
  assert.equal(lines.length,3)
  for(const line of lines){assert.ok(line.includes('this.lines[index].'+field),line);assert.ok(!line.includes('line.'+field),line)}
 }
})
test('R1 买家待寄回可确认撤回，弹窗过期不提交',()=>{
 const p=page(card,'AfterSaleCard');p.sale={state:'awaiting-return'};p.owner=true;p.ready=true;p.active=true;p.user={token:'t'}
 let dialog,calls=0;p.getUIContext=()=>({showAlertDialog:x=>dialog=x});p.act=()=>calls++
 p.requestWithdraw();assert.match(dialog.message,/撤回后需在售后期内重新申请/)
 p.aboutToDisappear();dialog.secondaryButton.action();assert.equal(calls,0)
 assert.match(sourceOf(card),/不退了，撤回申请/)
})
test('R3 商家具体动作、字段延迟错误和有界验收步进',()=>{
 const p=page(merchant,'AfterSaleManageView');p.selected={kind:'return-quality',amountCents:4742};p.action='approve'
 assert.equal(p.actionLabel(),'同意并发送退货地址');assert.equal(p.fieldError('receiver'),'')
 p.addressSubmitted=true;assert.match(p.fieldError('receiver'),/收件人/)
 p.selected.kind='refund-missing';assert.equal(p.actionLabel(),'同意并退款 ¥47.42')
 p.action='inspect';assert.equal(p.actionLabel(),'验收并退款 ¥47.42');p.lines=[{count:2,restockCount:2}]
 p.stepRestock(0,1);assert.equal(p.lines[0].restockCount,2);p.stepRestock(0,-1);assert.equal(p.lines[0].restockCount,1)
 p.stepRestock(0,-1);p.stepRestock(0,-1);assert.equal(p.lines[0].restockCount,0)
 const s=sourceOf(merchant);assert.doesNotMatch(s,/Button\('返回列表'\)/);assert.match(s,/商品不完好，拒绝退款/)
 for(const label of ['收件人','联系电话','退货地址','不合格的不入库'])assert.ok(s.includes(label))
})
test('R4 商家筛选计数、选中态、类型提示、十二小时提醒与入库结果',()=>{
 const p=page(merchant,'AfterSaleManageView');p.stateCounts={pending:2,returned:1,all:3};p.filter='pending'
 assert.equal(p.filterLabel('pending'),'待处理 2');assert.equal(p.filterSelected('pending'),true);assert.equal(p.filterSelected('all'),false)
 p.message='任意成功提示';p.messageType='success';assert.equal(p.messageColor(),'[ui_components].color.text')
 p.messageType='error';assert.equal(p.messageColor(),'[ui_components].color.red');p.now=1000
 assert.equal(p.urgent({state:'pending',reviewDeadline:1000+11*3600000}),true)
 assert.equal(p.restockText({items:[{count:2,restockCount:1}]}),'退回 2 件，合格入库 1 件，不合格 1 件（不入可售库存）')
 const s=sourceOf(merchant);assert.doesNotMatch(s,/sale\.orderAddress|sale\.orderId\+|Button\(this\.loading\?'读取中':'刷新'\)/);assert.match(s,/HorizontalAlign.Start/)
})
test('R5 买家卡片时限、地址分行和主色按钮',()=>{
 const p=page(card,'AfterSaleCard');p.sale={state:'pending',reviewDeadline:1};assert.equal(p.deadlineText(),'商家最晚 11-11 12:58 处理，超时自动同意')
 p.sale={state:'returned',inspectDeadline:2};assert.match(p.deadlineText(),/验收，超时自动退款/)
 const s=sourceOf(card);for(const label of ['收件人：','电话：','地址：'])assert.ok(s.includes(label));assert.match(s,/color.red/);assert.match(s,/HorizontalAlign.Start/)
})
test('R6 买家数量步进限定范围，全零禁止提交且展示原因',()=>{
 const p=page(buyer,'AfterSaleApplyView');p.lines=[{count:1,remaining:2}];p.order={canApplyAfterSale:true}
 p.stepCount(0,1);p.stepCount(0,1);assert.equal(p.lines[0].count,2)
 p.stepCount(0,-1);p.stepCount(0,-1);p.stepCount(0,-1);assert.equal(p.lines[0].count,0);assert.equal(p.canSubmit(),false)
 assert.equal(p.quantityHint(),'请至少选择 1 件');p.stepCount(0,1);assert.equal(p.canSubmit(),true)
 assert.doesNotMatch(sourceOf(buyer),/TextInput\(\{text:String\(line.count\)/)
})
test('R7 商家卡片金额按状态写清是否已退款，按钮不用系统蓝',()=>{
 const p=page(merchant,'AfterSaleManageView')
 assert.equal(p.amountText({state:'refunded',amountCents:4742,payerAccount:'b'}),'已退款 ¥47.42，退回 b')
 assert.equal(p.amountText({state:'refunding',amountCents:4742,payerAccount:'b'}),'退款中 ¥47.42，退回 b')
 for(const state of ['withdrawn','rejected','closed','refund-rejected'])assert.equal(p.amountText({state,amountCents:4742,payerAccount:'b'}),'申请金额 ¥47.42，未退款')
 assert.equal(p.amountText({state:'pending',amountCents:4742,payerAccount:'b'}),'申请退款 ¥47.42，将退回 b')
 const s=sourceOf(merchant);assert.doesNotMatch(s,/不合格填0/)
 for(const label of ['设置默认退货地址','上一页','下一页'])assert.ok(s.includes("Button('"+label+"').backgroundColor"),label)
})
