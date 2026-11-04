export const avatarFileName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/

// 只识别本服务生成的 UUID JPEG 引用；不解析相对跳转、不解码路径，也不访问远程地址。
export function localAvatarPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() !== value) return null
  if (value.startsWith('/uploads/') && avatarFileName.test(value.slice('/uploads/'.length))) return value
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      value !== url.origin + url.pathname || !url.pathname.startsWith('/uploads/') ||
      !avatarFileName.test(url.pathname.slice('/uploads/'.length))) return null
    return url.pathname
  } catch { return null }
}
