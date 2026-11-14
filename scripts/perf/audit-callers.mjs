import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root,output,writeJson,sha } from './common.mjs';

const routes=['/home/category/head','/category/top','/home/new','/home/recommend','/member/relations','/member/family-orders','/merchant/orders'];
const symbols=['getRecommendAPI','getFamilyRelationsAPI','getFamilyRelationsForSessionAPI','getFamilyOrdersAPI','getMerchantOrdersAPI'];
const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',windowsHide:true}).split('\0').filter(p=>/\.(ets|ts|js|mjs|vue|ps1)$/.test(p));
const result={scope:'Tracked source and scripts at 52b57aa; static evidence only; older installed clients and dynamic URLs cannot be disproved',scannedFiles:files.length,routes:{},symbols:{},hashes:{}};
for(const route of routes)result.routes[route]=[];
for(const symbol of symbols)result.symbols[symbol]=[];
for(const file of files){const text=readFileSync(join(root,file),'utf8');result.hashes[file]=sha(text);
  text.split(/\r?\n/).forEach((line,i)=>{
    for(const route of routes)if(["'",'"','`'].some(quote=>line.includes(quote+route+quote)))result.routes[route].push({file,line:i+1,text:line.trim()});
    for(const symbol of symbols)if(new RegExp('\\b'+symbol+'\\b').test(line))result.symbols[symbol].push({file,line:i+1,text:line.trim()});
  });
}
writeJson(join(output,'callers.json'),result);
console.log(JSON.stringify({file:join(output,'callers.json'),scannedFiles:files.length,routeHits:Object.fromEntries(routes.map(r=>[r,result.routes[r].length])),symbolHits:Object.fromEntries(symbols.map(s=>[s,result.symbols[s].length]))}));
