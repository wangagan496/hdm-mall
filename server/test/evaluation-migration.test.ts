import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createBackup, restoreBackup } from '../src/backup.ts'
import { Database } from '../src/database.ts'
import { buyerEvaluation } from '../src/evaluations.ts'
import { removeEvaluationSchema } from './helpers/legacy-v20.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

test('023 的旧评价恢复后迁移至025，无冻结条目的订单保留普通评分和原文',async()=>{
  const f=await serviceFixture(true)
  try {
    const id=(await f.create()).body.result.id
    await f.complete(id)
    await f.ctx.app.close()
    const path=join(f.root,'data','mall.sqlite')
    const old=new DatabaseSync(path)
    try{
      removeEvaluationSchema(old)
      old.prepare('INSERT INTO evaluations(order_id,score,content,created) VALUES(?,?,?,?)').run(id,3,'这是一条旧评价',Date.UTC(2026,10,11))
    }finally{old.close()}
    const backup=await createBackup({databasePath:path,uploadsPath:join(f.root,'uploads'),destination:join(f.root,'backup')})
    assert.equal(backup.manifest.schemaVersion,23)
    const restored=await restoreBackup({backupPath:backup.root,destination:join(f.root,'restored')})
    const db=new Database(join(restored.root,'mall.sqlite'))
    try{
      assert.equal(db.one<{user_version:number}>('PRAGMA user_version')!.user_version,25)
      const review=buyerEvaluation(db,id)!
      assert.equal(review.score,3);assert.equal(review.productScore,3);assert.equal(review.content,'这是一条旧评价')
      assert.equal(review.revision,1);assert.deepEqual(review.items,[]);assert.deepEqual(review.history,[])
      assert.deepEqual(review.sizes,[])
    }finally{db.close()}
  }finally{await f.close()}
})
