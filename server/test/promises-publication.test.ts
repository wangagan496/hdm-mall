import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBackup, restoreBackup } from '../src/backup.ts'
import { Database } from '../src/database.ts'
import { createPromiseDriver, type PromiseDriver } from '../src/promises/extract.ts'
import { promiseTables } from '../src/promises/backup.ts'
import { sourceRecordTables } from '../src/source-verification/backup.ts'
import type { PromiseDraft, PromiseSnapshot } from '../src/promises/generated.ts'
import { buildTestApp } from './helpers/fixtures.ts'
import { identityHeaders } from './helpers/identity-headers.ts'
import { materialDigest } from '../src/source-verification/materials.ts'

const description = '支持7天退换。承诺48小时内发货。'

test('多规格反馈各自恢复，缺一项、重复、混用简写或备份镜像不一致均拒绝',async()=>{
  const root=await mkdtemp(join(tmpdir(),'size-review-backup-'))
  const databasePath=join(root,'data','mall.sqlite'), uploadsPath=join(root,'uploads')
  const f=await fixture(databasePath,uploadsPath)
  try {
    f.ctx.db.run("UPDATE products SET category='服饰',description='版型标准。' WHERE id=?",f.product.id)
    const receipt=(await f.publish(await f.confirm(await f.extract()))).result as PromiseSnapshot
    const id=await f.order(true)
    const path='/member/order/'+id
    assert.equal((await f.call('POST',path+'/mock-pay',{amountCents:4600})).status,200)
    assert.equal((await f.call('POST','/merchant/orders/'+id+'/ship',{carrier:'顺丰',trackingNo:'SF12345678'},f.merchant.token)).status,200)
    assert.equal((await f.call('PUT',path+'/receipt')).status,200)
    const items=[f.sku,f.second].flatMap(sku=>receipt.entries.filter(e=>e.status==='known').map(e=>({skuId:sku.id,fieldId:e.fieldId,result:'matches'})))
    const sizes=[{skuId:f.sku.id,sizeFit:'smaller',sizeShift:'full'},{skuId:f.second.id,sizeFit:'true'}]
    const save=(extra:object)=>f.call('PUT',path+'/evaluation',{score:4,content:'两种规格的体验不同',items,...extra})
    assert.equal((await save({sizes:sizes.slice(0,1)})).status,400)
    assert.equal((await save({sizes:[sizes[0],sizes[0]]})).status,400)
    assert.equal((await save({sizes,sizeFit:'true'})).status,400)
    const prior=await f.detail(id)
    assert.equal((await save({sizes})).status,200)
    const detail=await f.detail(id)
    assert.deepEqual(detail.afterSaleRemaining,prior.afterSaleRemaining)
    assert.deepEqual(detail.skus.map((s:{promiseChecks:object[]})=>s.promiseChecks),[[],[]])
    assert.ok(detail.skus.every((s:{sizeReviewRequired:boolean})=>s.sizeReviewRequired))
    const backup=await createBackup({databasePath,uploadsPath,destination:join(root,'backup')})
    assert.equal(backup.counts.evaluation_sizes,2)
    const restored=await restoreBackup({backupPath:backup.root,destination:join(root,'restored')})
    const db=new Database(join(restored.root,'mall.sqlite'))
    try {
      for(const size of sizes){
        const row=db.one<{size_fit:string;size_shift:string|null}>('SELECT size_fit,size_shift FROM evaluation_sizes WHERE order_id=? AND sku_id=?',id,size.skuId)!
        assert.equal(row.size_fit,size.sizeFit)
        assert.equal(row.size_shift,size.sizeShift??null)
      }
    } finally {db.close()}
    f.ctx.db.run("UPDATE evaluations SET size_fit='true' WHERE order_id=?",id)
    await assert.rejects(createBackup({databasePath,uploadsPath,destination:join(root,'invalid')}),/尺码评价/)
  } finally {await f.ctx.app.close();await rm(root,{recursive:true,force:true})}
})

