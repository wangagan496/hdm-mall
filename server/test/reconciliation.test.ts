import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serviceFixture } from './helpers/service-fixture.ts'
import type { BillRow } from '../src/channel-bill.ts'
import { setImmediate } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'

test('D18 商家按北京时间自然日导出账单并对账，买家不能操作', async () => {
  const f = await serviceFixture()
  try {
    const id = (await f.create()).body.result.id
    await f.call('POST', `/member/order/${id}/payments`, { amountCents: 1000 })
    const result = await f.call('POST', '/merchant/reconciliation/run', { date: '2026-11-11' }, f.merchant.token)
    assert.equal(result.status, 200)
    assert.equal(result.body.result.paymentCount, 1)
    assert.equal(result.body.result.paymentAmountCents, 1000)
    assert.equal(result.body.result.differenceCount, 0)
    const bill = await f.call('GET', '/merchant/reconciliation/bill?date=2026-11-11', undefined, f.merchant.token)
    assert.equal(bill.body.result.length, 1)
    assert.match(bill.body.result[0].channelId, /^mock-pay-/)
    assert.equal((await f.call('POST', '/merchant/reconciliation/run', { date: '2026-11-11' })).status, 403)
    assert.equal((await f.call('POST', '/merchant/reconciliation/run', { date: '2026-02-30' }, f.merchant.token)).status, 400)
  } finally { await f.close() }
})

test('D18 北京时间零点分日，自动对前一天且账单失败保留重试', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = await serviceFixture()
  try {
    f.advance(16 * 3600_000 - 1)
    const first = (await f.create()).body.result.id
    await f.call('POST', `/member/order/${first}/payments`, { amountCents: 1000 })
    f.advance(1)
    const second = (await f.create()).body.result.id
    await f.call('POST', `/member/order/${second}/payments`, { amountCents: 1000 })
    const channel = f.ctx.payments.channel!, original = channel.exportBill!.bind(channel)
    assert.equal((await original('2026-11-11')).length,1)
    assert.equal((await original('2026-11-12')).length,1)
    channel.exportBill = () => { throw new Error('simulated bill unavailable') }
    t.mock.timers.tick(30_000); await setImmediate(); await setImmediate()
    const path = '/merchant/reconciliation?date=2026-11-11'
    assert.equal((await f.call('GET',path,undefined,f.merchant.token)).body.result.state,'failed')
    channel.exportBill = original
    f.advance(30_000)
    t.mock.timers.tick(30_000); await setImmediate(); await setImmediate()
    const report = (await f.call('GET',path,undefined,f.merchant.token)).body.result
    assert.equal(report.state,'completed')
    assert.equal(report.paymentCount,1)
    assert.equal(report.differenceCount,0)
    channel.exportBill = () => { throw new Error('completed day must not fetch twice') }
    t.mock.timers.tick(30_000); await setImmediate(); await setImmediate()
    assert.equal((await f.call('GET',path,undefined,f.merchant.token)).body.result.state,'completed')
  } finally { await f.close(); t.mock.timers.reset() }
})

