import { AppError } from './errors.ts'

export type ChannelFetch = (url: string, init?: RequestInit) => Promise<Response>

/** Bounded requests; never propagate provider bodies, URLs or credentials into application logs. */
export async function channelPost(url: string, fields: Record<string, string>, transport: ChannelFetch): Promise<string> {
  try {
    const response = await transport(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: new URLSearchParams(fields).toString() })
    if (!response.ok || !response.body) throw new Error()
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        size += item.value.byteLength
        if (size > 1024 * 1024) { await reader.cancel(); throw new Error() }
        chunks.push(item.value)
      }
    } finally { reader.releaseLock() }
    return Buffer.concat(chunks).toString('utf8')
  } catch { throw new AppError(502, '外部渠道暂时不可用') }
}

export function channelTime(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}[-/]\d{2}[-/]\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new Error('渠道时间无效')
  const normalized = value.replaceAll('/', '-'), time = Date.parse(normalized.replace(' ', 'T') + '+08:00')
  if (!Number.isSafeInteger(time) || time < 0 || beijingTime(time) !== normalized) throw new Error('渠道时间无效')
  return time
}
export function beijingTime(value: number): string { return new Date(value + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') }
export function channelCents(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('渠道金额无效')
  const [units, fraction = ''] = value.split('.')
  const cents = Number(units) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('渠道金额无效')
  return cents
}
