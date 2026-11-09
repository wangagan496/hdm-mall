import {test} from 'node:test'
import assert from 'node:assert/strict'
import {evaluationFixture} from './evaluation-harness.mjs'
import {tick} from './native-harness.mjs'
test('UX14 未知评价保留提交快照，回前台只查同内容不自动再写',async()=>{
 const f=evaluationFixture(),p=f.newPage();p.aboutToAppear();await tick();p.content='本次提交的文字';p.score=4
 f.setSubmit(async()=>{throw Object.assign(new Error('lost'),{isAxiosError:true})});f.setLoad(async()=>{throw new Error('offline')});await p.submitEvaluation()
 assert.equal(p.resultUnknown,true);assert.equal(JSON.parse(f.saved.get('evaluation-draft:a:order-a')).pending.content,'本次提交的文字')
 await p.submitEvaluation();assert.equal(f.submissions.length,1)
 f.setLoad(async()=>({id:'order-a',canEvaluate:false,evaluation:{score:4,content:'本次提交的文字'}}));await p.refreshEvaluationResult();assert.equal(p.submitted,true);assert.equal(p.errorText,'评价已发布');assert.equal(f.submissions.length,1);assert.equal(f.saved.has('evaluation-draft:a:order-a'),false)
})
test('UX14 查无才允许继续提交，不同设备的评价不认作本次成功',async()=>{
 for(const result of [null,{score:1,content:'另一设备的评价'}]){
  const f=evaluationFixture(),p=f.newPage();p.aboutToAppear();await tick();p.content='本次提交的文字';p.score=4
  f.setSubmit(async()=>{throw Object.assign(new Error('lost'),{isAxiosError:true})});f.setLoad(async()=>{throw new Error('offline')});await p.submitEvaluation()
  f.setLoad(async()=>({id:'order-a',canEvaluate:!result,evaluation:result}));await p.refreshEvaluationResult();assert.equal(p.submitted,false);assert.equal(p.resultUnknown,false);assert.equal(p.content,'本次提交的文字');assert.equal(f.submissions.length,1)
  assert.match(p.errorText,result?/不同评价/:/继续提交/)
 }
})