test('尺码选择以收货项为准，三个同规格同发布的样本才显示均分和尺码多数', async () => {
  const f = await fixture()
  try {
    f.ctx.db.run("UPDATE products SET category='鞋靴',description='版型偏大。' WHERE id=?", f.product.id)
    const snapshot = (await f.publish(await f.confirm(await f.extract()))).result as PromiseSnapshot
    const page = '/goods/' + f.product.id + '/evaluate/page?threshold=1&skuId=' + f.sku.id
    for (const [index, sku] of [f.sku, f.second, f.sku, f.sku].entries()) {
      const id = await f.order(false, [sku])
      const path = '/member/order/' + id
      assert.equal((await f.call('POST', path+'/mock-pay', {amountCents:2300})).status,200)
      assert.equal((await f.call('POST','/merchant/orders/'+id+'/ship',{carrier:'顺丰',trackingNo:'SF12345678'},f.merchant.token)).status,200)
      assert.equal((await f.call('PUT',path+'/receipt')).status,200)
      const items = snapshot.entries.filter(e=>e.status==='known').map(e=>({skuId:sku.id,fieldId:e.fieldId,result:'matches'}))
      const input = {score:4, logisticsScore:2, content:'穿着体验与描述相符',items}
      const save = (extra:object) => f.call('PUT',path+'/evaluation',{...input,...extra})
      assert.equal((await save({})).status,400)
      assert.equal((await save({sizeFit:'true',sizeShift:'half'})).status,400)
      assert.equal((await save({sizeFit:'larger',sizeShift:'两码'})).status,400)
      assert.equal((await save(index===3 ? {sizeFit:'smaller'} : {sizeFit:'larger',sizeShift:'half'})).status,200)
      const result=(await f.call('GET',page)).result
      assert.equal(result.summary.sampleSufficient,index===3)
      if (index<3) {
        assert.equal(result.summary.product,undefined)
        assert.equal(result.sizeSummary.conclusion,'样本有限，暂不足以判断')
        assert.equal(result.items[0].spec,'其他规格')
        for(const list of [result,(await f.call('GET','/merchant/goods/'+f.product.id+'/reviews',undefined,f.merchant.token)).result]){
          const raw=JSON.stringify(list)
          for(const secret of [sku.id,'标准款','加厚款',id,f.buyer.account,'13800000000','验收地址一号']) assert.ok(!raw.includes(secret))
          assert.match(list.items[0].createTime,/^\d{4}-\d{2}-\d{2}$/)
        }
      } else {
        assert.equal(result.summary.product,4)
        assert.equal(result.summary.logistics,2)
        assert.equal(result.summary.service,null)
        assert.equal(result.sizeSummary.conclusion,'多数人说偏大半码')
      }
    }
    await f.publish(await f.confirm(await f.extract()))
    assert.equal((await f.call('GET',page)).result.summary.sampleSufficient,false)
  } finally { await f.ctx.app.close() }
})

test('评价绑定冻结条目与版本，跨规格和新发布不继承，改评还原原快照', async () => {
  const f = await fixture()
  try {
    const first = (await f.publish(await f.confirm(await f.extract()))).result as PromiseSnapshot
    const id = await f.order()
    const order = '/member/order/'+id
    assert.equal((await f.call('POST',order+'/mock-pay',{amountCents:2300})).status,200)
    assert.equal((await f.call('POST','/merchant/orders/'+id+'/ship',{carrier:'顺丰',trackingNo:'SF12345678'},f.merchant.token)).status,200)
    assert.equal((await f.call('PUT',order+'/receipt')).status,200)
    const items=first.entries.filter(e=>e.status==='known').map(e=>({fieldId:e.fieldId,skuId:f.sku.id,result:'matches',note:'情况符合原文'}))
    const input={score:3,logisticsScore:4,content:'总体体验中等，描述准确',items}
    assert.equal((await f.call('PUT',order+'/evaluation',{...input,sizeFit:'true'})).status,400)
    assert.equal((await f.call('PUT',order+'/evaluation',{...input,items:[]})).status,400)
    assert.equal((await f.call('PUT',order+'/evaluation',{...input,items:items.map(i=>({...i,skuId:f.second.id}))})).status,400)
    assert.equal((await f.call('PUT',order+'/evaluation',input)).status,200)
    const page='/goods/'+f.product.id+'/evaluate/page?skuId='
    const publicReview=(await f.call('GET',page+f.sku.id+'&templateVersion='+encodeURIComponent(first.templateVersion))).result
    assert.deepEqual(publicReview.items[0].badges,['已真实收货','对照承诺逐条打分'])
    assert.equal(publicReview.items[0].items[0].quote,first.entries.find(e=>e.status==='known')!.quote)
    assert.equal((await f.call('GET',page+f.second.id)).result.counts,0)
    const next=(await f.publish(await f.confirm(await f.extract()))).result as PromiseSnapshot
    assert.notEqual(next.receiptId,first.receiptId)
    assert.equal((await f.call('GET',page+f.sku.id)).result.counts,0)
    assert.equal((await f.call('PUT',order+'/evaluation',{...input,revision:1,content:'补充使用感受后仍然符合'})).status,200)
    assert.equal((await f.detail(id)).evaluation.history[0].items[0].templateVersion,first.templateVersion)
  } finally { await f.ctx.app.close() }
})