test('D18 四类对账差异落库、重复运行不重复，处理需要商家和5至200字原因并写审计', async () => {
  const f = await serviceFixture()
  try {
    for (let i = 0; i < 3; i++) {
      const id = (await f.create()).body.result.id
      await f.call('POST', `/member/order/${id}/payments`, { amountCents: 1000 })
    }
    const channel = f.ctx.payments.channel!
    const rows = await channel.exportBill!('2026-11-11')
    const injected: BillRow[] = [
      { ...rows[0]!, businessId: 'external-only', channelId: 'external-channel-only' },
      { ...rows[1]!, amountCents: 1200 }, { ...rows[2]!, state: 'pending' }
    ]
    channel.exportBill = () => injected
    const run = () => f.call('POST', '/merchant/reconciliation/run', { date: '2026-11-11' }, f.merchant.token)
    assert.equal((await run()).body.result.differenceCount, 4)
    const path = '/merchant/reconciliation?date=2026-11-11'
    const report = (await f.call('GET', path, undefined, f.merchant.token)).body.result
    assert.deepEqual(report.differences.map((row: { category: string }) => row.category).sort(), ['amount', 'channel-only', 'local-only', 'state'])
    await run()
    assert.deepEqual((await f.call('GET', path, undefined, f.merchant.token)).body.result.differences.map((row: { id: string }) => row.id), report.differences.map((row: { id: string }) => row.id))
    const id = report.differences[0].id, url = `/merchant/reconciliation/differences/${id}/resolve`
    assert.equal((await f.call('POST', url, { reason: '已核实差异原因' })).status, 403)
    assert.equal((await f.call('POST', url, { reason: '短' }, f.merchant.token)).status, 400)
    assert.equal((await f.call('POST', url, { reason: '字'.repeat(201) }, f.merchant.token)).status, 400)
    assert.equal((await f.call('POST', url, { reason: '已联系渠道确认差异' }, f.merchant.token)).status, 200)
    assert.equal((await f.call('POST', url, { reason: '已联系渠道确认差异' }, f.merchant.token)).status, 200)
    const done = (await f.call('GET', path, undefined, f.merchant.token)).body.result
    assert.equal(done.pendingCount, 3)
    assert.equal(done.differences.find((row: { id: string }) => row.id === id).handlerAccount, f.merchant.account)
    const audit = (await f.call('GET', '/merchant/audit-log?action=reconciliation.resolve', undefined, f.merchant.token)).body.result
    assert.equal(audit.counts, 1)
    assert.equal(audit.items[0].summary.reason, '已联系渠道确认差异')
    await run()
    assert.equal((await f.call('GET', path, undefined, f.merchant.token)).body.result.pendingCount, 3)
  } finally { await f.close() }
})

test('D18 跨日退款独立计入退款日，快照变化重新待处理，审计写入失败整体回滚', async () => {
 const f=await serviceFixture()
 try {
  const id=(await f.create()).body.result.id
  await f.call('POST',`/member/order/${id}/payments`,{amountCents:1000})
  f.advance(16*3600_000)
  const request=(await f.call('POST',`/member/order/${id}/cancel-requests`,{requestKey:randomUUID()})).body.result
  await f.call('POST',`/merchant/orders/${id}/cancel-requests/${request.cancelRequestId}/resolve`,{decision:'approve',requestKey:randomUUID()},f.merchant.token)
  const channel=f.ctx.payments.channel!, original=channel.exportBill!.bind(channel)
  const before=await original('2026-11-11'), after=await original('2026-11-12')
  assert.deepEqual(before.map(row=>row.kind),['payment'])
  assert.deepEqual(after.map(row=>row.kind),['refund'])
  const run=()=>f.call('POST','/merchant/reconciliation/run',{date:'2026-11-12'},f.merchant.token)
  assert.equal((await run()).body.result.differenceCount,0)
  channel.exportBill=()=>after.map(row=>({...row,amountCents:900}))
  const diff=(await run()).body.result.differences[0]
  const resolve=()=>f.call('POST',`/merchant/reconciliation/differences/${diff.id}/resolve`,{reason:'核实模拟退款差额'},f.merchant.token)
  f.ctx.db.run("CREATE TRIGGER reject_reconciliation_audit BEFORE INSERT ON audit_log WHEN NEW.action='reconciliation.resolve' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  assert.equal((await resolve()).status,500)
  assert.equal(f.ctx.db.one<{state:string}>('SELECT state FROM reconciliation_differences WHERE id=?',diff.id)!.state,'pending')
  f.ctx.db.run('DROP TRIGGER reject_reconciliation_audit')
  assert.equal((await resolve()).status,200)
  assert.equal((await run()).body.result.pendingCount,0)
  channel.exportBill=()=>after.map(row=>({...row,amountCents:800}))
  const reopened=(await run()).body.result
  assert.equal(reopened.pendingCount,1);assert.equal(reopened.differences[0].id,diff.id)
  assert.equal(reopened.differences[0].reason,null)
  channel.exportBill=original
  assert.equal((await run()).body.result.differenceCount,0)
  assert.equal(f.ctx.db.one<{active:number}>('SELECT active FROM reconciliation_differences WHERE id=?',diff.id)!.active,0)
 } finally {await f.close()}
})
