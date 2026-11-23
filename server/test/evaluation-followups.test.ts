import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createBackup, restoreBackup } from '../src/backup.ts'
import { Database } from '../src/database.ts'
import { buyerEvaluation } from '../src/evaluations.ts'
import { removeEvaluationSchema } from './helpers/legacy-v20.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

async function finishAfterSaleRefund(f: Awaited<ReturnType<typeof serviceFixture>>, orderId: string) {
  const req = await f.call('POST', `/member/order/${orderId}/after-sales`, {
    requestKey: randomUUID(),
    kind: 'refund-missing',
    description: '少发配件申请退款',
    items: [{ skuId: f.product.skus[0]!.id, count: 1 }]
  })
  assert.equal(req.status, 200)
  const saleId = req.body.result.afterSaleId as string
  const app = await f.call('POST', `/merchant/after-sales/${saleId}/approve`, { requestKey: randomUUID() }, f.merchant.token)
  assert.equal(app.status, 200)
  return saleId
}

async function finishAfterSaleReject(f: Awaited<ReturnType<typeof serviceFixture>>, orderId: string) {
  const req = await f.call('POST', `/member/order/${orderId}/after-sales`, {
    requestKey: randomUUID(),
    kind: 'refund-missing',
    description: '少发配件申请核实',
    items: [{ skuId: f.product.skus[0]!.id, count: 1 }]
  })
  assert.equal(req.status, 200)
  const saleId = req.body.result.afterSaleId as string
  const rej = await f.call('POST', `/merchant/after-sales/${saleId}/reject`, {
    requestKey: randomUUID(),
    reason: '已核对出库称重与配件齐全'
  }, f.merchant.token)
  assert.equal(rej.status, 200)
  return saleId
}

async function finishAfterSaleClose(f: Awaited<ReturnType<typeof serviceFixture>>, orderId: string) {
  const req = await f.call('POST', `/member/order/${orderId}/after-sales`, {
    requestKey: randomUUID(),
    kind: 'return-no-reason',
    description: '',
    items: [{ skuId: f.product.skus[0]!.id, count: 1 }]
  })
  assert.equal(req.status, 200)
  const saleId = req.body.result.afterSaleId as string
  const app = await f.call('POST', `/merchant/after-sales/${saleId}/approve`, {
    requestKey: randomUUID(),
    returnAddress: { receiver: '仓管', contact: '13900001111', address: '退货仓1号' }
  }, f.merchant.token)
  assert.equal(app.status, 200)
  f.advance(8 * 86400_000)
  await f.ctx.afterSales.processDue()
  f.loginBuyer()
  f.loginMerchant()
  return saleId
}

