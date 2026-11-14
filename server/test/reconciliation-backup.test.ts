import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { serviceFixture } from './helpers/service-fixture.ts'
import { removeReconciliationLogisticsSchema } from './helpers/legacy-v17.ts'
import { createBackup,verifyBackup,restoreBackup } from '../src/backup.ts'
import { Database } from '../src/database.ts'

test('D18 渠道账单、对账和物流备份恢复，签收时间与事件不符时拒绝校验',async()=>{
 const f=await serviceFixture(true)
 try{
  const id=(await f.create()).body.result.id
  await f.call('POST',`/member/order/${id}/payments`,{amountCents:1000})
  await f.call('POST',`/merchant/orders/${id}/ship`,{carrier:'顺丰',trackingNo:'SF12345678'},f.merchant.token)
  await f.ctx.logistics.pushMock(id,[{id:'sign',state:'signed',occurredAt:f.ctx.clock.now(),description:'已签收'}])
  await f.call('POST','/merchant/reconciliation/run',{date:'2026-11-11'},f.merchant.token)
  const args={databasePath:join(f.root,'data','mall.sqlite'),uploadsPath:join(f.root,'uploads')}
  const backup=await createBackup({...args,destination:join(f.root,'backup')})
  assert.equal(backup.manifest.schemaVersion,19)
  assert.equal((await verifyBackup(backup.root)).counts.shipments,1)
  assert.equal(backup.counts.mock_channel_bill,1)
  const restored=await restoreBackup({backupPath:backup.root,destination:join(f.root,'restored')})
  const db=new Database(join(restored.root,'mall.sqlite'))
  try{
   assert.match(db.one<{id:string}>('SELECT channel_transaction_id id FROM payments')!.id,/^mock-pay-/)
   assert.equal(db.one<{state:string}>('SELECT state FROM shipments')!.state,'signed')
   assert.equal(db.one<{at:number}>('SELECT signed_at at FROM orders')!.at,f.ctx.clock.now())
  }finally{db.close()}
  f.ctx.db.run('UPDATE orders SET signed_at=signed_at+1 WHERE id=?',id)
  await assert.rejects(createBackup({...args,destination:join(f.root,'bad')}),/签收时间/)
 }finally{await f.close()}
})

test('D18 对账已处理原因必须对应审计，篡改后备份拒绝',async()=>{
 const f=await serviceFixture(true)
 try{
  const id=(await f.create()).body.result.id
  await f.call('POST',`/member/order/${id}/payments`,{amountCents:1000})
  f.ctx.payments.channel!.exportBill=()=>[]
  const report=(await f.call('POST','/merchant/reconciliation/run',{date:'2026-11-11'},f.merchant.token)).body.result
  const diff=report.differences[0]
  let now=f.ctx.clock.now()
  f.ctx.clock.now=()=>now++
  assert.equal((await f.call('POST',`/merchant/reconciliation/differences/${diff.id}/resolve`,{reason:'已检查模拟账单缺失'},f.merchant.token)).status,200)
  const args={databasePath:join(f.root,'data','mall.sqlite'),uploadsPath:join(f.root,'uploads')}
  await createBackup({...args,destination:join(f.root,'valid-resolved')})
  f.ctx.db.run('UPDATE reconciliation_differences SET reason=? WHERE id=?','与审计不同的处理原因',diff.id)
  await assert.rejects(createBackup({...args,destination:join(f.root,'invalid-resolved')}),/对账处理审计/)
 }finally{await f.close()}
})

test('D18 真实v17数据库恢复后迁移018保留历史付款和发货，未知渠道编号不编造',async()=>{
 const f=await serviceFixture(true)
 try{
  const id=(await f.create()).body.result.id;await f.complete(id)
  const path=join(f.root,'data','mall.sqlite');await f.ctx.app.close()
  const legacy=new DatabaseSync(path)
  try{removeReconciliationLogisticsSchema(legacy);legacy.exec('PRAGMA user_version=17')}finally{legacy.close()}
  const backup=await createBackup({databasePath:path,uploadsPath:join(f.root,'uploads'),destination:join(f.root,'legacy')})
  assert.equal(backup.manifest.schemaVersion,17)
  const restored=await restoreBackup({backupPath:backup.root,destination:join(f.root,'restored')})
  for(let attempt=0;attempt<2;attempt++){
   const db=new Database(join(restored.root,'mall.sqlite'))
   try{
    assert.equal(db.one<{user_version:number}>('PRAGMA user_version')!.user_version,19)
    assert.equal(db.one<{state:number}>('SELECT state FROM orders WHERE id=?',id)!.state,4)
    assert.equal(db.one<{id:null}>('SELECT channel_transaction_id id FROM payments')!.id,null)
    assert.equal(db.one<{n:number}>('SELECT COUNT(*) n FROM shipments')!.n,0)
    assert.deepEqual(db.all('PRAGMA foreign_key_check'),[])
   }finally{db.close()}
  }
 }finally{await f.close()}
})
