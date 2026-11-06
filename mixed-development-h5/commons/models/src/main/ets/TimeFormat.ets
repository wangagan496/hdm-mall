// 订单、退款、取消截止等时间统一按北京时间显示为“2026-11-06 19:00”。
// 服务端给的是毫秒时间戳或 ISO 字符串（UTC），直接显示会差 8 小时，也看不懂。
// 这里用固定 +8 小时换算，不依赖设备时区和 Intl 支持，测试与真机结果一致。
const BEIJING_OFFSET_MS: number = 8 * 60 * 60 * 1000

function pad2(value: number): string {
  return value < 10 ? '0' + value : String(value)
}

/** 毫秒时间戳或 ISO 字符串 → “YYYY-MM-DD HH:mm”（北京时间）；无法解析时返回空字符串。 */
export function formatBeijingTime(value: number | string | null | undefined, withSeconds: boolean = false): string {
  if (value === null || value === undefined || value === '') {
    return ''
  }
  const millis: number = typeof value === 'number' ? value : new Date(value).getTime()
  if (!Number.isFinite(millis)) {
    return ''
  }
  const shifted: Date = new Date(millis + BEIJING_OFFSET_MS)
  const text: string = shifted.getUTCFullYear() + '-' + pad2(shifted.getUTCMonth() + 1) + '-' + pad2(shifted.getUTCDate()) +
    ' ' + pad2(shifted.getUTCHours()) + ':' + pad2(shifted.getUTCMinutes())
  return withSeconds ? text + ':' + pad2(shifted.getUTCSeconds()) : text
}