test('追加处理后感受校验权限、评价前置、售后结束状态、重复提交与字数/违禁/联系方式边界', async t => {
  const f = await serviceFixture()
  t.after(() => f.close())

  // 1) 未评价订单即使售后已退款也拒绝追加
  const noEvalOrder = (await f.create()).body.result.id as string
  await f.complete(noEvalOrder)
  await finishAfterSaleRefund(f, noEvalOrder)
  assert.equal((await f.call('POST', `/member/order/${noEvalOrder}/evaluation/followup`, { content: '售后处理已退款到位' })).status, 409)

  // 2) 已评价但未发起售后 / 售后进行中 / 仅撤回，均拒绝追加
  const activeOrder = (await f.create()).body.result.id as string
  await f.complete(activeOrder)
  assert.equal((await f.call('PUT', `/member/order/${activeOrder}/evaluation`, { score: 3, content: '包装有压痕，等待联系售后' })).status, 200)
  assert.equal((await f.call('GET', `/member/order/${activeOrder}`)).body.result.evaluation.canFollowup, false)
  assert.equal((await f.call('POST', `/member/order/${activeOrder}/evaluation/followup`, { content: '尚未售后尝试追加感受' })).status, 409)

  const pendingSale = await f.call('POST', `/member/order/${activeOrder}/after-sales`, {
    requestKey: randomUUID(),
    kind: 'refund-missing',
    description: '申请少件退款处理',
    items: [{ skuId: f.product.skus[0]!.id, count: 1 }]
  })
  assert.equal(pendingSale.status, 200)
  assert.equal((await f.call('GET', `/member/order/${activeOrder}`)).body.result.evaluation.canFollowup, false)
  assert.equal((await f.call('POST', `/member/order/${activeOrder}/evaluation/followup`, { content: '售后处理中提前追加' })).status, 409)

  // 撤回后仍不算已退款/已关闭/已拒绝
  const withdraw = await f.call('POST', `/member/after-sales/${pendingSale.body.result.afterSaleId}/withdraw`, { requestKey: randomUUID() })
  assert.equal(withdraw.status, 200)
  assert.equal((await f.call('GET', `/member/order/${activeOrder}`)).body.result.evaluation.canFollowup, false)
  assert.equal((await f.call('POST', `/member/order/${activeOrder}/evaluation/followup`, { content: '撤回后尝试追加感受' })).status, 409)

  // 3) 售后已拒绝后开放追加；越权（他人/商家）返回 403；字数/违禁词/联系方式拒绝
  await finishAfterSaleReject(f, activeOrder)
  const readyDetail = (await f.call('GET', `/member/order/${activeOrder}`)).body.result
  assert.equal(readyDetail.evaluation.canFollowup, true)
  assert.equal(readyDetail.evaluation.followup, null)

  assert.equal((await f.call('POST', `/member/order/${activeOrder}/evaluation/followup`, { content: '他人越权追加感受内容' }, f.other.token)).status, 403)
  assert.equal((await f.call('POST', `/member/order/${activeOrder}/evaluation/followup`, { content: '商家越权追加感受内容' }, f.merchant.token)).status, 403)

  for (const bad of ['    ', '四个字啊', '好'.repeat(301), '办理办假证说明', '请联系13812345678处理', '邮箱 test@example.com 联系', '账号 service_buyer 处理']) {
    const res = await f.call('POST', `/member/order/${activeOrder}/evaluation/followup`, { content: bad })
    assert.equal(res.status, 400, `Expected 400 for: ${bad}`)
  }

  // 5字边界与300字边界，及不同结束状态（已拒绝、已退款、已关闭）
  const fiveChars = '处理后满意'
  assert.equal((await f.call('POST', `/member/order/${activeOrder}/evaluation/followup`, { content: `  ${fiveChars}  ` })).status, 200)
  // 重复追加被拒
  assert.equal((await f.call('POST', `/member/order/${activeOrder}/evaluation/followup`, { content: '再次追加一条处理感受' })).status, 409)
  assert.equal((await f.call('GET', `/member/order/${activeOrder}`)).body.result.evaluation.canFollowup, false)

  // 已退款 + 300字边界
  const refundOrder = (await f.create()).body.result.id as string
  await f.complete(refundOrder)
  assert.equal((await f.call('PUT', `/member/order/${refundOrder}/evaluation`, { score: 2, content: '商品有问题，先提交评价' })).status, 200)
  await finishAfterSaleRefund(f, refundOrder)
  f.advance(20 * 86400_000) // 超出15天初始评价期，仍允许追加处理后感受
  f.loginBuyer()
  f.loginMerchant()
  const maxContent = '稳'.repeat(300)
  assert.equal((await f.call('POST', `/member/order/${refundOrder}/evaluation/followup`, { content: maxContent })).status, 200)
  const afterMax = (await f.call('GET', `/member/order/${refundOrder}`)).body.result
  assert.equal(afterMax.evaluation.followup.content, maxContent)
  assert.equal(afterMax.evaluation.canFollowup, false)

  // 已关闭状态
  const closedOrder = (await f.create()).body.result.id as string
  await f.complete(closedOrder)
  assert.equal((await f.call('PUT', `/member/order/${closedOrder}/evaluation`, { score: 4, content: '先评价一下实物再看售后' })).status, 200)
  await finishAfterSaleClose(f, closedOrder)
  assert.equal((await f.call('POST', `/member/order/${closedOrder}/evaluation/followup`, { content: '超时关闭后双方沟通清楚' })).status, 200)
})

