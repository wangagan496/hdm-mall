import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync,existsSync,copyFileSync,symlinkSync,unlinkSync,rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { root,output,writeJson } from './common.mjs';

// Run only after measurements, so validation does not add pressure to their timings.
const dir=join(output,'checks');mkdirSync(dir,{recursive:true});
if(existsSync(join(output,'checks.json'))&&!existsSync(join(output,'checks.initial.json')))copyFileSync(join(output,'checks.json'),join(output,'checks.initial.json'));
const checks=[];
function run(name,args,cwd=root){
  const start=Date.now(),r=spawnSync(process.execPath,args,{cwd,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024,timeout:300000});
  const log=join(dir,name+'.log');if(existsSync(log)&&!existsSync(join(dir,name+'.initial.log')))copyFileSync(log,join(dir,name+'.initial.log'));
  writeFileSync(log,(r.stdout??'')+(r.stderr??''));
  const row={name,args,exitCode:r.status,signal:r.signal,durationMs:Date.now()-start,error:r.error?.message??null};checks.push(row);
  console.log(JSON.stringify(row));
  if(r.status!==0)process.exitCode=1;
}
for(const file of readdirSync(join(root,'scripts/perf')).filter(p=>p.endsWith('.mjs')))run('syntax-'+file,['--check',join('scripts/perf',file)]);
run('server-types',['node_modules/typescript/bin/tsc','--noEmit'],join(root,'server'));
const serverFiles=['catalog-pagination.test.ts','order-center-pagination.test.ts','optimization.test.ts','inventory.test.ts','browse-relations.test.ts'].filter(p=>readdirSync(join(root,'server/test')).includes(p));
run('server-related',['--test','--test-reporter=tap','--test-concurrency=1',...serverFiles.map(p=>'test/'+p)],join(root,'server'));
const clientFiles=['browse-relations.test.mjs','family-pagination.test.mjs','order-loading.test.mjs','product-sort.test.mjs'];
const h5Modules=join(root,'shoph5-vue3/node_modules'),tsLink=join(h5Modules,'typescript'),source=join(root,'server/node_modules/typescript');
let madeParent=false,madeLink=false;
const reuse={note:'Both existing lockfiles pin TypeScript 6.0.3; reuse the already restored package through a temporary local junction, without installing H5 packages or editing imports'};
try{
  if(!existsSync(tsLink)){
    const version=JSON.parse(readFileSync(join(source,'package.json'),'utf8')).version;
    if(version!=='6.0.3'||!readFileSync(join(root,'shoph5-vue3/pnpm-lock.yaml'),'utf8').includes('version: 6.0.3'))throw new Error('TypeScript lock versions do not match');
    if(!existsSync(h5Modules)){mkdirSync(h5Modules);madeParent=true;}
    symlinkSync(source,tsLink,'junction');madeLink=true;
  }
  run('client-related',['--test','--test-reporter=tap','--test-concurrency=1',...clientFiles.map(p=>'scripts/tests/'+p)]);
}finally{
  if(madeLink)unlinkSync(tsLink);
  if(madeParent&&readdirSync(h5Modules).length===0)rmdirSync(h5Modules);
  reuse.temporaryJunctionRemoved=madeLink?!existsSync(tsLink):null;reuse.temporaryParentRemoved=madeParent?!existsSync(h5Modules):null;
}
writeJson(join(output,'checks.json'),{scope:'Syntax, service type check and directly related existing regression suites; no device, H5 build or full-repository acceptance claimed',checks,reuse,passed:checks.every(c=>c.exitCode===0),finishedAt:new Date().toISOString()});
