import { buildApp } from '../../server/src/app.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { app, accounts } = await buildApp({ databasePath: ':memory:', mockPayments: true,
  publicUrl: 'http://127.0.0.1:3000', uploadsPath: join(tmpdir(), 'hdm-inventory-smoke-uploads') })
// 独立内存夹具的测试账号，不读取开发环境账号或数据库。
accounts.register('stock_smoke', 'Smoke-password-123', 'merchant')
await app.listen({ port: 3102, host: '127.0.0.1' })
console.log('RESULT isolated inventory fixture ready')
