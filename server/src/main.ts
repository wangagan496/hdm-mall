import { buildApp } from './app.ts'
import { readConfig } from './config.ts'
import { backupOptionsFromEnvironment } from './backup-store.ts'

const config = readConfig(process.env)
const { app, accounts, db } = await buildApp({ ...config.appOptions, backup: backupOptionsFromEnvironment(process.env) })
if (config.merchantAccount) {
  const existing = db.one<{ id: string }>('SELECT id FROM users WHERE account=?', config.merchantAccount)
  if (existing && !accounts.identities(existing.id).includes('merchant')) throw new Error('Configured account does not hold the merchant identity')
  if (!existing) accounts.register(config.merchantAccount, config.merchantPassword, 'merchant')
}
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, async () => { await app.close(); process.exit(0) })
await app.listen({ host: config.host, port: config.port })