async function fixture(databasePath = ':memory:', uploadsPath = './unused', promiseDriver = createPromiseDriver({ mock: true })) {
  let now = Date.UTC(2026, 10, 18, 8)
  const ctx = await buildTestApp({ databasePath, uploadsPath, publicUrl: 'http://localhost', mockPayments: true,
    clock: { now: () => now }, promiseDriver })
  const buyer = ctx.testData.account({ account: 'buyer', password: 'test-password-123' })
  const merchant = ctx.testData.account({ account: 'seller', password: 'test-password-123', role: 'merchant' })
  const other = ctx.testData.account({ account: 'other', password: 'test-password-123' })
  const delivery = ctx.testData.address({ userId: buyer.id, receiver: '验收人', contact: '13800000000', address: '验收地址一号' })
  const product = ctx.testData.product({ name: '承诺测试商品', category: '箱包', description,
    skus: [{ spec: '标准款', priceCents: 2300, stock: 100 }, { spec: '加厚款', priceCents: 2300, stock: 100 }] })
  const [sku, second] = [product.skus[0]!, product.skus[1]!]
  const base = `/merchant/products/${product.id}/promises`
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, token = buyer.token) => {
    const response = await ctx.app.inject({ method, url, headers: identityHeaders(ctx.accounts, token), payload })
    return { status: response.statusCode, ...response.json() }
  }
  const state = async () => (await call('GET', base, undefined, merchant.token)).result as { published: PromiseSnapshot | null; draft: PromiseDraft | null }
  const extract = async () => {
    const res = await call('POST', base + '/extract', {}, merchant.token)
    assert.equal(res.status, 200, JSON.stringify(res))
    return res.result.draft as PromiseDraft
  }
  const decisions = (draft: PromiseDraft) => draft.entries.filter(entry => entry.status === 'known')
    .map(entry => ({ fieldId: entry.fieldId, decision: entry.fieldId === 'dispatch-window' ? 'reject' : 'accept' }))
  const confirm = async (draft: PromiseDraft, token = merchant.token) => {
    const res = await call('POST', base + '/confirmations', { draftId: draft.id, decisions: decisions(draft) }, token)
    assert.equal(res.status, 200, JSON.stringify(res))
    return res.result.confirmationToken as string
  }
  const publish = (confirmationToken: string, requestKey = randomUUID(), token = merchant.token) =>
    call('POST', base + '/publish', { confirmationToken, requestKey }, token)
  const edit = async (revision: number, description: string) => {
    const res = await call('PUT', `/merchant/products/${product.id}`, { requestKey: randomUUID(), expectedRevision: revision, description }, merchant.token)
    assert.equal(res.status, 200, JSON.stringify(res))
  }
  const order = async (both = false, selected = both ? [sku, second] : [sku]) => {
    const goods = selected.map(value => ({ skuId: value.id, count: 1 }))
    const res = await call('POST', '/member/order', { source: 'buy-now', addressId: delivery.id,
      requestKey: randomUUID(), expectedAmountCents: 2300 * goods.length, goods })
    assert.equal(res.status, 200, JSON.stringify(res))
    return res.result.id as string
  }
  const detail = async (orderId: string) => (await call('GET', `/member/order/${orderId}`)).result
  return { ctx, buyer, merchant, other, product, sku, second, base, call, state, extract, decisions, confirm, publish, edit,
    order, detail, advance: (ms: number) => { now += ms } }
}

