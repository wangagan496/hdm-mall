import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scryptSync, randomBytes } from 'node:crypto';
import { buildApp } from '../../server/src/app.ts';
import { addProducts } from './fixture.mjs';
import { bench, sha, writeJson } from './common.mjs';

export async function analyze(temp,evidence,smoke=false) {
  const fixture=JSON.parse(readFileSync(join(temp,'fixture.json'),'utf8'));
  const {app,db,accounts,orders,catalog}=await buildApp({databasePath:join(temp,'mall.sqlite'),uploadsPath:join(temp,'uploads'),publicUrl:'http://127.0.0.1',mockPayments:false,logger:false});
  const user=db.one('SELECT * FROM users WHERE id=?',fixture.buyers[0].id),merchant=db.one('SELECT * FROM users WHERE id=?',fixture.merchant.id);
  const n=smoke?5:200, result={scope:'In-process warm microbenchmarks, HTTP service stopped; temporary data only; native UI/render/network unmeasured',operations:{},queries:[],indexExperiments:[],categoryGrowth:[]};
  function trace(fn){
    const original={},seen=new Map();
    for(const method of ['one','all','run']) {
      original[method]=db[method];db[method]=function(sql,...params){const key=method+':'+sql;const row=seen.get(key)??{method,sql,params,calls:0};row.calls++;seen.set(key,row);return original[method].call(db,sql,...params);};
    }
    let value;try{value=fn();}finally{for(const k of Object.keys(original))db[k]=original[k];}
    const queries=[...seen.values()].map(q=>({...q,plan:/^\s*SELECT/i.test(q.sql)?db.all('EXPLAIN QUERY PLAN '+q.sql,...q.params):[]}));
    return {queries,totalCalls:queries.reduce((s,q)=>s+q.calls,0),value};
  }
  function operation(name,fn,count=n){const captured=trace(fn),value=captured.value;
    result.operations[name]={...bench(fn,count,smoke?1:10),queryCalls:captured.totalCalls,sql:captured.queries,
      payloadBytes:Buffer.byteLength(JSON.stringify(value)),itemCount:Array.isArray(value)?value.length:value?.items?.length??null};
  }
  function query(name,sql,params){const fn=()=>db.all(sql,...params);const r={name,sql,params,plan:db.all('EXPLAIN QUERY PLAN '+sql,...params),...bench(fn,n,10)};result.queries.push(r);return r;}
  function rollback(action){const sentinel=new Error('Intentional temporary experiment rollback');let value;
    try{db.transaction(()=>{value=action();throw sentinel;});}catch(e){if(e!==sentinel)throw e;}return value;}
  try {
    const salt=randomBytes(16).toString('hex');
    result.password={scryptSync64:bench(()=>scryptSync(fixture.password,salt,64),smoke?5:100,3),
      verifyPassword:bench(()=>assert.equal(accounts.verifyPassword(user.id,fixture.password),true),smoke?5:100,3)};
    operation('buyer-page-1',()=>orders.listPage(user,0,1,10));
    operation('buyer-page-4',()=>orders.listPage(user,0,4,10));
    operation('merchant-page-1',()=>orders.merchantPage(merchant,1,10));
    operation('merchant-page-200',()=>orders.merchantPage(merchant,200,10));
    operation('family-page-with-counts',()=>orders.familyPage(user,1,10,'all'),smoke?3:30);
    operation('category-summary',()=>catalog.categorySummary(),smoke?3:30);
    operation('search-page',()=>catalog.listPage(1,20,'','','price','asc'));
    operation('legacy-product-array',()=>catalog.list(),smoke?3:30);
    operation('legacy-category-array',()=>catalog.categories(),smoke?2:5);
    operation('legacy-merchant-array',()=>orders.merchantList(merchant),smoke?1:3);
    const buyer='SELECT o.* FROM orders o WHERE o.owner_id=? ORDER BY o.created DESC,o.id LIMIT ? OFFSET ?';
    const merchantSql='SELECT o.* FROM orders o WHERE o.state=? ORDER BY o.created ASC,o.id LIMIT ? OFFSET ?';
    query('buyer-first',buyer,[user.id,10,0]);query('buyer-page-4',buyer,[user.id,10,30]);
    query('merchant-first',merchantSql,[2,10,0]);query('merchant-page-200',merchantSql,[2,10,1990]);
    query('order-items','SELECT * FROM order_items WHERE order_id=? ORDER BY rowid',['history-00000']);
    query('payments-by-order','SELECT * FROM payments WHERE order_id=? ORDER BY created,id',['history-00000']);
    query('sku-by-product','SELECT * FROM skus WHERE product_id=?',['hdm-100']);
    query('session-expiry','SELECT COUNT(*) n FROM sessions WHERE expires<?',[Date.now()]);
    query('category-children','SELECT id,name FROM categories WHERE parent_id=?',['perf-category-0']);
    const readable=orders.listFilter(user,0,true);
    query('family-readable-count','SELECT COUNT(*) n FROM orders o WHERE '+readable.where,readable.values);
    const experiments=[
      {name:'merchant-order-index',ddl:'CREATE INDEX perf_orders_state_created_id ON orders(state,created,id)',sql:merchantSql,params:[2,10,1990]},
      {name:'buyer-order-index',ddl:'CREATE INDEX perf_orders_owner_created_id ON orders(owner_id,created DESC,id)',sql:buyer,params:[user.id,10,30]},
      {name:'sku-product-index',ddl:'CREATE INDEX perf_skus_product ON skus(product_id,enabled,stock,price)',sql:'SELECT * FROM skus WHERE product_id=?',params:['hdm-100']},
      {name:'category-parent-index',ddl:'CREATE INDEX perf_categories_parent ON categories(parent_id)',sql:'SELECT id,name FROM categories WHERE parent_id=?',params:['perf-category-0']},
      {name:'session-expiry-index',ddl:'CREATE INDEX perf_sessions_expires ON sessions(expires)',sql:'SELECT COUNT(*) n FROM sessions WHERE expires<?',params:[Date.now()]}
    ];
    for(const x of experiments){const fn=()=>db.all(x.sql,...x.params),baseline=fn(),before={plan:db.all('EXPLAIN QUERY PLAN '+x.sql,...x.params),...bench(fn,n,10)};
      const after=rollback(()=>{db.run(x.ddl);const value=fn();assert.equal(sha(JSON.stringify(value)),sha(JSON.stringify(baseline)));return {plan:db.all('EXPLAIN QUERY PLAN '+x.sql,...x.params),...bench(fn,n,10)};});
      result.indexExperiments.push({...x,before,after,semanticsEqual:true,rolledBack:true});
    }
    const growthSizes=smoke?[200]:[200,1000,2000];
    for(const size of growthSizes){const growth=rollback(()=>{
      if(size>200)addProducts(db,201,size);
      const baseline=catalog.categorySummary(),count=smoke?2:20;
      const before={summary:bench(()=>catalog.categorySummary(),count,2),legacy:bench(()=>catalog.categories(),smoke?1:3,1),payloadBytes:Buffer.byteLength(JSON.stringify(baseline)),categoryRows:db.one('SELECT COUNT(*) n FROM categories').n};
      const captured=trace(()=>catalog.categorySummary());
      db.run('CREATE INDEX perf_skus_product ON skus(product_id,enabled,stock,price)');
      db.run('CREATE INDEX perf_categories_parent ON categories(parent_id)');
      const after=catalog.categorySummary();assert.deepEqual(after,baseline);
      return {products:size,...before,summaryPlanBefore:captured.queries,
        summaryWithCandidateIndexes:bench(()=>catalog.categorySummary(),count,2),summaryPlanAfter:trace(()=>catalog.categorySummary()).queries,semanticsEqual:true};
    });result.categoryGrowth.push(growth);console.log(JSON.stringify({event:'category-growth',products:size,p95:growth.summary.milliseconds.p95}));}
    result.deepPage=rollback(()=>{
      // Sensitivity case only: one synthetic buyer owns 10,000 history orders, not the baseline 40 each.
      db.run("UPDATE orders SET owner_id=? WHERE id>='history-00000' AND id<='history-09999'",user.id);
      const rows=[];for(const offset of [0,990,4990,9990]){
        const params=[user.id,10,offset],fn=()=>db.all(buyer,...params);
        rows.push({offset,plan:db.all('EXPLAIN QUERY PLAN '+buyer,...params),...bench(fn,n,10)});
      }
      db.run('CREATE INDEX perf_orders_owner_created_id ON orders(owner_id,created DESC,id)');
      const anchor=db.one('SELECT created,id FROM orders WHERE owner_id=? ORDER BY created DESC,id LIMIT 1 OFFSET 9989',user.id);
      const keysetSql='SELECT * FROM orders WHERE owner_id=? AND created<=? AND (created<? OR id>?) ORDER BY created DESC,id LIMIT 10';
      const params=[user.id,anchor.created,anchor.created,anchor.id];
      assert.deepEqual(db.all(keysetSql,...params).map(r=>r.id),db.all(buyer,user.id,10,9990).map(r=>r.id));
      return {scope:'temporary skew sensitivity, 10000 history orders assigned to one buyer; rolled back',offsetBaseline:rows,
        indexedOffset:bench(()=>db.all(buyer,user.id,10,9990),n,10),keysetSql,keysetPlan:db.all('EXPLAIN QUERY PLAN '+keysetSql,...params),keyset:bench(()=>db.all(keysetSql,...params),n,10),semanticsEqual:true};
    });
    result.after={version:db.one('PRAGMA user_version').user_version,foreignKeys:db.all('PRAGMA foreign_key_check'),integrity:db.one('PRAGMA integrity_check'),
      experimentIndexes:db.all("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'perf_%'")};
    assert.equal(result.after.experimentIndexes.length,0);assert.equal(result.after.foreignKeys.length,0);assert.equal(result.after.version,17);
    writeJson(join(evidence,'analysis.json'),result);
    return {file:join(evidence,'analysis.json'),operations:Object.keys(result.operations).length,queries:result.queries.length,categoryGrowth:growthSizes,temporaryIndexesRolledBack:true};
  } finally{await app.close();}
}
