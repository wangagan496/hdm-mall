import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { output, stats, writeJson } from './common.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
function measured(phase) {
  const names = readdirSync(output).filter(name => name.startsWith('optimize-' + phase + '-'));
  const rows = names.map(name => ({ name, path: join(output, name), result: read(join(output, name, 'result.json')) })).filter(row => row.result.status === 'measured');
  assert.equal(rows.length, 1, 'Select exactly one successful ' + phase + ' run');
  const run = rows[0], data = read(join(run.path, 'optimization.json')), family = read(join(run.path, 'family.json'));
  assert.equal(family.offeredRps, 2); assert.equal(family.durationSeconds, 60); assert.equal(family.samples.length, 120);
  assert.ok(family.samples.every(row => row.ok));
  const latency = stats(family.samples.map(row => row.elapsedMs));
  assert.equal(latency.p95, family.latencyMs.p95);
  assert.ok(run.result.cleanup.rootRemoved && run.result.cleanup.portReleased && run.result.cleanup.serviceExit.code === 0);
  assert.notEqual(run.result.service.port, 3103);
  assert.deepEqual(run.result.integrity.changedTrackedFiles, []);
  return { ...run, data, family, latency };
}
const before = measured('before'), after = measured('after');
assert.equal(before.data.database.version, 18); assert.equal(after.data.database.version, 19);
assert.deepEqual(before.result.dataset.counts, after.result.dataset.counts);
assert.deepEqual(before.data.family.groupCounts, after.data.family.groupCounts);
assert.equal(before.data.family.countCalls, 5); assert.equal(after.data.family.countCalls, 4);
const categories = before.data.categoryGrowth.map((row, index) => {
  const next = after.data.categoryGrowth[index];
  assert.equal(row.products, next.products); assert.equal(row.summaryHash, next.summaryHash);
  const oldMs = stats(row.summary.samples), newMs = stats(next.summary.samples);
  assert.equal(oldMs.p95, row.summary.milliseconds.p95); assert.equal(newMs.p95, next.summary.milliseconds.p95);
  return { products: row.products, categories: row.categories, samples: row.summary.samples.length, before: oldMs, after: newMs,
    p95ReductionPercent: (1 - newMs.p95 / oldMs.p95) * 100, semanticHashEqual: true, summaryHash: row.summaryHash };
});
const comparison = { taskId: 'finish-e-optimize-20261114-01', baseline: before.result.baseCommit,
  before: before.path, after: after.path, beforeStartedAt: before.result.startedAt, afterFinishedAt: after.result.finishedAt,
  dataset: after.result.dataset.counts, categoryGrowth: categories,
  family: { rps: 2, seconds: 60, requestsPerPhase: 120, before: before.latency, after: after.latency,
    beforeCountQueries: 5, afterCountQueries: 4, unexpectedErrorsBefore: 0, unexpectedErrorsAfter: 0,
    p95ReductionPercent: (1 - after.latency.p95 / before.latency.p95) * 100 },
  cleanupVerified: true, scope: 'One shared-host round per phase; no production, 20-rps family, or native UI latency claim' };
writeJson(join(output, 'optimization-comparison.json'), comparison);
console.log(JSON.stringify(comparison, null, 2));
