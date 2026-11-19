import { systemClock } from '../clock.ts'
import { readConfig } from '../config.ts'
import { Database } from '../database.ts'
import { AppError } from '../errors.ts'
import { PromiseExtractor } from './extract.ts'

function draftProduct(db: Database, productId: string) {
  const product = db.one<{ name: string; description: string; category: string; revision: number }>(
    'SELECT name,description,category,revision FROM products WHERE id=?', productId)
  const merchant = db.one<{ id: string }>(`SELECT u.id FROM users u JOIN user_identities i ON i.user_id=u.id
    WHERE u.status='active' AND i.identity='merchant' AND i.revoked_at IS NULL AND i.granted_at<=? LIMIT 1`, systemClock.now())
  if (!product || !merchant) throw new AppError(422, '找不到商品或可用店主账号')
  const specifications = db.all<{spec: string}>('SELECT spec FROM skus WHERE product_id=? AND enabled=1 ORDER BY id', productId)
    .map(row => row.spec).join('\n')
  return { productId, actorId: merchant.id, ...product, specifications }
}

async function run() {
  const productId = process.argv[2]
  if (!productId) throw new AppError(422, '请提供需要抽取的商品编号')
  const config = readConfig(process.env).appOptions
  const db = new Database(config.databasePath)
  try {
    const extractor = new PromiseExtractor(db, systemClock, config.promiseDriver, config.promiseBudgetTokens, config.promiseTimeoutMs)
    const { entries, ...result } = await extractor.extract(draftProduct(db, productId))
    console.log(JSON.stringify({ ...result, fields: entries.map(({ fieldId, status }) => ({ fieldId, status })) }))
  } finally {
    db.close()
  }
}

try {
  await run()
} catch (error) {
  console.error(error instanceof AppError ? error.message : '无法读取承诺抽取配置或商品资料')
  process.exitCode = 1
}