test('追加后原评价、逐条结果、复核结论逐字节不变，公开与商家接口脱敏且处理记录返回待接入无伪造', async t => {
  const f = await serviceFixture()
  t.after(() => f.close())
  const prior = process.env.REVIEW_REVIEWER_ACCOUNTS
  t.after(() => { if (prior === undefined) delete process.env.REVIEW_REVIEWER_ACCOUNTS; else process.env.REVIEW_REVIEWER_ACCOUNTS = prior })
  process.env.REVIEW_REVIEWER_ACCOUNTS = f.other.account

  f.ctx.db.run("INSERT INTO product_changes VALUES(?,?,'create',?,'{}','{}',0)", f.merchant.id, 'create', f.product.id)
  const orderId = (await f.create({ titleType: 'individual', title: '张三', email: 'buyer-secret@example.test' })).body.result.id as string
  await f.complete(orderId)

  const originalContent = '实物色差较大，先给出客观评价'
  assert.equal((await f.call('PUT', `/member/order/${orderId}/evaluation`, {
    productScore: 2,
    logisticsScore: 4,
    content: originalContent,
    items: []
  })).status, 200)

  const pageUrl = `/goods/${f.product.id}/evaluate/page?skuId=${f.product.skus[0]!.id}`
  const reviewPublicId = (await f.call('GET', pageUrl)).body.result.items[0].id as string

  // 阶段3C 登记并复核为维持评价
  assert.equal((await f.call('POST', `/merchant/reviews/${reviewPublicId}/dispute`, { reason: '请核对出厂色号说明', images: [] }, f.merchant.token)).status, 200)
  assert.equal((await f.call('POST', `/platform/reviews/${reviewPublicId}/accept`, {}, f.other.token)).status, 200)
  assert.equal((await f.call('POST', `/platform/reviews/${reviewPublicId}/conclude`, { kind: 'maintain', reason: '原评价反映买家真实收货体验' }, f.other.token)).status, 200)

  // 售后退款结束
  await finishAfterSaleRefund(f, orderId)

  // 追加前快照数据库原始行
  const beforeEval = f.ctx.db.one<Record<string, unknown>>('SELECT * FROM evaluations WHERE order_id=?', orderId)!
  const beforeItems = f.ctx.db.all('SELECT * FROM evaluation_items WHERE order_id=? ORDER BY sku_id,field_id', orderId)
  const beforeSizes = f.ctx.db.all('SELECT * FROM evaluation_sizes WHERE order_id=? ORDER BY sku_id', orderId)
  const beforeRevisions = f.ctx.db.all('SELECT * FROM evaluation_revisions WHERE order_id=? ORDER BY revision', orderId)
  const beforeDispute = f.ctx.db.one('SELECT * FROM review_disputes WHERE review_id=?', reviewPublicId)
  const beforeConclusions = f.ctx.db.all('SELECT * FROM review_dispute_conclusions ORDER BY action_id')

  f.advance(60_000)
  f.loginBuyer()
  f.loginMerchant()

  const followupText = '售后退款已完成，处理态度和结果都不错'
  const postRes = await f.call('POST', `/member/order/${orderId}/evaluation/followup`, { content: followupText })
  assert.equal(postRes.status, 200)

  // 追加后原评价字段逐字节不变
  assert.deepEqual(f.ctx.db.one('SELECT * FROM evaluations WHERE order_id=?', orderId), beforeEval)
  assert.deepEqual(f.ctx.db.all('SELECT * FROM evaluation_items WHERE order_id=? ORDER BY sku_id,field_id', orderId), beforeItems)
  assert.deepEqual(f.ctx.db.all('SELECT * FROM evaluation_sizes WHERE order_id=? ORDER BY sku_id', orderId), beforeSizes)
  assert.deepEqual(f.ctx.db.all('SELECT * FROM evaluation_revisions WHERE order_id=? ORDER BY revision', orderId), beforeRevisions)
  assert.deepEqual(f.ctx.db.one('SELECT * FROM review_disputes WHERE review_id=?', reviewPublicId), beforeDispute)
  assert.deepEqual(f.ctx.db.all('SELECT * FROM review_dispute_conclusions ORDER BY action_id'), beforeConclusions)

  // 追加后不可再改评，商家公开回复不能覆盖或删除追加
  assert.equal((await f.call('PUT', `/member/order/${orderId}/evaluation`, { score: 5, content: '试图修改原评价', revision: 1 })).status, 409)
  assert.equal((await f.call('POST', `/merchant/reviews/${reviewPublicId}/reply`, { content: '感谢监督，已改进品控' }, f.merchant.token)).status, 200)
  assert.equal(f.ctx.db.one<{ content: string }>('SELECT content FROM evaluation_followups WHERE order_id=?', orderId)!.content, followupText)

  // 触发器阻止修改或删除 evaluation_followups
  assert.throws(() => f.ctx.db.run('UPDATE evaluation_followups SET content=? WHERE order_id=?', '被篡改的内容', orderId))
  assert.throws(() => f.ctx.db.run('DELETE FROM evaluation_followups WHERE order_id=?', orderId))

  // 无案件时 evaluation_service_records 为空且公开/商家/订单接口返回待接入标记、无伪造记录
  assert.equal(f.ctx.db.one<{ n: number }>('SELECT count(*) n FROM evaluation_service_records')!.n, 0)

  const publicRes = (await f.call('GET', pageUrl)).body.result
  const merchantRes = (await f.call('GET', `/merchant/goods/${f.product.id}/reviews`, undefined, f.merchant.token)).body.result
  const orderDetail = (await f.call('GET', `/member/order/${orderId}`)).body.result

  for (const item of [publicRes.items[0], merchantRes.items[0]]) {
    assert.equal(item.content, originalContent)
    assert.equal(item.score, 2)
    assert.equal(item.followup.content, followupText)
    assert.match(item.followup.createTime, /^\d{4}-\d{2}-\d{2}$/)
    assert.deepEqual(item.serviceRecord, {
      status: 'pending',
      connected: false,
      label: '处理记录待接入',
      records: []
    })
  }
  assert.deepEqual(orderDetail.evaluation.serviceRecord, {
    status: 'pending',
    connected: false,
    label: '处理记录待接入',
    records: []
  })

  // 即使数据库直接存在含联系方式文本，公开和商家接口也必须脱敏
  f.ctx.db.run('DROP TRIGGER evaluation_followup_no_update')
  f.ctx.db.run('UPDATE evaluation_followups SET content=? WHERE order_id=?', '联系 13800000000 或 buyer-secret@example.test 订单 ' + orderId, orderId)
  for (const view of [(await f.call('GET', pageUrl)).body.result, (await f.call('GET', `/merchant/goods/${f.product.id}/reviews`, undefined, f.merchant.token)).body.result]) {
    const serialized = JSON.stringify(view)
    for (const secret of ['13800000000', 'buyer-secret@example.test', orderId, f.buyer.account, f.buyer.id]) {
      assert.ok(!serialized.includes(secret), `Secret leaked: ${secret}`)
    }
  }
})

