import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf, pageMethods } from './native-harness.mjs'
const path='mixed-development-h5/commons/models/src/main/ets/ReturnPolicy.ets'
const model=()=>execute(sourceOf(path))
const policy=(reason,confirmed=true)=>({returnPolicy:reason==='custom'?'law-excluded':reason?'confirm-required':'standard',returnPolicyReason:reason,returnPolicyNote:reason==='defect'?'外包装有轻微划痕':'',returnPolicyConfirmed:confirmed})

test('RP客户端01 固定九种选项与瑕疵说明边界',()=>{
 const m=model();assert.equal(m.RETURN_POLICY_OPTIONS.length,9)
 assert.equal(m.returnPolicyError(policy('defect')),'')
 assert.match(m.returnPolicyError({...policy('defect'),returnPolicyNote:''}),/5.*100/)
 assert.match(m.returnPolicyError({...policy('defect'),returnPolicyNote:'字'.repeat(101)}),/5.*100/)
 assert.ok(m.returnPolicyError(policy('invented')))
})
test('RP客户端02 详情购物车按原因显示白话，不把所有限制写成拆封后',()=>{
 const m=model()
 assert.equal(m.returnPolicyLabel(policy('')),'支持七日无理由退货')
 assert.match(m.returnPolicyLabel(policy('custom')),/定作/)
 assert.match(m.returnPolicyLabel(policy('unsealed')),/拆封后/)
 assert.match(m.returnPolicyLabel(policy('activated')),/激活或试用后/)
 assert.match(m.returnPolicyLabel(policy('near-expiry')),/临近保质期/)
 assert.doesNotMatch(m.returnPolicyLabel(policy('near-expiry')),/拆封/)
 assert.match(m.returnPolicyLabel(policy('defect')),/外包装有轻微划痕/)
})
test('RP客户端03 确认默认未勾选，校验需确认商品而非法定排除商品',()=>{
 const m=model(),gate=new m.ReturnPolicyConfirmation()
 assert.equal(gate.confirmed,false);assert.equal(gate.highlighted,false)
 gate.refresh('a');assert.equal(gate.validate([policy('custom')]),true)
 assert.equal(gate.validate([policy('unsealed')]),false);assert.equal(gate.highlighted,true)
 gate.choose(false);assert.equal(gate.highlighted,true)
 gate.choose(true);assert.equal(gate.validate([policy('unsealed')]),true);assert.equal(gate.highlighted,false)
})
test('RP客户端04 新规则和账号重置撤销确认，重复相同预览不抹掉选择',()=>{
 const m=model(),gate=new m.ReturnPolicyConfirmation()
 gate.refresh('a');gate.choose(true);gate.refresh('a');assert.equal(gate.confirmed,true)
 gate.refresh('b');assert.equal(gate.confirmed,false)
 gate.choose(true);gate.reset();assert.equal(gate.confirmed,false);assert.equal(gate.token,'')
})
test('RP客户端05 未拆封和未激活保留无理由入口，声明不可默认选择',()=>{
 const m=model()
 for(const reason of ['unsealed','activated']){
  assert.equal(m.returnPolicyAllowsNoReason(policy(reason)),true)
  assert.match(m.returnConditionError(policy(reason),undefined),/请选择/)
  assert.match(m.returnConditionError(policy(reason),'unsealed'),/不支持/)
  assert.equal(m.returnConditionError(policy(reason),'sealed'),'')
 }
 assert.equal(m.returnPolicyAllowsNoReason(policy('near-expiry')),false)
 assert.equal(m.returnPolicyAllowsNoReason(policy('defect',false)),true)
 assert.match(m.returnPolicyAfterSaleHint(policy('defect')),/不同.*质量问题/)
})
test('RP客户端06 商家准确显示拆封与激活声明，未声明不冒认',()=>{
 const m=model()
 assert.equal(m.returnConditionLabel('unsealed','sealed'),'买家声明：未拆封')
 assert.equal(m.returnConditionLabel('activated','sealed'),'买家声明：未激活或试用')
 assert.equal(m.returnConditionLabel('activated',undefined),'')
})

