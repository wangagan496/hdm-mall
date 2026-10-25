import { z } from 'zod'
import { buildApp } from './app.ts'

const env = z.object({
  HOST: z.string().default('127.0.0.1'), PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().default('./data/mall.sqlite'), PUBLIC_URL: z.url().default('http://127.0.0.1:3000'),
  MOCK_PAYMENTS: z.enum(['true','false']).default('false'), NODE_ENV: z.enum(['development','test','production']).default('development'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  MERCHANT_ACCOUNT: z.string().default(''), MERCHANT_PASSWORD: z.string().default('')
}).parse(process.env)
const { app, accounts, db } = await buildApp({ databasePath: env.DATABASE_PATH, publicUrl: env.PUBLIC_URL.replace(/\/$/, ''),
  mockPayments: env.MOCK_PAYMENTS === 'true', production: env.NODE_ENV === 'production',
  corsOrigins: env.CORS_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean),
  uploadsPath: './data/uploads', logger: true })
if (env.MERCHANT_ACCOUNT) {
  z.string().regex(/^[a-zA-Z0-9_]{3,32}$/).parse(env.MERCHANT_ACCOUNT)
  z.string().min(12).max(128).parse(env.MERCHANT_PASSWORD)
  const existing = db.one<{ role: string }>('SELECT role FROM users WHERE account=?', env.MERCHANT_ACCOUNT)
  if (existing && existing.role !== 'merchant') throw new Error('Merchant account name already belongs to a buyer')
  if (!existing) accounts.register(env.MERCHANT_ACCOUNT, env.MERCHANT_PASSWORD, 'merchant')
}
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, async () => { await app.close(); process.exit(0) })
await app.listen({ host: env.HOST, port: env.PORT })
