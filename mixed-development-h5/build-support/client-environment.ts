import { URL } from 'node:url'
import { isIP } from 'node:net'

export interface ClientEnvironment {
  APP_ENV: string
  API_BASE_URL: string
  DECISION_SERVICE_URL: string
  DEMO_ORDER_FLOW: boolean
}

// 只接受服务原点；错误不包含原始值，避免误填的凭证进入构建日志。
export function validateServiceUrl(value: string, name: string, production: boolean): string {
  const invalid = (): never => { throw new Error(`${name} must be an HTTP(S) service origin${production ? ' using HTTPS and a public DNS hostname' : ''}`) }
  if (!value || /[\s\\?#]/.test(value)) return invalid()
  let url: URL
  try { url = new URL(value) } catch { return invalid() }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/') return invalid()
  const host = url.hostname.replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (!isIP(host) && (host.length > 253 || host.split('.').some(label =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) return invalid()
  if (production) {
    if (url.protocol !== 'https:' || isIP(host) || !host.includes('.') ||
      /(^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/.test(host) ||
      /(^|\.)example\.(com|net|org)$/.test(host)) return invalid()
  }
  return url.origin
}

export function resolveClientEnvironment(buildMode: string, env: Record<string, string | undefined>): ClientEnvironment {
  if (!['debug', 'release'].includes(buildMode)) throw new Error('Unsupported native build mode')
  const appEnv = env.HDM_APP_ENV ?? (buildMode === 'release' ? 'production' : 'development')
  if (!['development', 'test', 'production'].includes(appEnv)) throw new Error('HDM_APP_ENV must be development, test or production')
  if (buildMode === 'release' && appEnv !== 'production') throw new Error('Release build requires HDM_APP_ENV=production')
  const demo = env.HDM_DEMO_ORDER_FLOW ?? 'false'
  if (!['true', 'false'].includes(demo)) throw new Error('HDM_DEMO_ORDER_FLOW must be true or false')
  if (appEnv !== 'development' && demo === 'true') throw new Error('Demo order flow is forbidden outside development')
  const apiUrl = env.HDM_API_BASE_URL ?? (appEnv === 'development' ? 'http://127.0.0.1:3000' : '')
  if (!apiUrl) throw new Error('HDM_API_BASE_URL is required for test and production builds')
  const decisionUrl = env.HDM_DECISION_SERVICE_URL ?? (appEnv === 'development' ? 'http://10.0.2.2:8765' : '')
  return {
    APP_ENV: appEnv,
    API_BASE_URL: validateServiceUrl(apiUrl, 'HDM_API_BASE_URL', appEnv === 'production'),
    DECISION_SERVICE_URL: decisionUrl ? validateServiceUrl(decisionUrl, 'HDM_DECISION_SERVICE_URL', appEnv === 'production') : '',
    DEMO_ORDER_FLOW: demo === 'true',
  }
}