const root='mixed-development-h5/features/'
test('RP页面01 商品新建默认支持，保存带规则，编辑差异和冲突保留买家限制说明',()=>{
 const Page=pageMethods(root+'mine/src/main/ets/presentation/views/ProductEditView.ets','ProductEditView',{}, {GlobalVariable:{}})
 const page=new Page();page.changed=()=>{}
 assert.equal(page.empty().returnPolicy,'standard')
 page.choosePolicy(model().RETURN_POLICY_OPTIONS.find(option=>option.reason==='defect'))
 assert.match(page.validationError('policy'),/5.*100/)
 page.draft.returnPolicyNote='外包装有轻微划痕'
 assert.equal(page.saveBody().returnPolicyNote,'外包装有轻微划痕')
 const product={id:'p',name:'商品',description:'',categoryId:'c',imageId:'',picture:'',status:'on',revision:2,skus:[],...policy('')}
 page.productId='p';page.draft=page.fromProduct(product)
 page.choosePolicy(model().RETURN_POLICY_OPTIONS.find(option=>option.reason==='activated'))
 const body=page.saveBody();assert.equal(body.returnPolicyReason,'activated');assert.equal(body.expectedRevision,2)
 page.mergeConflict({...product,revision:3,name:'新名'})
 assert.equal(page.draft.returnPolicyReason,'activated');assert.equal(page.draft.name,'新名')
 page.draft=page.fromProduct(product);assert.equal(page.saveBody().returnPolicy,undefined)
})

function checkout(){
 const writes=[],scrolls=[],messages=[];let submit=async()=>({id:'order'}),sequence=0
 const Page=pageMethods(root+'cart/src/main/ets/presentation/views/CheckView.ets','CheckView',{}, {
  CheckoutSheet:{None:0},GlobalVariable:{DEMO_ORDER_FLOW:false},util:{generateRandomUUID:()=>String(++sequence)},
  storeManager:{savePendingOrder:async()=>{},clearPendingOrder:async()=>{}},authCart:{updateCartCount:async()=>{}},
  checkoutFailure:error=>error,createOrderAPI:async request=>{writes.push(structuredClone(request));return submit()},PAGE_PATH:{PAY_PAGE:'pay'},
  Scroller:class{scrollToIndex(...args){scrolls.push(args)}},
 })
 const page=new Page();page.user={id:'buyer',token:'test-session'};page.checkoutToken='test-session';page.checkoutLoading=false
 page.addressId='address';page.addressList=[{id:'address'}];page.goodsList=[{skuId:'sku',name:'商品',count:1,...policy('unsealed')}]
 page.stackPath={replacePath:()=>{}};page.safeToast=text=>messages.push(text);page.refreshReturnPolicy('version-a')
 return {page,writes,scrolls,messages,setSubmit:fn=>{submit=fn}}
}
test('RP页面02 结算未勾选不写订单不toast，主动确认及内容版本进入请求与摘要',async()=>{
 const f=checkout();await f.page.submitCheckout();assert.equal(f.writes.length,0);assert.equal(f.messages.length,0);assert.equal(f.scrolls.length,1)
 f.page.chooseReturnPolicy(true);await f.page.submitCheckout()
 assert.equal(f.writes[0].returnPolicyConfirmed,true);assert.equal(f.writes[0].expectedReturnPolicyToken,'version-a')
 assert.equal(JSON.parse(f.page.requestSummary).expectedReturnPolicyToken,'version-a')
 assert.equal(f.page.copyCheckoutItem(f.page.goodsList[0]).returnPolicyReason,'unsealed')
})
test('RP页面03 结算规则冲突更新逐项提示并清确认，重新确认才可下单',async()=>{
 const f=checkout();f.page.chooseReturnPolicy(true)
 f.setSubmit(async()=>{throw {status:409,reason:'RETURN_POLICY_CHANGED',result:{returnPolicyToken:'version-b',goods:[{skuId:'sku',name:'商品',...policy('activated')}]}}})
 await f.page.submitCheckout();assert.equal(f.page.returnPolicy.confirmed,false);assert.equal(f.page.returnPolicy.highlighted,true)
 assert.equal(f.page.returnPolicy.token,'version-b');assert.equal(f.page.goodsList[0].returnPolicyReason,'activated')
 await f.page.submitCheckout();assert.equal(f.writes.length,1)
 f.setSubmit(async()=>({id:'order'}));f.page.chooseReturnPolicy(true);await f.page.submitCheckout();assert.equal(f.writes.length,2)
})

