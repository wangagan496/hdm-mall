import { test } from 'node:test'
import assert from 'node:assert/strict'
import {join} from 'node:path'
import {createBackup,restoreBackup} from '../src/backup.ts'
import {Database} from '../src/database.ts'
import {randomBytes,randomUUID} from 'node:crypto'
import { serviceFixture } from './helpers/service-fixture.ts'

test('商家登记后仍公开，独立复核、隐藏、更正和恢复留痕',async t=>{
  const f=await serviceFixture(true)
  t.after(()=>f.close())
  const prior=process.env.REVIEW_REVIEWER_ACCOUNTS
  t.after(()=>{if(prior===undefined) delete process.env.REVIEW_REVIEWER_ACCOUNTS; else process.env.REVIEW_REVIEWER_ACCOUNTS=prior})
  process.env.REVIEW_REVIEWER_ACCOUNTS=f.other.account+', '+f.merchant.account
  const order=(await f.create()).body.result.id
  await f.complete(order)
  const original='实物的颜色偏深'
  const detail='/member/order/'+order
  await f.call('PUT',detail+'/evaluation',{score:2,content:original})
  const page='/goods/'+f.product.id+'/evaluate/page'
  const id=(await f.call('GET',page)).body.result.items[0].id
  const merchant='/merchant/reviews/'+id+'/dispute'
  const queue='/platform/reviews'
  const path=queue+'/'+id
  const reason='请核对图片和描述'
  const post=(url:string,body:object,token=f.other.token)=>f.call('POST',url,body,token)
  const sell=(body:object)=>post(merchant,body,f.merchant.token)
  const body={reason,images:[]}
  const initial=(await f.call('GET',detail)).body.result
  const rights=async()=>{
    const current=(await f.call('GET',detail)).body.result
    assert.equal(current.canEvaluate,initial.canEvaluate)
    assert.deepEqual(current.afterSaleRemaining,initial.afterSaleRemaining)
  }
  assert.equal((await sell(body)).status,403,'无归属记录不能登记')
  f.ctx.db.run("INSERT INTO product_changes VALUES(?,?,'create',?,'{}','{}',0)",f.merchant.id,'create',f.product.id)
  const outsider=f.ctx.testData.account({account:'other_seller',password:randomBytes(24).toString('hex'),role:'merchant'})
  assert.equal((await post(merchant,body,outsider.token)).status,403)
  assert.equal((await sell({images:[]})).status,400)
  assert.equal((await sell({...body,images:['unknown']})).status,400)
  const uploaded=await f.upload('/merchant/products/images',{requestKey:randomUUID()},f.merchant.token)
  assert.equal(uploaded.status,200)
  const evidence=(await f.call('GET','/merchant/review-evidence',undefined,f.merchant.token)).body.result[0]
  assert.ok(evidence)
  assert.equal((await sell({...body,images:[evidence]})).status,200)
  await rights()
  assert.equal((await f.call('GET',page)).body.result.items[0].content,original)
  assert.equal((await f.call('GET',queue)).status,403)
  assert.equal((await post(path+'/accept',{},f.merchant.token)).status,403)
  assert.equal((await f.call('GET',queue,undefined,f.other.token)).body.result.items[0].original.content,original)
  assert.equal((await post(path+'/accept',{})).status,200)
  delete process.env.REVIEW_REVIEWER_ACCOUNTS
  assert.equal((await post(path+'/conclude',{kind:'hide',reason})).status,403)
  process.env.REVIEW_REVIEWER_ACCOUNTS=f.other.account
  assert.equal((await post(path+'/conclude',{kind:'hide'})).status,400)
  assert.equal((await post(path+'/conclude',{kind:'hide',reason})).status,200)
  const hidden=(await f.call('GET',detail)).body.result.evaluation
  assert.equal(hidden.hiddenSource,'platform')
  for(const revision of [undefined,hidden.revision]){
    assert.equal((await f.call('PUT',detail+'/evaluation',{score:2,content:'希望重新说明颜色',revision})).status,403)
  }
  await rights()
  const options={databasePath:join(f.root,'data','mall.sqlite'),uploadsPath:join(f.root,'uploads')}
  const backup=await createBackup({...options,destination:join(f.root,'backup')})
  assert.deepEqual(backup.manifest.issues,[])
  const restored=await restoreBackup({backupPath:backup.root,destination:join(f.root,'restore')})
  const db=new Database(join(restored.root,'mall.sqlite'))
  try{
    assert.equal(db.one<{content:string}>('SELECT content FROM evaluations')!.content,original)
    assert.equal(db.one<{kind:string}>('SELECT kind FROM review_dispute_conclusions')!.kind,'hide')
    assert.equal(db.one<{n:number}>('SELECT count(*) n FROM review_dispute_actions')!.n,3)
  }finally{db.close()}
  assert.equal((await f.call('GET',page)).body.result.counts,0)
  const conclusion=(await f.call('GET',detail)).body.result.evaluation.dispute
  const merchantList=(await f.call('GET','/merchant/goods/'+f.product.id+'/reviews',undefined,f.merchant.token)).body.result
  assert.deepEqual(merchantList.items[0].dispute.conclusion,conclusion.conclusion)
  assert.equal(conclusion.conclusion.reason,reason)
  for(const secret of [f.other.account,f.other.id,f.buyer.account,order,'13800000000','恶意']) assert.ok(!JSON.stringify([merchantList,conclusion]).includes(secret))
  for(const token of [f.buyer.token,f.merchant.token]){
    for(const invalid of [' ', ' 更正理由 ', '字'.repeat(201)]){
      const rejected=await post('/reviews/'+id+'/correction',{reason:invalid},token)
      assert.equal(rejected.status,400)
      assert.match(rejected.body.msg,/5至200字/)
    }
    const valid=token===f.buyer.token?'请复核颜色':'字'.repeat(200)
    assert.equal((await post('/reviews/'+id+'/correction',{reason:valid},token)).status,200)
    assert.equal((await post('/reviews/'+id+'/correction',{reason},token)).status,409)
    assert.equal((await f.call('GET',page)).body.result.counts,0)
    if(token===f.buyer.token){
      assert.deepEqual((await f.call('GET',detail)).body.result.evaluation.dispute.conclusion,conclusion.conclusion)
      assert.equal((await post(path+'/accept',{})).status,200)
      assert.equal((await post(path+'/conclude',{kind:'maintain',reason})).status,200)
      assert.equal((await f.call('GET',page)).body.result.counts,0)
      assert.equal((await f.call('GET',detail)).body.result.evaluation.hiddenSource,'platform')
    }
  }
  assert.equal((await post(path+'/accept',{})).status,200)
  assert.equal((await post(path+'/conclude',{kind:'correct',reason})).status,200)
  assert.equal((await f.call('GET',page)).body.result.items[0].content,original)
  assert.equal(f.ctx.db.one<{n:number}>('SELECT count(*) n FROM review_dispute_actions')!.n,9)
  f.ctx.db.run("UPDATE review_disputes SET status='registered'")
  await assert.rejects(createBackup({...options,destination:join(f.root,'broken')}),/复核状态与历史不一致/)
})

test('普通内容隐藏仍支持修改后发布',async t=>{
  const f=await serviceFixture()
  t.after(()=>f.close())
  const order=(await f.create()).body.result.id
  await f.complete(order)
  const detail='/member/order/'+order
  assert.equal((await f.call('PUT',detail+'/evaluation',{score:3,content:'商品包装有折痕'})).status,200)
  f.ctx.db.run('INSERT INTO review_moderation VALUES(?,?,?,?)',order,'广告',Date.now(),f.merchant.id)
  assert.equal((await f.call('GET',detail)).body.result.evaluation.hiddenSource,'content')
  assert.equal((await f.call('PUT',detail+'/evaluation',{score:3,content:'商品收到时包装有折痕'})).status,200)
  assert.equal((await f.call('GET','/goods/'+f.product.id+'/evaluate/page')).body.result.items[0].content,'商品收到时包装有折痕')
})