test('迁移 027 备份恢复与篡改校验，旧版本评价迁移后可读且处理记录待接入', async t => {
  const f = await serviceFixture(true)
  t.after(() => f.close())

  const orderId = (await f.create()).body.result.id as string
  await f.complete(orderId)
  assert.equal((await f.call('PUT', `/member/order/${orderId}/evaluation`, { score: 4, content: '收到商品整体满意' })).status, 200)
  await finishAfterSaleRefund(f, orderId)
  assert.equal((await f.call('POST', `/member/order/${orderId}/evaluation/followup`, { content: '售后已退款，体验满意' })).status, 200)

  const options = { databasePath: join(f.root, 'data', 'mall.sqlite'), uploadsPath: join(f.root, 'uploads') }
  const backup = await createBackup({ ...options, destination: join(f.root, 'backup') })
  assert.equal(backup.manifest.schemaVersion, 28)
  assert.deepEqual(backup.manifest.issues, [])

  const restored = await restoreBackup({ backupPath: backup.root, destination: join(f.root, 'restored') })
  const db = new Database(join(restored.root, 'mall.sqlite'))
  try {
    assert.equal(db.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 28)
    const review = buyerEvaluation(db, orderId)!
    assert.equal(review.content, '收到商品整体满意')
    assert.equal(review.followup?.content, '售后已退款，体验满意')
    assert.deepEqual(review.serviceRecord, { status: 'pending', connected: false, label: '处理记录待接入', records: [] })
  } finally { db.close() }

  // 旧版本 23 恢复迁移至 27 后旧评价可读（含一条无售后的旧评价）
  const legacyOrder = (await f.create()).body.result.id as string
  await f.complete(legacyOrder)
  assert.equal((await f.call('PUT', `/member/order/${legacyOrder}/evaluation`, { score: 3, content: '历史旧评价记录' })).status, 200)
  await f.ctx.app.close()
  const dbPath = join(f.root, 'data', 'mall.sqlite')
  const raw = new DatabaseSync(dbPath)
  try {
    removeEvaluationSchema(raw)
  } finally { raw.close() }
  const legacyBackup = await createBackup({ ...options, destination: join(f.root, 'legacy-backup') })
  assert.equal(legacyBackup.manifest.schemaVersion, 23)
  const legacyRestored = await restoreBackup({ backupPath: legacyBackup.root, destination: join(f.root, 'legacy-restored') })
  const migrated = new Database(join(legacyRestored.root, 'mall.sqlite'))
  try {
    assert.equal(migrated.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 28)
    const review = buyerEvaluation(migrated, legacyOrder)!
    assert.equal(review.content, '历史旧评价记录')
    assert.equal(review.followup, null)
    assert.equal(review.canFollowup, false)
    assert.deepEqual(review.serviceRecord, { status: 'pending', connected: false, label: '处理记录待接入', records: [] })
  } finally { migrated.close() }

  // 篡改 followup（无已结束售后）应被备份校验拒绝
  const reopened = new Database(dbPath)
  reopened.close()
  const broken = new DatabaseSync(dbPath)
  try {
    broken.prepare('INSERT INTO evaluation_followups VALUES(?,?,?,?)').run(legacyOrder, f.buyer.id, '无售后伪造追加内容', Date.now())
  } finally { broken.close() }
  await assert.rejects(createBackup({ ...options, destination: join(f.root, 'broken') }), /追加/)
})

