import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConfig } from '../src/config.ts'
import { buildApp } from '../src/app.ts'

const production = { NODE_ENV: 'production', PUBLIC_URL: 'https://mall.example.invalid', CORS_ORIGINS: 'https://shop.example.invalid,null' }

test('开发默认可用，正式配置必须显式 HTTPS 来源并关闭模拟支付', () => {
  assert.equal(readConfig({}).appOptions.publicUrl, 'http://127.0.0.1:3000')
  assert.equal(readConfig(production).appOptions.production, true)
  for (const override of [
    { PUBLIC_URL: 'http://mall.example.invalid' }, { PUBLIC_URL: 'https://localhost' },
    { PUBLIC_URL: 'https://127.1' }, { PUBLIC_URL: 'https://[::1]' },
    { PUBLIC_URL: 'https://[::ffff:127.0.0.1]' }, { PUBLIC_URL: 'https://10.0.2.2' },
    { PUBLIC_URL: 'https://user:password@mall.example.invalid' }, { PUBLIC_URL: 'https://mall.example.invalid/api' },
    { CORS_ORIGINS: '' }, { CORS_ORIGINS: '*' }, { CORS_ORIGINS: 'http://shop.example.invalid' },
    { CORS_ORIGINS: 'https://localhost' }, { CORS_ORIGINS: 'https://shop.example.invalid/' },
    { MOCK_PAYMENTS: 'true' }
  ]) assert.throws(() => readConfig({ ...production, ...override }), Error, JSON.stringify(override))
  assert.throws(() => readConfig({ NODE_ENV: 'production', PUBLIC_URL: production.PUBLIC_URL }), /CORS_ORIGINS/)
})

test('只接受明确代理 IP/CIDR，上传目录与商家配置在启动前校验', () => {
  const config = readConfig({ ...production, TRUSTED_PROXIES: '127.0.0.1, ::1, 10.12.0.0/24', UPLOADS_PATH: './test-assets' })
  assert.deepEqual(config.appOptions.trustedProxies, ['127.0.0.1', '::1', '10.12.0.0/24'])
  assert.equal(config.appOptions.uploadsPath, './test-assets')
  for (const value of ['true', '1', '*', 'loopback', '0.0.0.0/0', '::/0', '10.0.0.1/33', '::1/129', '10.0.0.1/24/2']) {
    assert.throws(() => readConfig({ TRUSTED_PROXIES: value }), /TRUSTED_PROXIES/)
  }
  assert.throws(() => readConfig({ MERCHANT_ACCOUNT: 'merchant', MERCHANT_PASSWORD: 'short' }))
  assert.throws(() => readConfig({ MERCHANT_PASSWORD: 'long-test-password' }))
})

test('直接构建服务也必须校验，错误配置不会创建数据库', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hdm-config-'))
  const databasePath = join(directory, 'invalid.sqlite')
  try {
    await assert.rejects(() => buildApp({ databasePath, uploadsPath: join(directory, 'uploads'),
      publicUrl: 'http://127.0.0.1:3000', production: true, mockPayments: false }), /正式环境/)
    await assert.rejects(access(databasePath))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

async function proxyFixture(trustedProxies: string[]) {
  return buildApp({ databasePath: ':memory:', uploadsPath: './unused',
    publicUrl: production.PUBLIC_URL, production: true, mockPayments: false,
    corsOrigins: ['null'], trustedProxies })
}

test('可信代理下不同真实来源独立限流，伪造链左端不能绕过限制', async () => {
  const { app } = await proxyFixture(['127.0.0.1'])
  const login = (forwarded: string) => app.inject({ method: 'POST', url: '/login', remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-for': forwarded }, payload: {} })
  try {
    for (let i = 0; i < 20; i++) assert.equal((await login(`192.0.2.${i + 1}, 198.51.100.1`)).statusCode, 400)
    assert.equal((await login('192.0.2.99, 198.51.100.1')).statusCode, 429)
    assert.equal((await login('198.51.100.2')).statusCode, 400)
    assert.equal((await app.inject({ url: '/health', headers: { origin: 'null' } })).statusCode, 200)
    assert.equal((await app.inject({ url: '/member/order', headers: { origin: 'null' } })).statusCode, 401)
  } finally { await app.close() }
})

test('未配置代理或直连不可信来源时，伪造转发头不能更换限流身份', async () => {
  for (const trustedProxies of [[], ['127.0.0.1']]) {
    const { app } = await proxyFixture(trustedProxies)
    try {
      for (let i = 0; i < 21; i++) {
        const result = await app.inject({ method: 'POST', url: '/login', remoteAddress: '203.0.113.5',
          headers: { 'x-forwarded-for': `198.51.100.${i + 1}` }, payload: {} })
        assert.equal(result.statusCode, i < 20 ? 400 : 429)
      }
    } finally { await app.close() }
  }
})
