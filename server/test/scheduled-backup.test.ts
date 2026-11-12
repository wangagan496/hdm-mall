import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildApp } from '../src/app.ts'

test('B4 health公开最近成功备份时间，没有配置备份时明确degraded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-schedule-'))
  const context = await buildApp({ databasePath: join(root, 'data', 'mall.sqlite'), uploadsPath: join(root, 'uploads'), publicUrl: 'http://localhost', mockPayments: true })
  try {
    const health = (await context.app.inject({ url: '/health' })).json().result
    assert.equal(health.lastSuccessfulBackupAt, null)
    assert.equal(health.status, 'degraded')
    assert.equal(health.backupConfigured, false)
  } finally { await context.app.close(); await rm(root, { recursive: true, force: true }) }
})

class TestStore {
  objects = new Map<string, Uint8Array>()
  fail = false
  attempts = 0
  async put(key: string, value: Uint8Array) {
    this.attempts++
    if (this.fail) throw new Error('simulated unavailable object store')
    this.objects.set(key, value)
  }
  async list(prefix = '') { return [...this.objects].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, size: value.byteLength })) }
  async delete(key: string) { this.objects.delete(key) }
}

test('B4 上传失败按1、5、30分钟重试，未到时间不重试，超过2小时health降级', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-retry-'))
  let now = Date.UTC(2026, 10, 11)
  const store = new TestStore()
  const context = await buildApp({ databasePath: join(root, 'data', 'mall.sqlite'), uploadsPath: join(root, 'uploads'), publicUrl: 'http://localhost', mockPayments: true,
    clock: { now: () => now }, backup: { store, stagingPath: join(root, 'staging') } })
  try {
    store.fail = true
    now += 3600_000
    await context.backups!.tick()
    let attempts = store.attempts
    for (const delay of [60_000, 300_000, 1800_000]) {
      now += delay - 1
      await context.backups!.tick()
      assert.equal(store.attempts, attempts)
      now++
      if (delay === 1800_000) store.fail = false
      await context.backups!.tick()
      assert.ok(store.attempts > attempts)
      attempts = store.attempts
    }
    assert.equal((await context.app.inject({ url: '/health' })).json().result.status, 'ok')
    now += 2 * 3600_000 + 1
    assert.equal((await context.app.inject({ url: '/health' })).json().result.status, 'degraded')
    await context.backups!.tick()
    assert.equal((await context.app.inject({ url: '/health' })).json().result.status, 'ok')
    assert.equal([...store.objects.keys()].filter(key => key.startsWith('hourly/') && key.endsWith('/manifest.json')).length, 3)
  } finally { await context.app.close(); await rm(root, { recursive: true, force: true }) }
})

test('B4 启动补备份，每小时和每天两档，清理7天及30天过期对象，重启读取最近成功时间', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-schedule-'))
  let now = Date.UTC(2026, 10, 11)
  const store = new TestStore()
  const options = { databasePath: join(root, 'data', 'mall.sqlite'), uploadsPath: join(root, 'uploads'), publicUrl: 'http://localhost', mockPayments: true,
    clock: { now: () => now }, backup: { store, stagingPath: join(root, 'staging') } }
  let context = await buildApp(options)
  try {
    const manifests = () => [...store.objects.keys()].filter(key => key.endsWith('/manifest.json'))
    assert.equal(manifests().length, 2)
    assert.equal(manifests().filter(key => key.startsWith('hourly/')).length, 1)
    assert.equal(manifests().filter(key => key.startsWith('daily/')).length, 1)
    const first = now
    assert.equal((await context.app.inject({ url: '/health' })).json().result.lastSuccessfulBackupAt, new Date(first).toISOString())
    await context.app.close()
    now += 30 * 60_000
    context = await buildApp(options)
    assert.equal(manifests().length, 2)
    now += 31 * 60_000
    await context.backups!.tick()
    assert.equal(manifests().length, 3)
    now += 31 * 86400_000
    await context.backups!.tick()
    assert.equal(manifests().length, 2)
    assert.equal([...store.objects.keys()].some(key => key.includes(String(first))), false)
    assert.equal((await context.app.inject({ url: '/health' })).json().result.status, 'ok')
  } finally { await context.app.close(); await rm(root, { recursive: true, force: true }) }
})
