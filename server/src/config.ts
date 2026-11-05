import { isIP } from 'node:net'
import { z } from 'zod'

export interface RuntimeOptions {
  publicUrl: string
  mockPayments: boolean
  testMode?: boolean
  testFixtures?: { credential: string }
  production?: boolean
  corsOrigins?: string[]
  trustedProxies?: string[]
}

function originUrl(value: string, field: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${field} 必须是有效的 HTTP(S) 来源地址`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${field} 必须只包含协议、主机和端口，不能包含凭据、路径或参数`)
  }
  return url
}

function localHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '[::]' ||
    /^127\./.test(host) || /^0\./.test(host) || host === '10.0.2.2' ||
    /^\[::ffff:(?:127\.|7f[0-9a-f]{2}:|0:0\])/.test(host)
}

export function validateRuntimeOptions(options: RuntimeOptions): void {
  if (options.testFixtures) {
    if (options.production) throw new Error('正式环境禁止启用测试夹具')
    if (!options.testMode) throw new Error('测试夹具必须显式开启测试模式')
    if (typeof options.testFixtures.credential !== 'string' || options.testFixtures.credential.length < 32) {
      throw new Error('测试凭证至少需要 32 个字符')
    }
  }
  const publicUrl = originUrl(options.publicUrl, 'PUBLIC_URL')
  if (options.production && options.mockPayments) throw new Error('正式环境禁止启用模拟支付')
  if (options.production && (publicUrl.protocol !== 'https:' || localHostname(publicUrl.hostname))) {
    throw new Error('正式环境 PUBLIC_URL 必须使用非本机、非模拟器的 HTTPS 地址')
  }
  if (options.production && !options.corsOrigins?.length) throw new Error('正式环境必须显式设置 CORS_ORIGINS')
  for (const origin of options.corsOrigins ?? []) {
    if (origin === 'null') continue // rawfile 必须显式放行，原有警告和 Bearer 鉴权保持。
    const url = originUrl(origin, 'CORS_ORIGINS')
    if (origin !== url.origin) throw new Error('CORS_ORIGINS 必须使用标准来源格式，不带末尾斜线')
    if (options.production && (url.protocol !== 'https:' || localHostname(url.hostname))) {
      throw new Error('正式环境 CORS_ORIGINS 只能显式放行 HTTPS 来源或 null')
    }
  }
  for (const proxy of options.trustedProxies ?? []) {
    const parts = proxy.split('/')
    const version = isIP(parts[0] ?? '')
    const bits = parts[1]
    if (!version || parts.length > 2 || (bits !== undefined &&
      (!/^\d+$/.test(bits) || Number(bits) < 1 || Number(bits) > (version === 4 ? 32 : 128)))) {
      throw new Error('TRUSTED_PROXIES 只接受明确的 IP 或 CIDR，不接受全信任、跳数或 /0')
    }
  }
}

export function readConfig(source: Record<string, string | undefined>) {
  const env = z.object({
    HOST: z.string().min(1).default('127.0.0.1'), PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_PATH: z.string().min(1).default('./data/mall.sqlite'), UPLOADS_PATH: z.string().min(1).default('./data/uploads'),
    PUBLIC_URL: z.string().default('http://127.0.0.1:3000'),
    MOCK_PAYMENTS: z.enum(['true', 'false']).default('false'), NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    CORS_ORIGINS: z.string().optional(), TRUSTED_PROXIES: z.string().default(''),
    MERCHANT_ACCOUNT: z.string().default(''), MERCHANT_PASSWORD: z.string().default('')
  }).parse(source)
  const production = env.NODE_ENV === 'production'
  const split = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean)
  const appOptions = {
    databasePath: env.DATABASE_PATH, uploadsPath: env.UPLOADS_PATH,
    publicUrl: env.PUBLIC_URL.replace(/\/$/, ''), mockPayments: env.MOCK_PAYMENTS === 'true', production,
    corsOrigins: split(env.CORS_ORIGINS ?? (production ? '' : 'http://localhost:5173,http://127.0.0.1:5173')),
    trustedProxies: split(env.TRUSTED_PROXIES), logger: true
  }
  validateRuntimeOptions(appOptions)
  if (env.MERCHANT_ACCOUNT || env.MERCHANT_PASSWORD) {
    z.string().regex(/^[a-zA-Z0-9_]{3,32}$/).parse(env.MERCHANT_ACCOUNT)
    z.string().min(12).max(128).parse(env.MERCHANT_PASSWORD)
  }
  return { host: env.HOST, port: env.PORT, appOptions, merchantAccount: env.MERCHANT_ACCOUNT, merchantPassword: env.MERCHANT_PASSWORD }
}
