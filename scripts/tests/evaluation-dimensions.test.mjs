import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execute, sourceOf, tick} from './native-harness.mjs'
import {evaluationFixture} from './evaluation-harness.mjs'

test('商品详情评价卡只显示北京日期，跨日 ISO 按东八区换日',()=>{
  const root='mixed-development-h5/'
  const card=sourceOf(root+'features/home/src/main/ets/presentation/components/GoodsComment.ets')
  assert.match(card,/Text\(.*[dD]ate.*evaluation\.createTime/)
  const {formatReviewDate}=execute(sourceOf(root+'commons/models/src/main/ets/TimeFormat.ets'))
  assert.equal(formatReviewDate('2026-11-20T16:26:25.940Z'),'2026-11-21')
  assert.equal(formatReviewDate('2026-11-20'),'2026-11-20')
  assert.match(card,/evaluation.spec \|\| '其他规格'/)
  assert.match(sourceOf(root+'features/home/src/main/ets/presentation/views/GoodsView.ets'),/sampleSufficient[\s\S]+样本有限，暂不足以判断/)
})

test('每个有尺码承诺的订单项必选，切换合适会清空偏差幅度', async()=>{
  const f=evaluationFixture()
  f.setLoad(async()=>({id:'order-a',canEvaluate:true,skus:[{id:'sku',sizeReviewRequired:true,promiseSnapshot:{entries:[{fieldId:'fit',status:'known'}]}}]}))
  const page=f.newPage();page.aboutToAppear();await tick()
  page.content='鞋子的日常穿着体验';page.choosePromise('sku','fit','matches','')
  await page.submitEvaluation()
  assert.equal(f.submissions.length,0)
  page.chooseSize('sku','larger','half')
  page.chooseSize('sku','true')
  await page.submitEvaluation()
  assert.deepEqual(JSON.parse(JSON.stringify(f.submissions[0][1].sizes)),[{skuId:'sku',sizeFit:'true'}])
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