test('运费退款处于 pending 或 failed 时即使售后已 refunded 也拒绝追加，两者都 succeeded 才放行', async t => {
  const f = await serviceFixture()
  t.after(() => f.close())

  const orderId = (await f.create()).body.result.id as string
  await f.complete(orderId)
  assert.equal((await f.call('PUT', `/member/order/${orderId}/evaluation`, { score: 2, content: '商品有瑕疵需要退货' })).status, 200)

  const req = await f.call('POST', `/member/order/${orderId}/after-sales`, {
    requestKey: randomUUID(),
    kind: 'return-quality',
    description: '商品做工存在明显瑕疵',
    items: [{ skuId: f.product.skus[0]!.id, count: 1 }]
  })
  assert.equal(req.status, 200)
  const saleId = req.body.result.afterSaleId as string
  assert.equal((await f.call('POST', `/merchant/after-sales/${saleId}/approve`, {
    requestKey: randomUUID(),
    returnAddress: { receiver: '仓管', contact: '13900001111', address: '退货仓1号' }
  }, f.merchant.token)).status, 200)

  const appKey = randomUUID()
  const waybill = await f.upload('/member/after-sales/images', { orderId, applicationKey: appKey, requestKey: randomUUID() })
  assert.equal(waybill.status, 200)
  assert.equal((await f.call('POST', `/member/after-sales/${saleId}/ship-back`, {
    requestKey: appKey,
    carrier: '顺丰',
    trackingNo: 'SF87654321',
    shippingAmountCents: 1200,
    shippingImageId: waybill.body.result.imageId
  })).status, 200)

  // 让运费退款先模拟超时（保持 pending），货款退款正常成功（售后单进入 refunded）
  const channel = f.ctx.payments.channel!
  const originalShippingRefund = channel.shippingRefund!.bind(channel)
  let shippingMode: 'timeout' | 'fail' | 'success' = 'timeout'
  channel.shippingRefund = (refundId, paymentId, amount) => {
    if (shippingMode === 'timeout') throw new Error('模拟运费退款渠道超时')
    if (shippingMode === 'fail') return 'fail'
    return originalShippingRefund(refundId, paymentId, amount)
  }

  assert.equal((await f.call('POST', `/merchant/after-sales/${saleId}/inspect`, {
    requestKey: randomUUID(),
    items: [{ skuId: f.product.skus[0]!.id, restockCount: 1 }]
  }, f.merchant.token)).status, 200)

  const saleRow = f.ctx.db.one<{ state: string; refund_id: string; shipping_refund_id: string }>('SELECT state, refund_id, shipping_refund_id FROM after_sales WHERE id=?', saleId)!
  assert.equal(saleRow.state, 'refunded')
  assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM refunds WHERE id=?', saleRow.refund_id)!.state, 'succeeded')
  assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM refunds WHERE id=?', saleRow.shipping_refund_id)!.state, 'pending')

  // pending 时不可追加，读写一致
  const pendingOrder = (await f.call('GET', `/member/order/${orderId}`)).body.result
  assert.equal(pendingOrder.evaluation.canFollowup, false)
  const pendingPost = await f.call('POST', `/member/order/${orderId}/evaluation/followup`, { content: '运费还在处理中尝试追加' })
  assert.equal(pendingPost.status, 409)
  assert.match(pendingPost.body.msg, /退款/)

  // 推进时钟触发重试并模拟 failed
  shippingMode = 'fail'
  f.advance(60_000)
  f.loginBuyer()
  f.loginMerchant()
  await f.ctx.payments.reconcile(f.ctx.db.one<{ next_attempt_at: number }>('SELECT next_attempt_at FROM refunds WHERE id=?', saleRow.shipping_refund_id)!.next_attempt_at!)
  assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM refunds WHERE id=?', saleRow.shipping_refund_id)!.state, 'failed')

  const failedOrder = (await f.call('GET', `/member/order/${orderId}`)).body.result
  assert.equal(failedOrder.evaluation.canFollowup, false)
  const failedPost = await f.call('POST', `/member/order/${orderId}/evaluation/followup`, { content: '运费退款失败时尝试追加' })
  assert.equal(failedPost.status, 409)
  assert.match(failedPost.body.msg, /退款/)

  // 运费退款也 succeeded 后才放行追加
  shippingMode = 'success'
  f.advance(5 * 60_000)
  f.loginBuyer()
  f.loginMerchant()
  await f.ctx.payments.reconcile(f.ctx.db.one<{ next_attempt_at: number }>('SELECT next_attempt_at FROM refunds WHERE id=?', saleRow.shipping_refund_id)!.next_attempt_at!)
  assert.equal(f.ctx.db.one<{ state: string }>('SELECT state FROM refunds WHERE id=?', saleRow.shipping_refund_id)!.state, 'succeeded')

  const settledOrder = (await f.call('GET', `/member/order/${orderId}`)).body.result
  assert.equal(settledOrder.evaluation.canFollowup, true)
  assert.equal((await f.call('POST', `/member/order/${orderId}/evaluation/followup`, { content: '货款与运费都已退齐，处理结果满意' })).status, 200)
})