for (const [label, category, kind, mixed, accepted] of [
  ['少件', '服饰', 'refund-missing', false, false],
  ['质量', '鞋靴', 'return-quality', false, false],
  ['单独箱包', '箱包', 'return-no-reason', false, false],
  ['服饰与箱包', '服饰', 'return-no-reason', true, false],
  ['服饰', '服饰', 'return-no-reason', false, true],
  ['鞋靴', '鞋靴', 'return-no-reason', false, true],
] as const) {
  test('个人穿着不合适：' + label, async () => {
    const f = await fixture()
    try {
      f.ctx.db.run('UPDATE products SET category=? WHERE id=?', category, f.product.id)
      const selected = [f.sku]
      if (mixed) selected.push(f.ctx.testData.product({ name: '混选包', category: '箱包', skus: [{spec:'大号',priceCents:2300,stock:3}] }).skus[0]!)
      const id = await f.order(false, selected), path = '/member/order/' + id
      assert.equal((await f.call('POST',path+'/mock-pay',{amountCents:2300*selected.length})).status,200)
      assert.equal((await f.call('POST','/merchant/orders/'+id+'/ship',{carrier:'顺丰',trackingNo:'SF12345678'},f.merchant.token)).status,200)
      const detail = await f.detail(id)
      for (const sku of selected) {
        assert.equal(detail.skus.find((line:{id:string})=>line.id===sku.id)?.sizeApplicable, sku.id===f.sku.id && category!=='箱包')
      }
      const response = await f.call('POST',path+'/after-sales',{requestKey:randomUUID(),kind,description:'个人穿着不合适',sizeReason:'personal-fit',
        items:selected.map(sku=>({skuId:sku.id,count:1}))})
      assert.equal(response.status, accepted ? 200 : 400)
      if (!accepted) assert.match(JSON.stringify(response), /七日无理由|服饰|鞋靴/)
      assert.deepEqual(f.ctx.db.all<{size_reason:string}>('SELECT size_reason FROM after_sales').map(row=>row.size_reason), accepted ? ['personal-fit'] : [])
      if (mixed) {
        const onlyApparel = await f.call('POST',path+'/after-sales',{requestKey:randomUUID(),kind,sizeReason:'personal-fit',items:[{skuId:f.sku.id,count:1}]})
        assert.equal(onlyApparel.status,200)
      }
    } finally { await f.ctx.app.close() }
  })
}

test('承诺发布必须逐条选择，凭据绑定当前店主登录，回执可重查且只发布一次', async () => {
  const f = await fixture()
  try {
    const draft = await f.extract()
    assert.equal(draft.entries.filter(entry => entry.status === 'known').length, 2)
    assert.equal((await f.call('POST', f.base + '/confirmations', { draftId: draft.id, decisions: f.decisions(draft).slice(0, 1) }, f.merchant.token)).status, 400)
    const token = await f.confirm(draft)
    const tokenHash = createHash('sha256').update(token).digest('hex')
    assert.ok(f.ctx.db.one('SELECT 1 FROM promise_confirmations WHERE token_hash=?', tokenHash))
    assert.equal(f.ctx.db.one('SELECT 1 FROM promise_confirmations WHERE token_hash=?', token), undefined)
    const requestKey = randomUUID()
    assert.equal((await f.publish(token, requestKey, f.buyer.token)).status, 403)
    assert.equal((await f.publish('f'.repeat(64), requestKey)).reason, 'PROMISE_CONFIRMATION_INVALID')
    const secondSession = (await f.ctx.app.inject({ method: 'POST', url: '/login', payload: { account: 'seller', password: 'test-password-123' } })).json().result.token
    assert.equal((await f.publish(token, requestKey, secondSession)).reason, 'PROMISE_CONFIRMATION_INVALID')
    const otherToken = await f.confirm(draft)
    const published = await Promise.all([f.publish(token, requestKey), f.publish(token, requestKey)])
    assert.equal(published[0]!.status, 200)
    assert.deepEqual(published[0]!.result, published[1]!.result)
    assert.equal((await f.publish(token)).reason, 'PROMISE_CONFIRMATION_INVALID')
    assert.equal((await f.publish(otherToken)).reason, 'PROMISE_DRAFT_STALE')
    const receiptUrl = f.base + '/receipts/' + requestKey
    assert.deepEqual((await f.call('GET', receiptUrl, undefined, secondSession)).result, published[0]!.result)
    assert.equal((await f.call('GET', receiptUrl, undefined, f.buyer.token)).status, 403)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) count FROM promise_publications')!.count, 1)
    const entries = (published[0]!.result as PromiseSnapshot).entries
    assert.equal(entries.find(entry => entry.fieldId === 'return-window')?.value, '7')
    assert.equal(entries.find(entry => entry.fieldId === 'shipping-cost')?.status, 'unknown')
    assert.equal(entries.some(entry => entry.fieldId === 'dispatch-window'), false)
    assert.equal((await f.state()).draft, null)
  } finally { await f.ctx.app.close() }
})

