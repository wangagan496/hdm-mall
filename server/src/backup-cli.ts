import { parseArgs } from 'node:util'
import { createBackup, restoreBackup, verifyBackup } from './backup.ts'

const help = `Usage (run in server):
  npm run backup -- --database <existing.sqlite> --uploads <uploads-dir> --out <new-backup-dir>
  npm run backup:verify -- --from <backup-dir>
  npm run restore -- --from <backup-dir> --out <new-restore-dir> [--allow-inconsistent]
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
  } else throw new Error(help)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Backup operation failed')
  process.exitCode = 1
}
