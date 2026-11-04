// Isolated public-catalog fixture for the emulator smoke check; never reads the developer's database.
import { buildApp } from '../../server/src/app.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { app } = await buildApp({ databasePath: ':memory:', mockPayments: true,
  publicUrl: 'http://127.0.0.1:3000', uploadsPath: join(tmpdir(), 'hdm-optimization-smoke-uploads') })
app.get('/device-fixture', async () => ({ fixture: 'public-catalog', pid: process.pid }))
await app.listen({ port: 3101, host: '127.0.0.1' })
console.log('RESULT isolated public catalog ready')