test('阶段6接入前即使预留表存在行，三处接口仍一律返回待接入与空列表', async t => {
  const f = await serviceFixture()
  t.after(() => f.close())

  const orderId = (await f.create()).body.result.id as string
  await f.complete(orderId)
  assert.equal((await f.call('PUT', `/member/order/${orderId}/evaluation`, { score: 3, content: '收到商品先记录评价' })).status, 200)
  const saleId = await finishAfterSaleRefund(f, orderId)

  // 模拟预留表存在残留行
  f.ctx.db.run(
    'INSERT INTO evaluation_service_records(id, order_id, after_sale_id, case_id, source, summary, created) VALUES(?,?,?,?,?,?,?)',
    randomUUID(), orderId, saleId, 'case-residual-1', 'system-case', '残留案件处理记录500分', Date.now()
  )

  const expected = { status: 'pending', connected: false, label: '处理记录待接入', records: [] }
  const buyerOrder = (await f.call('GET', `/member/order/${orderId}`)).body.result
  const publicPage = (await f.call('GET', `/goods/${f.product.id}/evaluate/page?skuId=${f.product.skus[0]!.id}`)).body.result
  const merchantList = (await f.call('GET', `/merchant/goods/${f.product.id}/reviews`, undefined, f.merchant.token)).body.result

  assert.deepEqual(buyerOrder.evaluation.serviceRecord, expected)
  assert.deepEqual(publicPage.items[0].serviceRecord, expected)
  assert.deepEqual(merchantList.items[0].serviceRecord, expected)
  for (const res of [buyerOrder, publicPage, merchantList]) {
    assert.ok(!JSON.stringify(res).includes('残留案件处理记录'))
    assert.ok(!JSON.stringify(res).includes('case-residual-1'))
  }
})

