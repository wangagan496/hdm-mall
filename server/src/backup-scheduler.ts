import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createBackup } from './backup.ts'
import type { BackupStore } from './backup-store.ts'
import type { Clock } from './clock.ts'

export interface BackupOptions { store: BackupStore; stagingPath: string }
const HOUR = 3600_000
const DAY = 24 * HOUR
export function backupKeyInfo(key: string) {
  const match = /^(hourly|daily)\/(\d{13})-[a-f0-9-]{36}\/(.+)$/.exec(key)
  return match ? { tier: match[1] as 'hourly' | 'daily', time: Number(match[2]), path: match[3]! } : null
}

export class BackupScheduler {
  private store: BackupStore
  private stagingPath: string
  private databasePath: string
  private uploadsPath: string
  private clock: Clock
  private logError: (message: string) => void
  private hourly: number | null = null
  private daily: number | null = null
  private lastSuccess: number | null = null
  private initialized = false
  private stopped = false
  private timer?: ReturnType<typeof setInterval>
  private active?: Promise<void>
  private failures = 0
  private retryAt = 0
  private pending?: { path: string; id: string; capturedAt: number; tiers: ('hourly' | 'daily')[]; files: string[] }
  constructor(options: BackupOptions & { databasePath: string; uploadsPath: string; clock: Clock; logError: (message: string) => void }) {
    this.store = options.store; this.stagingPath = resolve(options.stagingPath)
    this.databasePath = options.databasePath; this.uploadsPath = options.uploadsPath
    this.clock = options.clock; this.logError = options.logError
  }
  health() {
    return { backupConfigured: true, lastSuccessfulBackupAt: this.lastSuccess === null ? null : new Date(this.lastSuccess).toISOString(),
      status: this.lastSuccess === null || this.clock.now() - this.lastSuccess > 2 * HOUR ? 'degraded' : 'ok' }
  }
  async start() {
    await this.tick()
    this.timer = setInterval(() => { void this.tick() }, 60_000).unref()
  }
  tick(): Promise<void> {
    if (this.stopped || this.clock.now() < this.retryAt) return Promise.resolve()
    if (this.active) return this.active
    this.active = this.run().then(() => { this.failures = 0; this.retryAt = 0 }).catch(async () => {
      this.failures++
      this.logError('Backup attempt failed (' + this.failures + ')')
      this.retryAt = this.clock.now() + ([60_000, 300_000, 1800_000][this.failures - 1] ?? HOUR)
      if (this.failures >= 4) {
        await this.clearPending().catch(() => { this.logError('Backup staging cleanup failed') })
        this.failures = 0
      }
    }).finally(() => { this.active = undefined })
    return this.active
  }
  private async run() {
    const now = this.clock.now()
    if (!this.initialized) {
      for (const object of await this.store.list()) {
        const info = backupKeyInfo(object.key)
        if (!info || info.path !== 'manifest.json' || info.time > now) continue
        if (info.tier === 'hourly') this.hourly = Math.max(this.hourly ?? 0, info.time)
        else this.daily = Math.max(this.daily ?? 0, info.time)
        this.lastSuccess = Math.max(this.lastSuccess ?? 0, info.time)
      }
      this.initialized = true
    }
    const tiers: ('hourly' | 'daily')[] = []
    if (this.hourly === null || now - this.hourly >= HOUR) tiers.push('hourly')
    if (this.daily === null || Math.floor(now / DAY) > Math.floor(this.daily / DAY)) tiers.push('daily')
    if (!this.pending) {
      if (!tiers.length) return
      await mkdir(this.stagingPath, { recursive: true })
      const id = String(now) + '-' + randomUUID()
      const path = join(this.stagingPath, id)
      if (dirname(path) !== this.stagingPath) throw new Error('Invalid backup staging path')
      try {
        const backup = await createBackup({ databasePath: this.databasePath, uploadsPath: this.uploadsPath, destination: path })
        if (backup.manifest.issues.length) throw new Error('Backup snapshot is inconsistent')
        this.pending = { path, id, capturedAt: now, tiers, files: backup.manifest.files.map(file => file.path) }
      } catch (error) { await rm(path, { recursive: true, force: true }); throw error }
    }
    const pending = this.pending
    while (pending.tiers.length) {
      const tier = pending.tiers[0]!
      const prefix = tier + '/' + pending.id + '/'
      for (const file of pending.files) await this.store.put(prefix + file, await readFile(join(pending.path, file)))
      await this.store.put(prefix + 'manifest.json', await readFile(join(pending.path, 'manifest.json')))
      this[tier] = pending.capturedAt
      this.lastSuccess = this.clock.now()
      pending.tiers.shift()
    }
    await this.prune(now)
    await this.clearPending()
  }
  private async clearPending() {
    if (!this.pending) return
    if (dirname(resolve(this.pending.path)) !== this.stagingPath) throw new Error('Invalid backup cleanup path')
    await rm(this.pending.path, { recursive: true, force: true })
    this.pending = undefined
  }
  private async prune(now: number) {
    const objects = (await this.store.list()).sort((left, right) => Number(right.key.endsWith('/manifest.json')) - Number(left.key.endsWith('/manifest.json')))
    for (const object of objects) {
      const info = backupKeyInfo(object.key)
      if (info && now - info.time > (info.tier === 'hourly' ? 7 : 30) * DAY) await this.store.delete(object.key)
    }
  }
  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    await this.active
    await this.clearPending()
  }
}
