import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const taskId = 'finish-e-measure-20261114-01';
export const output = resolve(root, 'docs/step29-runs');
export const sha = v => createHash('sha256').update(v).digest('hex');
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
export function stats(values) {
  const a = [...values].sort((x,y) => x-y);
  const q = p => a.length ? a[Math.max(0, Math.ceil(a.length*p)-1)] : null;
  return { n: a.length, p50: q(.5), p95: q(.95), p99: q(.99), max: a.at(-1) ?? null,
    mean: a.length ? a.reduce((s,v)=>s+v,0)/a.length : null };
}
export function bench(fn, n=200, warmup=10) {
  for (let i=0;i<warmup;i++) fn(i);
  const samples=[];
  for (let i=0;i<n;i++) { const start=performance.now(); fn(i); samples.push(performance.now()-start); }
  return { milliseconds: stats(samples), samples };
}
export function trackedState() {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding:'utf8', windowsHide:true }).trim();
  const files = git('ls-files','-z').split('\0').filter(Boolean);
  return { head:git('rev-parse','HEAD'), branch:git('branch','--show-current'),
    status:git('status','--short','--branch'), files:Object.fromEntries(files.map(p=>[p,sha(readFileSync(resolve(root,p)))])) };
}
