import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execute, sourceOf, tick} from './native-harness.mjs'
import {evaluationFixture} from './evaluation-harness.mjs'

test('商品详情评价卡以北京时间显示到分钟',()=>{
  const root='mixed-development-h5/'
  const {formatBeijingTime}=execute(sourceOf(root+'commons/models/src/main/ets/TimeFormat.ets'))
  const card=sourceOf(root+'features/home/src/main/ets/presentation/components/GoodsComment.ets')
  assert.match(card,/Text\(formatBeijingTime\(evaluation\.createTime\)\)/)
  assert.equal(formatBeijingTime('2026-11-20T06:26:25.940Z'),'2026-11-20 14:26')
})

test('买家按冻结条目提交三项评分，提交体不带订单联系人或冻结版本',async()=>{
  const f=evaluationFixture()
  f.setLoad(async()=>({id:'order-a',canEvaluate:true,address:{contact:'private'},afterSales:[{}],
    skus:[{id:'sku',promiseSnapshot:{templateVersion:'v1',entries:[{fieldId:'fit',status:'known',label:'版型'}]}}]}))
  const page=f.newPage();page.aboutToAppear();await tick()
  page.score=3;page.logisticsScore=4;page.serviceScore=2;page.content='商品使用体验一般'
  await page.submitEvaluation()
  assert.equal(f.submissions.length,0)
  page.choosePromise('sku','fit','unnoticed','没有留意')
  await page.submitEvaluation()
  assert.deepEqual(JSON.parse(JSON.stringify(f.submissions[0][1])),{score:3,content:page.content,logisticsScore:4,serviceScore:2,
    items:[{skuId:'sku',fieldId:'fit',result:'unnoticed',note:'没有留意'}]})
})
test('主动改评保留原文和预期版本，未收货说明来自订单资格',async()=>{
  const f=evaluationFixture()
  f.setLoad(async()=>({id:'order-a',canEvaluate:true,skus:[],evaluation:{score:3,content:'之前的使用感受',revision:2,items:[]}}))
  const page=f.newPage();page.aboutToAppear();await tick()
  assert.equal(page.content,'之前的使用感受')
  page.content='现在的使用感受';await page.submitEvaluation()
  assert.equal(page.order.evaluation.content,'之前的使用感受')
  assert.equal(f.submissions[0][1].revision,2)
  f.setLoad(async()=>({id:'order-a',canEvaluate:false,skus:[],evaluationRule:'未收货仅退款的订单不能评价'}))
  const next=f.newPage();next.aboutToAppear();await tick()
  assert.match(next.errorText,/仅退款/)
})