test('凭据到期、身份来回切换和商品改动均要求重新确认', async () => {
  const f = await fixture()
  try {
    const draft = await f.extract()
    const expired = await f.confirm(draft)
    f.advance(5 * 60_000)
    assert.equal((await f.publish(expired)).reason, 'PROMISE_CONFIRMATION_INVALID')
    const wrongIdentity = await f.confirm(draft)
    for (const identity of ['buyer', 'merchant']) {
      assert.equal((await f.call('POST', '/member/identity/switch', { identity }, f.merchant.token)).status, 200)
    }
    assert.equal((await f.publish(wrongIdentity)).reason, 'PROMISE_CONFIRMATION_INVALID')
    const stale = await f.confirm(draft)
    await f.edit(draft.productRevision, '支持14天退换。')
    assert.equal((await f.publish(stale)).reason, 'PROMISE_DRAFT_STALE')
    assert.equal((await f.call('POST', f.base + '/confirmations', { draftId: draft.id, decisions: f.decisions(draft) }, f.merchant.token)).reason, 'PROMISE_DRAFT_STALE')
    assert.equal((await f.state()).draft, null)
    assert.equal((await f.publish(await f.confirm(await f.extract()))).status, 200)
  } finally { await f.ctx.app.close() }
})

test('模型返回前修改商品使本次草稿作废', async () => {
  const mock = createPromiseDriver({ mock: true })!
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const driver: PromiseDriver = { ...mock, extract: async (messages, signal) => { entered(); await gate; return mock.extract(messages, signal) } }
  const f = await fixture(':memory:', './unused', driver)
  try {
    const pending = f.call('POST', f.base + '/extract', {}, f.merchant.token)
    await ready
    const product = (await f.call('GET', `/merchant/products/${f.product.id}`, undefined, f.merchant.token)).result
    await f.edit(product.revision, '支持14天退换。')
    release()
    assert.equal((await pending).reason, 'PROMISE_DRAFT_STALE')
    assert.equal((await f.state()).draft, null)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) count FROM promise_drafts')!.count, 0)
  } finally { release(); await f.ctx.app.close() }
})

test('下单与发布并发时同一订单所有规格冻结同一已发布版本，旧单持续保留原快照', async () => {
  const f = await fixture()
  try {
    const legacy = await f.order()
    const draft = await f.extract()
    const oldSnapshot = (await f.publish(await f.confirm(draft))).result as PromiseSnapshot
    const oldOrder = await f.order()
    await f.edit(draft.productRevision, '支持14天退换。')
    assert.deepEqual((await f.state()).published, oldSnapshot)
    const newToken = await f.confirm(await f.extract())
    const [published, concurrent, otherConcurrent] = await Promise.all([f.publish(newToken), f.order(true), f.order(true)])
    assert.equal(published.status, 200)
    const newer = published.result as PromiseSnapshot
    assert.notEqual(newer.receiptId, oldSnapshot.receiptId)
    for (const orderId of [concurrent, otherConcurrent]) {
      const order = await f.detail(orderId)
      assert.equal(order.skus.length, 2)
      assert.deepEqual(order.skus[0].promiseSnapshot, order.skus[1].promiseSnapshot)
      assert.ok([oldSnapshot.receiptId, newer.receiptId].includes(order.skus[0].promiseSnapshot.receiptId))
    }
    assert.deepEqual((await f.detail(await f.order())).skus[0].promiseSnapshot, newer)
    assert.deepEqual((await f.detail(oldOrder)).skus[0].promiseSnapshot, oldSnapshot)
    assert.equal((await f.detail(legacy)).skus[0].promiseSnapshot, null)
  } finally { await f.ctx.app.close() }
})