test('RP页面04 混合售后逐项保留规则，受限行排除且说明，未拆封声明入请求',async()=>{
 const calls=[],models=execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/AfterSaleModels.ets'))
 const Page=pageMethods(root+'cart/src/main/ets/presentation/views/AfterSaleApplyView.ets','AfterSaleApplyView',{}, {
  GlobalVariable:{},...models,orderWriteFailure:()=>({}),
  afterSaleActions:{pending:()=>null,start:async(...args)=>calls.push(args)},
  getAfterSaleOrderAPI:async()=>({canApplyAfterSale:true,orderState:4,afterSaleKinds:['return-no-reason','return-quality'],skus:[
   {id:'a',name:'拆封类',realPay:1,afterSaleRemaining:1,...policy('unsealed'),afterSaleKinds:['return-no-reason','return-quality']},
   {id:'b',name:'定作类',realPay:2,afterSaleRemaining:1,...policy('custom'),afterSaleKinds:['return-quality']},
  ]}),
 })
 const page=new Page();page.user={id:'buyer',token:'test-session'};page.stackPath={pop:()=>{}};await page.load()
 assert.equal(page.lines[0].returnPolicyReason,'unsealed');assert.equal(page.lines[0].conditionDeclared,undefined)
 assert.equal(page.lines[1].count,0);assert.equal(page.lineAllowed(page.lines[1]),false)
 await page.submit();assert.equal(calls.length,0);assert.match(page.message,/请选择/)
 page.chooseCondition(0,'unsealed');await page.submit();assert.equal(calls.length,0);assert.match(page.message,/不支持/)
 page.chooseCondition(0,'sealed');await page.submit();assert.equal(calls[0][2].items[0].conditionDeclared,'sealed');assert.equal(calls[0][2].items.length,1)
 page.selectKind('return-quality');page.stepCount(1,1);page.description='实物有质量问题';await page.submit()
 assert.equal(calls[1][2].items[0].conditionDeclared,undefined);assert.ok(calls[1][2].items.some(item=>item.skuId==='b'))
})
test('RP页面05 详情购物车确认区与商家验收绑定真实字段，审计不显示枚举JSON',()=>{
 for(const [file,text] of [
  ['home/src/main/ets/presentation/components/GoodsInfo.ets','returnPolicyLabel(this.getGoods())'],
  ['cart/src/main/ets/presentation/components/CartItem.ets','returnPolicyLabel(this.cart)'],
  ['cart/src/main/ets/presentation/views/CheckView.ets','checkout-policy-warning'],
  ['cart/src/main/ets/presentation/views/AfterSaleApplyView.ets','after-sale-condition-'],
  ['mine/src/main/ets/presentation/views/AfterSaleManageView.ets','returnConditionLabel'],
 ])assert.ok(sourceOf(root+file).includes(text),file)
 const presenter=execute(sourceOf(root+'mine/src/main/ets/presentation/utils/AuditPresentation.ets'))
 assert.equal(presenter.auditActionLabel('product.return_policy'),'修改退货规则')
 const text=presenter.auditChange({action:'product.return_policy',summary:{before:JSON.stringify({policy:'standard',reason:'',note:''}),after:JSON.stringify({policy:'confirm-required',reason:'activated',note:''})}})
 assert.match(text,/支持七日.*→.*激活/);assert.doesNotMatch(text,/confirm-required|returnPolicy/)
})
test('RP设备01 探针保留真实页面声明及商家验收，归档包含订单库存金额证据',()=>{
 const source=sourceOf('scripts/device-trade-regression.ps1')
 for(const text of ['[switch]$ReturnPolicyProbe','function Invoke-ReturnPolicyProbe','checkout-policy-checkbox',
  'after-sale-condition-0-sealed','merchant-condition-0','returnPolicyConfirmed','returnPolicyProof','-ReturnPolicyProbe']){
  assert.ok(source.includes(text),text)
 }
})
test('RP页面06 商品展示转换保留详情最新规则，不使用点击卡片的旧规则',()=>{
 const {normalizeGoodsPresentation}=execute(sourceOf(root+'home/src/main/ets/data/api/goodsPresentation.ets'))
 const displayed=normalizeGoodsPresentation({id:'p',name:'商品',price:1,picture:'',...policy('')},
  {id:'p',name:'商品',picture:'',skus:[],specs:[],...policy('activated')})
 assert.equal(displayed.returnPolicy,'confirm-required')
 assert.equal(displayed.returnPolicyReason,'activated')
})
test('RP页面07 结算提示列表的复用键包含规则内容，避免同SKU规则更新仍显示旧文案',()=>{
 const source=sourceOf(root+'cart/src/main/ets/presentation/views/CheckView.ets')
 assert.match(source,/\(item: OrderGoodsItem\) => item\.skuId \+.*item\.returnPolicy.*item\.returnPolicyReason.*item\.returnPolicyNote/)
})
