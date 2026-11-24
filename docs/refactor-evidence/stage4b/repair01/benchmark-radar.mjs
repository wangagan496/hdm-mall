import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { buildTestApp } from '../../../../server/test/helpers/fixtures.ts'
import { identityHeaders } from '../../../../server/test/helpers/identity-headers.ts'
import { Database } from '../../../../server/src/database.ts'
import { runRadar } from '../../../../server/src/price-radar.ts'

const DAY = 86_400_000
const root = mkdtempSync(join(tmpdir(), 'hdm-bench-fair-'))
let now = Date.UTC(2026, 10, 20, 8)
let ctx
let baselineDb

try {
  ctx = await buildTestApp({
    databasePath: join(root, 'mall.sqlite'),
    uploadsPath: join(root, 'uploads'),
    publicUrl: 'http://localhost',
    mockPayments: true,
    clock: { now: () => now }
  })

  const buyer = ctx.testData.account({ account: 'benchbuyer1', password: 'test-password-123' })
  const merchant = ctx.testData.account({ account: 'benchseller1', password: 'test-password-123', role: 'merchant' })
  const product = ctx.testData.product({
    name: 'Bench商品',
    category: '箱包',
    description: '公平同函对照组。',
    skus: [{ spec: '标准', priceCents: 10000, stock: 5000 }]
  })
  const sku = product.skus[0]
  const addrJson = JSON.stringify({ receiver: 'A', contact: '13800000000', address: 'X' })

  const call = async (method, url, payload, token) => {
    const res = await ctx.app.inject({ method, url, headers: identityHeaders(ctx.accounts, token), payload })
    return { status: res.statusCode, ...res.json() }
  }

  const pDraft = await call('POST', '/merchant/settings/protection/draft', {
    requestKey: randomUUID(), windowDays: 7, budgetPerOrderCents: 5000, totalBudgetCents: 100000000, effectiveAtOffset: 86400
  }, merchant.token)
  const pConf = await call('POST', '/merchant/settings/protection/confirm', {
    policyId: pDraft.result.policyId, policyHash: pDraft.result.policyHash
  }, merchant.token)
  await call('POST', '/merchant/settings/protection/publish', {
    token: pConf.result.token, policyId: pDraft.result.policyId, requestKey: randomUUID()
  }, merchant.token)

  const oldPaidAt = now
  now += 30 * DAY
  const loginM = await ctx.app.inject({ method: 'POST', url: '/login', payload: { account: 'benchseller1', password: 'test-password-123' } })
  merchant.token = loginM.json().result.token

  const db = ctx.db
  db.transaction(() => {
    for (let i = 0; i < 2000; i++) {
      const oid = randomUUID()
      db.run(
        `INSERT INTO orders(id,owner_id,state,amount,discount,created,expires,paid_by,paid_at,address,request_key,request_body)
         VALUES(?,?,4,20000,0,?,?,?,?,?,?,?)`,
        oid, buyer.id, oldPaidAt - 10000 + i, oldPaidAt + 900000, buyer.id, oldPaidAt - 10000 + i, addrJson, randomUUID(), '{}'
      )
      db.run(
        `INSERT INTO order_items(order_id,sku_id,product_id,name,spec,picture,price,count,discount_share)
         VALUES(?,?,?,?,?,?,?,?,0)`,
        oid, sku.id, product.id, product.name, sku.spec, '', 10000, 2
      )
    }
    for (let i = 0; i < 50; i++) {
      const oid = randomUUID()
      const paidAt = now - 3600_000 + i * 10
      db.run(
        `INSERT INTO orders(id,owner_id,state,amount,discount,created,expires,paid_by,paid_at,address,request_key,request_body)
         VALUES(?,?,4,20000,0,?,?,?,?,?,?,?)`,
        oid, buyer.id, paidAt, paidAt + 900000, buyer.id, paidAt, addrJson, randomUUID(), '{}'
      )
      db.run(
        `INSERT INTO order_items(order_id,sku_id,product_id,name,spec,picture,price,count,discount_share)
         VALUES(?,?,?,?,?,?,?,?,0)`,
        oid, sku.id, product.id, product.name, sku.spec, '', 10000, 2
      )
    }
  })

  now += 1000
  const prodDetail = await call('GET', `/merchant/products/${product.id}`, undefined, merchant.token)
  await call('PUT', `/merchant/products/${product.id}`, {
    requestKey: randomUUID(), expectedRevision: prodDetail.result.revision, skus: [{ id: sku.id, priceCents: 9500 }]
  }, merchant.token)
  runRadar(db, now)

  now += 1000
  const prodDetail2 = await call('GET', `/merchant/products/${product.id}`, undefined, merchant.token)
  await call('PUT', `/merchant/products/${product.id}`, {
    requestKey: randomUUID(), expectedRevision: prodDetail2.result.revision, skus: [{ id: sku.id, priceCents: 9000 }]
  }, merchant.token)
  db.run('ANALYZE')

  // 对照公平性：克隆完全相同数据到 baseline.sqlite，并关闭 StatementSync 缓存 + 删除 v30 索引 + 每轮清零检查点以同函数 runRadar 执行
  const baseDbPath = join(root, 'mall-baseline.sqlite')
  const snapSrc = new DatabaseSync(join(root, 'mall.sqlite'), { readOnly: true })
  try {
    snapSrc.exec(`VACUUM INTO '${baseDbPath.replace(/\\/g, '/')}'`)
  } finally {
    snapSrc.close()
  }
  baselineDb = new Database(baseDbPath, { now: () => now })
  baselineDb.cacheReady = false
  baselineDb.connection.exec(`
    DROP INDEX IF EXISTS orders_paid_radar;
    DROP INDEX IF EXISTS cd_expiring;
    DROP INDEX IF EXISTS cd_order_active;
    DROP INDEX IF EXISTS cr_order_active;
    DROP INDEX IF EXISTS cr_policy_active;
    DROP INDEX IF EXISTS ppp_effective;
    ANALYZE;
  `)

  // Warmup 两次函数
  runRadar(db, now)
  baselineDb.run('UPDATE compensation_radar_state SET last_scan_at=0 WHERE id=1')
  runRadar(baselineDb, now)

  // Mode B (Optimized): 同一 runRadar，20 次稳态 tick，开启 v30 索引 + StatementSync 512 缓存 + 检查点
  const optStart = performance.now()
  let lastOptSummary
  for (let t = 1; t <= 20; t++) {
    lastOptSummary = runRadar(db, now + t * 5000)
  }
  const optMs = performance.now() - optStart

  // Mode A (Unindexed / Uncached Same-Function Control): 同一 runRadar，关闭 StatementSync 缓存、无 v30 索引、无检查点，20 次 tick
  const baseStart = performance.now()
  let lastBaseSummary
  for (let t = 1; t <= 20; t++) {
    baselineDb.run('UPDATE compensation_radar_state SET last_scan_at=0 WHERE id=1')
    lastBaseSummary = runRadar(baselineDb, now + t * 5000)
  }
  const baseMs = performance.now() - baseStart

  const eqpOrders = db.all(
    'EXPLAIN QUERY PLAN SELECT id,owner_id,amount,paid_at FROM orders WHERE state IN (2,3,4,5) AND paid_at IS NOT NULL AND paid_at >= ? ORDER BY paid_at ASC, id ASC',
    now - 7 * DAY
  ).map(r => r.detail)
  const eqpExpiring = db.all(
    "EXPLAIN QUERY PLAN SELECT id FROM compensation_drafts WHERE status IN ('pending','pending_budget') AND expires_at <= ?",
    now
  ).map(r => r.detail)
  const eqpReceipts = db.all(
    "EXPLAIN QUERY PLAN SELECT COALESCE(SUM(confirmed_cents),0) AS total FROM compensation_receipts WHERE order_id=? AND channel_status<>'failed'",
    'dummy'
  ).map(r => r.detail)

  console.log(JSON.stringify({
    methodology: 'Identical dataset (2,050 paid orders = 2,000 aged + 50 active), identical runRadar() function & output semantics; control disables v30 indexes, last_scan_at checkpoint, and StatementSync cache.',
    runtime: {
      node: process.version,
      sqlite: db.one('SELECT sqlite_version() AS v').v
    },
    totalOrders: 2050,
    expiredOrders: 2000,
    activeOrders: 50,
    ticks: 20,
    sameFunctionControlMs: Number(baseMs.toFixed(2)),
    sameFunctionControlPerTickMs: Number((baseMs / 20).toFixed(2)),
    optimizedMs: Number(optMs.toFixed(2)),
    optimizedPerTickMs: Number((optMs / 20).toFixed(2)),
    fairSpeedup: Number((baseMs / optMs).toFixed(2)),
    lastOptSummary,
    lastBaseSummary,
    eqp: { orders: eqpOrders, expiring: eqpExpiring, receipts: eqpReceipts }
  }, null, 2))
} finally {
  try { baselineDb?.close() } catch {}
  try { await ctx?.app.close() } catch {}
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch {}
}
