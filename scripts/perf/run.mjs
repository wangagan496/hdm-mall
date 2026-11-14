import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir, cpus, totalmem, platform, release } from 'node:os';
import { resolve, join, dirname, sep } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { request, Agent } from 'node:http';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { root, output, taskId, writeJson, stats, trackedState } from './common.mjs';
import { seed } from './fixture.mjs';

const smoke=process.argv.includes('--smoke'), seconds=smoke?2:60;
const optimization=process.argv.includes('--optimize-before')?'before':process.argv.includes('--optimize-after')?'after':null;
const runId=(optimization?'optimize-'+optimization+'-':smoke?'smoke-':'formal-')+new Date().toISOString().replace(/[:.]/g,'-');
const evidence=join(output,runId);mkdirSync(evidence,{recursive:true});
const before=trackedState();
if(optimization){assert.ok(before.head.startsWith('7a92a46'));assert.equal(before.branch,'mall');}
else {assert.equal(before.head,'52b57aa9fde357babf7ebdcc66eb51421bc249ca');assert.equal(before.branch,'');}
writeJson(join(evidence,'baseline.json'),before);
const temp=mkdtempSync(join(tmpdir(),'hdm-e-measure-'));mkdirSync(join(temp,'uploads'));
const temporaryPaths={root:temp,database:join(temp,'mall.sqlite'),uploads:join(temp,'uploads')};
const results={taskId:optimization?'finish-e-optimize-20261114-01':taskId,runId,smoke,optimization,startedAt:new Date().toISOString(),baseCommit:before.head,temporaryPaths,
  environment:{node:process.version,sqlite:process.versions.sqlite,platform:platform(),release:release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),
    pressure:'Shared Windows host; D package and other desktop work may run concurrently; no production or device claim'},
  methodology:{arrival:'open loop, 20 requests/second unless noted; latency includes scheduler lag separately; no automatic retry',
    network:'real HTTP loopback, independent service process, keep-alive; trusted loopback proxy synthesizes 500 client IPs; unchanged rate-limit plugin',
    threshold:'Proposed only: successful normal requests p95 <= 500ms, p99 <= 1000ms, unexpected errors < 1%; awaiting user confirmation',
    timeoutMs:15000,maxInFlight:200},scenarios:[]};
