import { parseArgs } from 'node:util'
import { createBackup, restoreBackup, verifyBackup } from './backup.ts'
import { backupOptionsFromEnvironment, downloadLatestBackup } from './backup-store.ts'
import { BackupScheduler } from './backup-scheduler.ts'
import { systemClock } from './clock.ts'
import { setTimeout as wait } from 'node:timers/promises'

const help = `Usage (run in server):
  npm run backup -- --database <existing.sqlite> --uploads <uploads-dir> --out <new-backup-dir>
  npm run backup:verify -- --from <backup-dir>
  npm run restore -- --from <backup-dir> --out <new-restore-dir> [--allow-inconsistent]
  node src/backup-cli.ts publish --database <existing.sqlite> --uploads <uploads-dir>
  node src/backup-cli.ts download --out <new-download-dir>
Object storage configuration and credentials are read only from environment variables.
Targets must not exist; their parent must exist. No running service is reconfigured.
Restore revokes all sessions. A restore is complete only with restore-report.json.`

function printBackup(result: Awaited<ReturnType<typeof verifyBackup>>) {
  const inconsistent = result.manifest.issues.length > 0
  console.log(JSON.stringify({ status: inconsistent ? 'backup-inconsistent' : 'backup-verified',
    path: result.root, files: result.manifest.files.length, counts: result.counts, issues: result.manifest.issues }))
  if (inconsistent) {
    console.error('快照含不一致数据，请检查 manifest.json 中的 issues')
    process.exitCode = 1
  }
}

try {
  const action = process.argv[2]
  const { values } = parseArgs({ args: process.argv.slice(3), strict: true, allowPositionals: false, options: {
    database: { type: 'string' }, uploads: { type: 'string' }, out: { type: 'string' },
    from: { type: 'string' }, help: { type: 'boolean' }, 'allow-inconsistent': { type: 'boolean' }
  } })
  if (values.help) console.log(help)
  else if (action === 'create' && values.database && values.uploads && values.out && !values.from) {
    const result = await createBackup({ databasePath: values.database, uploadsPath: values.uploads, destination: values.out })
    printBackup(result)
  } else if (action === 'verify' && values.from && !values.out && !values.database && !values.uploads) {
    const result = await verifyBackup(values.from)
    printBackup(result)
  } else if (action === 'restore' && values.from && values.out && !values.database && !values.uploads) {
    const result = await restoreBackup({ backupPath: values.from, destination: values.out, allowInconsistent: values['allow-inconsistent'] })
    console.log(JSON.stringify({ status: 'restored-to-new-directory', path: result.root, ...result.report }))
  } else if (action === 'publish' && values.database && values.uploads && !values.from && !values.out) {
    const options = backupOptionsFromEnvironment(process.env)
    if (!options) throw new Error('Backup store is not configured')
    let failed = false
    const scheduler = new BackupScheduler({ ...options, databasePath: values.database, uploadsPath: values.uploads, clock: systemClock,
      logError: () => { failed = true; console.error('Backup upload attempt failed; no credentials were logged') } })
    try {
      for (const delay of [0, 60_000, 300_000, 1800_000]) {
        if (delay) await wait(delay)
        failed = false
        await scheduler.tick()
        if (!failed) break
      }
      if (failed || scheduler.health().status !== 'ok') throw new Error('Backup upload failed after retries')
      console.log(JSON.stringify({ result: 'backup-published', ...scheduler.health() }))
    } finally { await scheduler.stop() }
  } else if (action === 'download' && values.out && !values.from && !values.database && !values.uploads) {
    const options = backupOptionsFromEnvironment(process.env)
    if (!options) throw new Error('Backup store is not configured')
    printBackup(await downloadLatestBackup(options.store, values.out))
  } else throw new Error(help)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Backup operation failed')
  process.exitCode = 1
}
