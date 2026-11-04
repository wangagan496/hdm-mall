import { buildApp } from './app.ts'
import { readConfig } from './config.ts'

const config = readConfig(process.env)
const { app, accounts, db } = await buildApp(config.appOptions)
if (config.merchantAccount) {
  const existing = db.one<{ role: string }>('SELECT role FROM users WHERE account=?', config.merchantAccount)
  if (existing && existing.role !== 'merchant') throw new Error('Merchant account name already belongs to a buyer')
  if (!existing) accounts.register(config.merchantAccount, config.merchantPassword, 'merchant')
}
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, async () => { await app.close(); process.exit(0) })
await app.listen({ host: config.host, port: config.port })