let child,port,fixture,seq=0;let stdout='',stderr='',childExit=null;
const agent=new Agent({keepAlive:true,maxSockets:256,maxFreeSockets:256});
const pending=new Map();
function rpc(action,fields={}){return new Promise((resolve,reject)=>{
  const id=String(++seq),timer=setTimeout(()=>{pending.delete(id);reject(new Error('IPC timeout: '+action));},30000);
  pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject});child.send({action,id,...fields});
});}
function http({method='GET',path,body,user,ip},scheduled=performance.now()) {
  const sent=performance.now(),payload=body?JSON.stringify(body):null;
  return new Promise(resolve=>{
    const req=request({host:'127.0.0.1',port,path,method,agent,headers:{
      'x-forwarded-for':ip??'10.20.0.1',...(user?{authorization:'Bearer '+user.token}:{}),
      ...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{})}},res=>{
      const parts=[];res.on('data',c=>parts.push(c));res.on('end',()=>{
        const text=Buffer.concat(parts).toString('utf8'),parseStart=performance.now();let json;
        try{json=JSON.parse(text);}catch{}
        const end=performance.now();resolve({status:res.statusCode,elapsedMs:end-sent,scheduledMs:end-scheduled,lagMs:sent-scheduled,
          parseMs:end-parseStart,bytes:Buffer.byteLength(text),json});
      });res.on('error',()=>finishError());
    });
    function finishError(){const end=performance.now();resolve({status:0,elapsedMs:end-sent,scheduledMs:end-scheduled,lagMs:sent-scheduled,parseMs:0,bytes:0});}
    const timeout=setTimeout(()=>req.destroy(new Error('request timeout')),15000);
    req.on('close',()=>clearTimeout(timeout));req.on('error',finishError);if(payload)req.write(payload);req.end();
  });
}
function ip(i){return '10.20.'+Math.floor(i/250)+'.'+(i%250+1);}
function spec(kind,i){const u=fixture.buyers[i%500], base={user:u,ip:ip(i%500)};
  if(kind==='login')return {...base,method:'POST',path:'/login',body:{account:u.account,password:fixture.password}};
  if(kind==='search')return {...base,method:'POST',path:'/search/all',body:{keyword:i%3===0?'测量':'',page:i%4+1,pageSize:20,sortField:i%2?'price':'publishTime',sortMethod:'asc'}};
  if(kind==='create')return {...base,method:'POST',path:'/member/order',body:{source:'buy-now',requestKey:randomUUID(),expectedAmountCents:1000,addressId:u.addressId,goods:[{skuId:'hdm-'+(i%199+1)+'-a',count:1}]}};
  if(kind==='orders')return {...base,path:'/member/order?page='+(i%4+1)+'&pageSize=10&orderState=0'};
  if(kind==='merchant')return {user:fixture.merchant,ip:'10.21.0.1',path:'/merchant/orders/page?page='+(i%2?200:1)+'&pageSize=10'};
  if(kind==='family')return {...base,path:'/member/family-orders/page?page=1&pageSize=10&group=all'};
  if(kind==='category')return {...base,path:'/category/summary'};
  throw new Error('Unknown scenario');
}
function valid(kind,r){
  if(r.status!==200||r.json?.code!=='1')return false;
  const x=r.json.result;
  if(kind==='login')return typeof x?.token==='string';
  if(kind==='create')return typeof x?.id==='string';
  if(kind==='search')return Array.isArray(x?.pageData?.items)&&x.pageData.items.length===20;
  if(kind==='category')return Array.isArray(x)&&x.length===10;
  return Array.isArray(x?.items)&&x.items.length>0&&x.items.length<=10;
}
function summarize(name,rows,extra={}) {
  const successes=rows.filter(r=>r.ok),failures=rows.filter(r=>!r.ok),statuses={};for(const r of rows)statuses[r.status]=(statuses[r.status]??0)+1;
  const dispatched=rows.filter(r=>!r.clientShed);
  return {name,requests:rows.length,successes:successes.length,unexpectedErrors:failures.length,errorRate:failures.length/rows.length,
    dispatched:dispatched.length,clientShed:rows.length-dispatched.length,
    statuses,latencyMs:stats(dispatched.map(r=>r.elapsedMs)),successLatencyMs:stats(successes.map(r=>r.elapsedMs)),
    scheduledLatencyMs:stats(dispatched.map(r=>r.scheduledMs)),schedulerLagMs:stats(dispatched.map(r=>r.lagMs)),jsonParseMs:stats(dispatched.map(r=>r.parseMs)),bytes:stats(dispatched.map(r=>r.bytes)),...extra};
}
async function scenario(name,kinds,rps=20,duration=seconds){
  for(let i=0;i<10;i++){const kind=kinds[i%kinds.length],r=await http(spec(kind,i+350));assert.ok(valid(kind,r),'Warmup failed: '+kind+' '+r.status);}
  await rpc('reset');const start=performance.now(),rows=[],requests=[];let inflight=0,maxInFlight=0;
  for(let i=0;i<rps*duration;i++) {
    const scheduled=start+i*1000/rps;await sleep(Math.max(0,scheduled-performance.now()));
    const kind=kinds[i%kinds.length];
    if(inflight>=200){rows.push({kind,status:0,ok:false,elapsedMs:0,scheduledMs:performance.now()-scheduled,lagMs:performance.now()-scheduled,parseMs:0,bytes:0,clientShed:true});continue;}
    inflight++;maxInFlight=Math.max(maxInFlight,inflight);
    requests.push(http(spec(kind,i),scheduled).then(r=>{rows.push({kind,status:r.status,ok:valid(kind,r),elapsedMs:r.elapsedMs,scheduledMs:r.scheduledMs,lagMs:r.lagMs,parseMs:r.parseMs,bytes:r.bytes,reason:r.json?.reason??null});}).finally(()=>inflight--));
  }
  await Promise.all(requests);const elapsedMs=performance.now()-start,server=await rpc('stats');
  const result=summarize(name,rows,{offeredRps:rps,durationSeconds:duration,elapsedMs,completedRps:rows.filter(r=>r.status>0).length/(elapsedMs/1000),maxInFlight,server,
    byKind:Object.fromEntries([...new Set(kinds)].map(k=>[k,summarize(k,rows.filter(r=>r.kind===k))]))});
  writeJson(join(evidence,name+'.json'),{...result,samples:rows});results.scenarios.push(result);writeJson(join(evidence,'result.json'),results);
  console.log(JSON.stringify({event:'scenario',name,n:result.requests,p95:result.latencyMs.p95,p99:result.latencyMs.p99,errors:result.unexpectedErrors}));
}
async function races(){
  const rounds=[],all=[];
  for(let round=0;round<(smoke?2:10);round++){
    await rpc('race-prepare');const prefix='race-'+round+'-'+randomUUID()+'-',start=performance.now();
    const payloads=Array.from({length:40},(_,i)=>({user:fixture.buyers[(round*40+i)%500],ip:ip((round*40+i)%500),method:'POST',path:'/member/order',body:{source:'buy-now',requestKey:prefix+i,expectedAmountCents:1500,addressId:fixture.buyers[(round*40+i)%500].addressId,goods:[{skuId:'hdm-200-b',count:1}]}}));
    const responses=await Promise.all(payloads.map(s=>http(s,start)));
    const success=responses.filter(r=>r.status===200&&r.json?.result?.id),rejected=responses.filter(r=>r.status===409&&/库存/.test(r.json?.msg??''));
    const snapshot=await rpc('race-check',{prefix});
    const pass=success.length===10&&new Set(success.map(r=>r.json.result.id)).size===10&&rejected.length===30&&snapshot.stock===0&&snapshot.orders===10&&snapshot.reservations===10;
    for(const r of responses)all.push({...r,json:undefined,ok:r.status===200||r.status===409&&/库存/.test(r.json?.msg??'')});
    // Replay a successful request and prove it creates neither another order nor another reservation.
    const successIndex=responses.findIndex(r=>r.status===200),replay=await http(payloads[successIndex]);
    const afterReplay=await rpc('race-check',{prefix});
    const replayPass=replay.status===200&&replay.json?.result?.id===responses[successIndex].json.result.id&&afterReplay.orders===10&&afterReplay.reservations===10&&afterReplay.stock===0;
    rounds.push({round,pass,replayPass,successes:success.length,expectedStockRejections:rejected.length,snapshot,afterReplay});
    assert.ok(pass&&replayPass,'Inventory race invariant failed');
  }
  const summary=summarize('inventory-race',all,{rounds,expectedBusinessRejections:rounds.length*30,rawNon2xxRate:all.filter(r=>r.status!==200).length/all.length,
    interpretation:'409 stock shortage is expected; unexpected error rate excludes the validated stock rejections'});
  results.inventory=summary;writeJson(join(evidence,'inventory-race.json'),{...summary,samples:all});console.log(JSON.stringify({event:'inventory',rounds:rounds.length,pass:true}));
}
async function rateGuard(){
  const statuses=[];for(let i=0;i<25;i++){const r=await http({...spec('login',0),ip:'10.99.0.1'});statuses.push(r.status);}
  const global=[];for(let i=0;i<185;i++){const r=await http({path:'/ready',ip:'10.99.0.2'});global.push(r.status);}
  const r={login:{ok:statuses.filter(v=>v===200).length,limited:statuses.filter(v=>v===429).length},global:{ok:global.filter(v=>v===200).length,limited:global.filter(v=>v===429).length}};
  assert.deepEqual(r,{login:{ok:20,limited:5},global:{ok:180,limited:5}});results.rateLimit=r;
}
try {
  console.log(JSON.stringify({event:'seed-start',runId}));fixture=seed(temporaryPaths.database);
  writeJson(join(temp,'fixture.json'),fixture);
  results.dataset={...Object.fromEntries(['counts','states','integrity','foreignKeys','createdAt'].map(k=>[k,fixture[k]])),databaseBytes:statSync(temporaryPaths.database).size};
  assert.equal(fixture.counts.orders,20000);assert.equal(fixture.counts.users,501);assert.equal(fixture.counts.products,200);assert.equal(fixture.foreignKeys.length,0);
  child=fork(join(root,'scripts/perf/service.mjs'),[],{cwd:root,env:{...process.env,HDM_PERF_TEMP:temp},silent:true,windowsHide:true});
  child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
  child.on('exit',(code,signal)=>{childExit={code,signal};});
  const ready=await new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('Service startup timeout')),30000);
    child.on('message',m=>{if(m.type==='ready'){clearTimeout(t);res(m);}else if(m.id&&pending.has(m.id)){pending.get(m.id).resolve(m.data??null);pending.delete(m.id);}});
    child.once('exit',()=>{clearTimeout(t);rej(new Error('Service exited during startup'));});});
  port=ready.port;results.service={...ready,host:'127.0.0.1',logger:true,rateLimitUnmodified:true};assert.notEqual(port,3103);
  writeJson(join(evidence,'active-run.json'),{pid:process.pid,servicePid:child.pid,port,temporaryPaths});
  console.log(JSON.stringify({event:'ready',runId,port,dataset:fixture.counts}));
  if(optimization) {
    await scenario('family',['family'],2);
  } else {
  await rateGuard();
  for(const k of ['login','search','create','orders'])await scenario(k,[k]);
  await scenario('merchant',['merchant'],2);await scenario('family',['family'],2);
  if(!smoke)await scenario('family-peak',['family'],20,30);
  const mix=['login','search','search','create','orders','search','orders','search','create','merchant','login','search','orders','create','search','orders','search','create','search','family'];
  await scenario('mixed',mix);
  await races();
  }
  results.finalDatabase=await rpc('integrity');assert.equal(results.finalDatabase.foreignKeys.length,0);assert.equal(results.finalDatabase.negativeStock,0);
  results.status='measured';
} catch(e) { results.status='failed';results.failure={name:e.name,message:e.message};process.exitCode=1;console.error(e.message); }
finally {
  agent.destroy();
  if(child&&childExit===null){child.send({action:'stop'});await Promise.race([once(child,'exit'),sleep(10000)]);if(childExit===null){child.kill();await Promise.race([once(child,'exit'),sleep(5000)]);}}
  writeFileSync(join(evidence,'server.log'),stdout);writeFileSync(join(evidence,'server-stderr.log'),stderr);
  if(results.status==='measured'){
    try {
      if(optimization){const { analyzeOptimization }=await import('./optimization.mjs');results.analysis=await analyzeOptimization(temp,evidence,optimization);}
      else {const { analyze }=await import('./analyze.mjs');results.analysis=await analyze(temp,evidence,smoke);}
    }
    catch(e){results.status='failed';results.failure={name:e.name,message:e.message};process.exitCode=1;console.error(e.message);}
  }
  let portReleased=port===undefined;
  if(port!==undefined)portReleased=await new Promise(res=>{const s=createServer();s.once('error',()=>res(false));s.listen({host:'127.0.0.1',port,exclusive:true},()=>s.close(()=>res(true)));});
  // Delete only the mkdtemp directory created by this exact process, after checking its resolved boundary.
  const exact=resolve(temp),tempParent=resolve(tmpdir());assert.equal(dirname(exact),tempParent);assert.ok(exact.startsWith(tempParent+sep));assert.ok(exact.split(sep).at(-1).startsWith('hdm-e-measure-'));
  if(childExit!==null||!child)rmSync(exact,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  const after=trackedState(),changed=Object.keys(before.files).filter(p=>before.files[p]!==after.files[p]);
  results.cleanup={temporaryPaths,rootRemoved:!existsSync(temp),databaseRemoved:!existsSync(temporaryPaths.database),uploadsRemoved:!existsSync(temporaryPaths.uploads),serviceExit:childExit,port,portReleased};
  results.integrity={headUnchanged:after.head===before.head,branchUnchanged:after.branch===before.branch,trackedFilesCompared:Object.keys(before.files).length,changedTrackedFiles:changed,status:after.status};
  results.finishedAt=new Date().toISOString();
  if(!results.cleanup.rootRemoved||!portReleased||changed.length||!results.integrity.headUnchanged){results.status='failed';process.exitCode=1;}
  writeJson(join(evidence,'cleanup.json'),results.cleanup);writeJson(join(evidence,'result.json'),results);
  console.log(JSON.stringify({event:'complete',runId,status:results.status,evidence,cleanup:results.cleanup,changedTrackedFiles:changed}));
}
