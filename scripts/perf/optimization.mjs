import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../../server/src/app.ts';
import { addProducts } from './fixture.mjs';
import { bench, sha, writeJson } from './common.mjs';

// The same fixture and warm measurement method as the original E report,
// restricted to the two authorized optimizations on the merged D baseline.
export async function analyzeOptimization(temp,evidence,phase) {
  const fixture=JSON.parse(readFileSync(join(temp,'fixture.json'),'utf8'));
  const {app,db,orders,catalog}=await buildApp({databasePath:join(temp,'mall.sqlite'),uploadsPath:join(temp,'uploads'),publicUrl:'http://127.0.0.1',mockPayments:false,logger:false});
  const result={phase,scope:'Warm in-process category summaries; real HTTP family requests are in family.json; no native rendering claim',categoryGrowth:[]};
  try {
    const user=db.one('SELECT * FROM users WHERE id=?',fixture.buyers[0].id);
    const original=db.one.bind(db),counts=new Map();
    db.one=(sql,...params)=>{if(sql.startsWith('SELECT COUNT(*) AS count FROM orders o WHERE'))counts.set(sql,(counts.get(sql)??0)+1);return original(sql,...params);};
    try {const page=orders.familyPage(user,1,10,'all');result.family={counts:page.counts,groupCounts:page.groupCounts,countQueries:[...counts].map(([sql,calls])=>({sql,calls})),countCalls:[...counts.values()].reduce((a,b)=>a+b,0)};}
    finally {db.one=original;}
    for(const size of [200,1000,2000]) {
      const sentinel=new Error('rollback category growth');let growth;
      try {db.transaction(()=>{
        if(size>200)addProducts(db,201,size);
        const summary=catalog.categorySummary();
        growth={products:size,categories:db.one('SELECT COUNT(*) n FROM categories').n,summaryHash:sha(JSON.stringify(summary)),payloadBytes:Buffer.byteLength(JSON.stringify(summary)),summary:bench(()=>catalog.categorySummary(),20,2)};
        const all=db.all.bind(db);const plans=[];
        db.all=(sql,...params)=>{if(sql.includes('SELECT c.id,c.name,c.parent_id'))plans.push({sql,plan:all('EXPLAIN QUERY PLAN '+sql,...params)});return all(sql,...params);};
        try{catalog.categorySummary();}finally{db.all=all;}
        growth.plans=plans;throw sentinel;
      });}catch(error){if(error!==sentinel)throw error;}
      result.categoryGrowth.push(growth);
      console.log(JSON.stringify({event:'category-growth',phase,products:size,p95:growth.summary.milliseconds.p95}));
    }
    result.database={version:db.one('PRAGMA user_version').user_version,integrity:db.one('PRAGMA integrity_check'),foreignKeys:db.all('PRAGMA foreign_key_check'),products:db.one('SELECT COUNT(*) n FROM products').n,indexes:db.all("SELECT name,sql FROM sqlite_master WHERE name IN ('skus_product_availability','categories_parent')")};
    assert.equal(result.database.version,phase==='before'?18:19);assert.equal(result.database.products,200);assert.equal(result.database.foreignKeys.length,0);
    assert.equal(result.family.countCalls,phase==='before'?5:4);
    writeJson(join(evidence,'optimization.json'),result);
    return {file:join(evidence,'optimization.json'),phase,categoryGrowth:[200,1000,2000]};
  } finally {await app.close();}
}
