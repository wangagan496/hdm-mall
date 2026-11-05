import { randomBytes } from 'node:crypto'
import { buildApp, type AppOptions } from '../../src/app.ts'

/** 每次创建独立夹具能力；不导出凭证，不使用生产商品种子。 */
export async function buildTestApp(options: AppOptions) {
  const credential = randomBytes(32).toString('hex')
  const context = await buildApp({ ...options, testMode: true, testFixtures: { credential } })
  const fixtures = context.fixtures!
  const testData = {
    account: (input: Parameters<typeof fixtures.createAccount>[1]) => fixtures.createAccount(credential, input),
    address: (input: Parameters<typeof fixtures.createAddress>[1]) => fixtures.createAddress(credential, input),
    product: (input: Parameters<typeof fixtures.createProduct>[1]) => fixtures.createProduct(credential, input),
    relation: (input: Parameters<typeof fixtures.createRelation>[1]) => fixtures.createRelation(credential, input),
  }
  return { ...context, testData }
}