test('售后预选规则随字段目录版本冻结到发布回执和订单', async () => {
  const base = createPromiseDriver({ mock: true })!
  const driver: PromiseDriver = { ...base, extract: async () => ({ status: 'completed', tokens: 1,
    content: JSON.stringify({ claims: [{ fieldId: 'bag-lining', source: 'description', quote: '内衬为聚酯纤维。',
      value: '聚酯纤维', unit: null, condition: null }] }) }) }
  const f = await fixture(':memory:', './unused', driver)
  try {
    const current = (await f.call('GET', `/merchant/products/${f.product.id}`, undefined, f.merchant.token)).result
    await f.edit(current.revision, '内衬为聚酯纤维。')
    const draft = await f.extract()
    assert.equal(draft.entries.find(entry => entry.fieldId === 'bag-lining')?.suggestedAfterSaleKind, 'return-quality')
    const result = await f.publish(await f.confirm(draft))
    assert.equal(result.status, 200)
    const receipt = result.result as PromiseSnapshot
    assert.equal(receipt.templateVersion, 'promises-20261120-3')
    const orderId = await f.order()
    const frozen = (await f.detail(orderId)).skus[0]!.promiseSnapshot as PromiseSnapshot
    assert.deepEqual(frozen.entries.find(entry => entry.fieldId === 'bag-lining'),
      receipt.entries.find(entry => entry.fieldId === 'bag-lining'))

    const latest = (await f.call('GET', `/merchant/products/${f.product.id}`, undefined, f.merchant.token)).result
    await f.edit(latest.revision, '内衬为棉布。')
    const historical = (await f.detail(orderId)).skus[0]!.promiseSnapshot as PromiseSnapshot
    assert.deepEqual(historical, frozen)
  } finally { await f.ctx.app.close() }
})

