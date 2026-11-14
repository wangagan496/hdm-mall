import assert from 'node:assert/strict';
import { readFileSync,existsSync,readdirSync,statSync } from 'node:fs';
import { join,relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { root,output,taskId,writeJson,trackedState,sha,stats } from './common.mjs';

const formal=readdirSync(output).filter(p=>p.startsWith('formal-')).sort().at(-1);
const dir=join(output,formal),r=JSON.parse(readFileSync(join(dir,'result.json'),'utf8'));
const baseline=JSON.parse(readFileSync(join(dir,'baseline.json'),'utf8')),state=trackedState();
const derived=JSON.parse(readFileSync(join(dir,'derived-summary.json'),'utf8'));
const analysis=JSON.parse(readFileSync(join(dir,'analysis.json'),'utf8'));
const checks=JSON.parse(readFileSync(join(output,'checks.json'),'utf8'));
assert.equal(r.status,'measured');assert.equal(checks.passed,true);
assert.equal(state.head,baseline.head);assert.equal(state.branch,'');
const changed=Object.keys(baseline.files).filter(p=>state.files[p]!==baseline.files[p]);assert.deepEqual(changed,[]);
const others=execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8',windowsHide:true}).split('\0').filter(Boolean);
assert.ok(others.every(p=>p.startsWith('scripts/perf/')||p.startsWith('docs/step29-runs/')||p==='docs/性能与规模评估.md'));
const validations=[];
for(const s of r.scenarios){
  const raw=JSON.parse(readFileSync(join(dir,s.name+'.json'),'utf8')).samples,summary=derived.scenarios.find(x=>x.name===s.name);
  assert.equal(raw.length,s.requests);assert.equal(raw.filter(x=>!x.ok).length,s.unexpectedErrors);
  assert.deepEqual(stats(raw.filter(x=>!x.clientShed).map(x=>x.elapsedMs)),summary.latencyMs);
  assert.equal(summary.dispatched+summary.clientShed,summary.requests);
  validations.push({name:s.name,planned:raw.length,dispatched:summary.dispatched,successes:s.successes,unexpectedErrors:s.unexpectedErrors,clientShed:summary.clientShed,
    transportFailures:summary.transportFailures,p95:summary.latencyMs.p95,p99:summary.latencyMs.p99,
    provisionalSloPass:summary.successLatencyMs.p95<=500&&summary.successLatencyMs.p99<=1000&&summary.errorRate<.01});
}
assert.equal(r.inventory.rounds.length,10);assert.ok(r.inventory.rounds.every(x=>x.pass&&x.replayPass&&x.successes===10&&x.expectedStockRejections===30));
assert.equal(r.finalDatabase.negativeStock,0);assert.deepEqual(r.finalDatabase.foreignKeys,[]);
assert.equal(Object.values(r.finalDatabase.integrity)[0],'ok');
assert.equal(analysis.after.version,17);assert.deepEqual(analysis.after.experimentIndexes,[]);assert.deepEqual(analysis.after.foreignKeys,[]);
const runCleanups=[];
for(const name of readdirSync(output).filter(p=>/^(smoke|formal)-/.test(p))){
  const cleanup=JSON.parse(readFileSync(join(output,name,'cleanup.json'),'utf8'));
  assert.equal(cleanup.rootRemoved,true);assert.equal(cleanup.portReleased,true);assert.equal(cleanup.serviceExit.code,0);
  assert.ok(!existsSync(cleanup.temporaryPaths.root));assert.ok(!existsSync(cleanup.temporaryPaths.uploads));
  const freeNow=await new Promise(res=>{const s=createServer();s.once('error',()=>res(false));s.listen({host:'127.0.0.1',port:cleanup.port,exclusive:true},()=>s.close(()=>res(true)));});
  assert.equal(freeNow,true,'Previously used measurement port is not free now');
  runCleanups.push({run:name,...cleanup,recheckedPortFree:freeNow});
}
const reportPath=join(root,'docs/性能与规模评估.md'),report=readFileSync(reportPath,'utf8');
assert.ok(report.includes('待用户确认'));assert.ok(report.includes('共 '+r.scenarios.find(x=>x.name==='family-peak').unexpectedErrors+' 次未成功'));
assert.ok(!report.includes('**'));assert.ok(report.includes('未测 ArkUI'));
const artifacts=[];
function walk(path){for(const name of readdirSync(path)){const p=join(path,name);if(statSync(p).isDirectory())walk(p);else if(!['final-verification.json','delivery-receipt.json'].includes(name))artifacts.push({path:p,bytes:statSync(p).size,sha256:sha(readFileSync(p))});}}
walk(join(root,'scripts/perf'));walk(output);artifacts.push({path:reportPath,bytes:statSync(reportPath).size,sha256:sha(readFileSync(reportPath))});
const tests=checks.checks.filter(x=>x.name.endsWith('-related')).map(x=>{const log=readFileSync(join(output,'checks',x.name+'.log'),'utf8');return {name:x.name,tests:Number(log.match(/# tests (\d+)/)?.[1]),passed:Number(log.match(/# pass (\d+)/)?.[1]),failed:Number(log.match(/# fail (\d+)/)?.[1]),skipped:Number(log.match(/# skipped (\d+)/)?.[1])};});
assert.ok(tests.every(x=>x.tests>0&&x.passed===x.tests&&x.failed===0&&x.skipped===0));
const proof={taskId,status:'completed',final:true,sealedAt:new Date().toISOString(),scope:'Measurement and assessment complete; one stress scenario misses provisional SLO; no optimization deployment claimed',
  formalRun:formal,baseCommit:state.head,detachedHead:state.branch==='',trackedFilesCompared:Object.keys(baseline.files).length,changedTrackedFiles:changed,allowedNewFiles:others,
  boundary:{worktree:root,originalWorktreeTouched:false,devicesUsed:false,newDependenciesDeclared:false,lockedDependenciesRestoredOffline:true,businessCodeChanged:false,migrationsChanged:false,gitWriteCommandsExecuted:false},
  measurements:validations,inventory:{rounds:10,requests:400,successes:100,expectedStockRejections:300,replays:10,allInvariantsPass:true},
  database:{integrity:r.finalDatabase.integrity,foreignKeyViolations:0,version:17,temporaryIndexesRolledBack:true},
  checks:{passed:checks.passed,syntaxFiles:checks.checks.filter(x=>x.name.startsWith('syntax-')).length,typeCheck:checks.checks.find(x=>x.name==='server-types').exitCode===0,tests},
  cleanup:runCleanups,artifacts,delivery:{receiptPath:join(output,'delivery-receipt.json'),note:'Execution proof sealed before the single native bridge send; receipt generated afterward. Submitted transport is not proof of model receipt.'}};
writeJson(join(output,'final-verification.json'),proof);
console.log(JSON.stringify({path:join(output,'final-verification.json'),bytes:statSync(join(output,'final-verification.json')).size,firstLines:readFileSync(join(output,'final-verification.json'),'utf8').split('\n').slice(0,3),final:true,trackedFilesCompared:proof.trackedFilesCompared,changed:changed.length,tests,artifactCount:artifacts.length,ports:runCleanups.map(x=>({port:x.port,free:x.recheckedPortFree}))}));