test('旧售后已结束但同时存在新售后进行中时拒绝追加，新售后结束后才恢复可追加', async t => {
  const f = await serviceFixture()
  t.after(() => f.close())

  const orderRes = await f.call('POST', '/member/order', {
    requestKey: randomUUID(),
    addressId: f.address.id,
    goods: [{ skuId: f.product.skus[0]!.id, count: 2 }],
    expectedAmountCents: 2000
  })
  assert.equal(orderRes.status, 200)
  const orderId = orderRes.body.result.id as string
  assert.equal((await f.call('POST', `/member/order/${orderId}/mock-pay`, { amountCents: 2000 })).status, 200)
  assert.equal((await f.call('POST', `/merchant/orders/${orderId}/ship`, { carrier: '顺丰', trackingNo: 'SF22223333' }, f.merchant.token)).status, 200)
  assert.equal((await f.call('PUT', `/member/order/${orderId}/receipt`, {})).status, 200)
  assert.equal((await f.call('PUT', `/member/order/${orderId}/evaluation`, { score: 3, content: '两件商品先收货评价' })).status, 200)

  // 第一件售后退款结束
  await finishAfterSaleRefund(f, orderId)
  // 第二件立刻发起新售后（进行中 pending）
  const second = await f.call('POST', `/member/order/${orderId}/after-sales`, {
    requestKey: randomUUID(),
    kind: 'refund-missing',
    description: '第二件商品少发配件处理',
    items: [{ skuId: f.product.skus[0]!.id, count: 1 }]
  })
  assert.equal(second.status, 200)

  const duringSecond = (await f.call('GET', `/member/order/${orderId}`)).body.result
  assert.equal(duringSecond.evaluation.canFollowup, false)
  assert.equal((await f.call('POST', `/member/order/${orderId}/evaluation/followup`, { content: '新售后还在处理时尝试追加' })).status, 409)

  // 第二件售后拒绝结束后恢复可追加
  assert.equal((await f.call('POST', `/merchant/after-sales/${second.body.result.afterSaleId}/reject`, {
    requestKey: randomUUID(),
    reason: '已核对第二件配件齐全'
  }, f.merchant.token)).status, 200)
  assert.equal((await f.call('GET', `/member/order/${orderId}`)).body.result.evaluation.canFollowup, true)
  assert.equal((await f.call('POST', `/member/order/${orderId}/evaluation/followup`, { content: '全部售后都已处理完毕，体验清楚' })).status, 200)
})