test('仅收货买家可核对，售后保存原文引用并可随备份恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'promise-backup-'))
  const databasePath = join(root, 'data', 'mall.sqlite'), uploadsPath = join(root, 'uploads')
  const f = await fixture(databasePath, uploadsPath)
  try {
    const published = (await f.publish(await f.confirm(await f.extract()))).result as PromiseSnapshot
    const orderId = await f.order(), orderUrl = `/member/order/${orderId}`
    const input = { skuId: f.sku.id, fieldId: 'return-window', result: 'mismatch' }
    assert.equal((await f.call('PUT', orderUrl + '/promise-check', input)).status, 409)
    assert.equal((await f.call('POST', orderUrl + '/mock-pay', { amountCents: 2300 })).status, 200)
    assert.equal((await f.call('POST', `/merchant/orders/${orderId}/ship`, { carrier: '顺丰', trackingNo: 'SF12345678' }, f.merchant.token)).status, 200)
    assert.equal((await f.call('PUT', orderUrl + '/receipt')).status, 200)
    assert.equal((await f.call('PUT', orderUrl + '/promise-check', input, f.merchant.token)).reason, 'BUYER_REQUIRED')
    assert.equal((await f.call('PUT', orderUrl + '/promise-check', input, f.other.token)).status, 403)
    assert.equal((await f.call('PUT', orderUrl + '/promise-check', { ...input, fieldId: 'shipping-cost' })).status, 400)
    const application = { requestKey: randomUUID(), kind: 'return-quality', description: '买家补充原因文字', items: [{ skuId: f.sku.id, count: 1 }],
      promiseMismatch: { skuId: f.sku.id, fieldId: input.fieldId }, imageIds: [] }
    assert.equal((await f.call('POST', orderUrl + '/after-sales', application)).status, 409)
    assert.deepEqual((await f.call('PUT', orderUrl + '/promise-check', input)).result, input)
    assert.equal((await f.call('PUT', orderUrl + '/promise-check', input)).status, 200)
    assert.equal(f.ctx.db.one<{ count: number }>('SELECT COUNT(*) count FROM order_promise_checks')!.count, 1)
    const submitted = await f.call('POST', orderUrl + '/after-sales', application)
    assert.equal(submitted.status, 200, JSON.stringify(submitted))
    const sale = async () => (await f.detail(orderId)).afterSales.find((value: { id: string }) => value.id === submitted.result.afterSaleId)
    const publishedEntry = published.entries.find(entry => entry.fieldId === input.fieldId)!
    const stored = { ...application.promiseMismatch, label: '退换期限', quote: publishedEntry.quote, receiptId: published.receiptId }
    assert.equal(publishedEntry.quote, '支持7天退换')
    assert.deepEqual((await sale()).promiseMismatch, stored)
    assert.equal((await sale()).description, application.description)
    assert.equal((await f.call('PUT', orderUrl + '/promise-check', { ...input, result: 'matches' })).status, 200)
    assert.deepEqual((await sale()).promiseMismatch, stored)

    const backup = await createBackup({ databasePath, uploadsPath, destination: join(root, 'backup') })
    assert.equal(backup.manifest.schemaVersion, 25)
    for (const table of promiseTables) assert.ok(backup.counts[table]! > 0, table)
    const restored = await restoreBackup({ backupPath: backup.root, destination: join(root, 'restored') })
    const restoredDb = new Database(join(restored.root, 'mall.sqlite'))
    try {
      for (const table of promiseTables) assert.deepEqual(restoredDb.all(`SELECT * FROM ${table} ORDER BY rowid`), f.ctx.db.all(`SELECT * FROM ${table} ORDER BY rowid`))
    } finally { restoredDb.close() }

    f.ctx.db.run("UPDATE order_item_promise_snapshots SET snapshot=json_set(snapshot,'$.entries[0].value','99') WHERE order_id=?", orderId)
    await assert.rejects(createBackup({ databasePath, uploadsPath, destination: join(root, 'invalid-backup') }), /承诺快照/)
  } finally { await f.ctx.app.close(); await rm(root, { recursive: true, force: true }) }
})
test('尺码新版不改旧单、两种售后原因单独查询和恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'size-reason-'))
  const databasePath = join(root,'data','mall.sqlite'), uploadsPath = join(root,'uploads')
  const f = await fixture(databasePath,uploadsPath)
  try {
    f.ctx.db.run("UPDATE products SET category='服饰',description=? WHERE id=?", '尺码表：M码 胸围96厘米。版型偏大，建议选小一码。', f.product.id)
    const first = await f.extract()
    const published = (await f.publish(await f.confirm(first))).result as PromiseSnapshot
    const orders = [await f.order(),await f.order()]
    await f.edit(first.productRevision, '版型标准。')
    assert.equal((await f.call('POST',f.base+'/confirmations',{draftId:first.id,decisions:f.decisions(first)},f.merchant.token)).reason,'PROMISE_DRAFT_STALE')
    const next = (await f.publish(await f.confirm(await f.extract()))).result as PromiseSnapshot
    assert.equal(next.entries.find(e=>e.fieldId==='fit')?.fit,'标准')
    for(const [index,id] of orders.entries()) {
      const path='/member/order/'+id
      assert.deepEqual((await f.detail(id)).skus[0].promiseSnapshot,published)
      assert.equal((await f.call('POST',path+'/mock-pay',{amountCents:2300})).status,200)
      assert.equal((await f.call('POST','/merchant/orders/'+id+'/ship',{carrier:'顺丰',trackingNo:'SF12345678'},f.merchant.token)).status,200)
      assert.equal((await f.call('PUT',path+'/receipt')).status,200)
      const ref={skuId:f.sku.id,fieldId:'fit'}
      if(index===0) assert.equal((await f.call('PUT',path+'/promise-check',{...ref,result:'mismatch'})).status,200)
      const application = {requestKey:randomUUID(),kind:'return-no-reason',description:'穿着不合适',items:[{skuId:f.sku.id,count:1}],
        ...(index===0?{promiseMismatch:ref}:{sizeReason:'personal-fit'})}
      if (index===0) {
        const both = await f.call('POST',path+'/after-sales',{...application,sizeReason:'personal-fit'})
        assert.equal(both.status,400)
        assert.match(JSON.stringify(both),/请选择一个退货原因/)
      }
      const result=await f.call('POST',path+'/after-sales',application)
      assert.equal(result.status,200,JSON.stringify(result))
      const reason=index===0?'size-promise-mismatch':'personal-fit'
      const sale=(await f.detail(id)).afterSales[0]
      assert.equal(sale.sizeReason,reason)
      if(index===0) assert.equal(sale.promiseMismatch.quote,'版型偏大，建议选小一码')
      const list=await f.call('GET','/merchant/after-sales?sizeReason='+reason,undefined,f.merchant.token)
      assert.deepEqual(list.result.items.map((item:{orderId:string})=>item.orderId),[id])
    }
    const backup=await createBackup({databasePath,uploadsPath,destination:join(root,'backup')})
    const restored=await restoreBackup({backupPath:backup.root,destination:join(root,'restored')})
    const db=new Database(join(restored.root,'mall.sqlite'))
    try {
      assert.deepEqual(db.all<{size_reason:string}>('SELECT size_reason FROM after_sales ORDER BY rowid').map(row=>row.size_reason),['size-promise-mismatch','personal-fit'])
    } finally { db.close() }
  } finally {await f.ctx.app.close();await rm(root,{recursive:true,force:true})}
})
