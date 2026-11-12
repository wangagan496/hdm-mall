import { randomUUID, createHash, createHmac } from 'node:crypto'
import { mkdir, lstat, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { verifyBackup } from './backup.ts'
import { backupKeyInfo } from './backup-scheduler.ts'

export interface BackupObject { key: string; size: number }
export interface BackupStore {
  put(key: string, value: Uint8Array): Promise<void>
  list(prefix?: string): Promise<BackupObject[]>
  delete(key: string): Promise<void>
}
export interface ReadableBackupStore extends BackupStore { get(key: string): Promise<Uint8Array> }

interface SigningCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
const awsEncode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

export function signAwsV4(input: { method: string; url: URL; region: string; service?: string; now: Date; body?: Uint8Array;
  headers?: Record<string, string>; credentials: SigningCredentials }) {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.headers ?? {})) if (name.toLowerCase() !== 'authorization') headers[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ')
  headers.host = input.url.host
  headers['x-amz-date'] = input.now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  headers['x-amz-content-sha256'] = hash(input.body ?? new Uint8Array())
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken
  const names = Object.keys(headers).sort()
  const query = [...input.url.searchParams].map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort((left, right) => compare(left[0], right[0]) || compare(left[1], right[1])).map(([key, value]) => key + '=' + value).join('&')
  const path = input.url.pathname.split('/').map(part => awsEncode(decodeURIComponent(part))).join('/')
  const canonical = [input.method.toUpperCase(), path, query, names.map(name => name + ':' + headers[name] + '\n').join(''), names.join(';'), headers['x-amz-content-sha256']].join('\n')
  const date = headers['x-amz-date'].slice(0, 8), service = input.service ?? 's3'
  const scope = date + '/' + input.region + '/' + service + '/aws4_request'
  const stringToSign = ['AWS4-HMAC-SHA256', headers['x-amz-date'], scope, hash(canonical)].join('\n')
  let signingKey = createHmac('sha256', 'AWS4' + input.credentials.secretAccessKey).update(date).digest()
  for (const value of [input.region, service, 'aws4_request']) signingKey = createHmac('sha256', signingKey).update(value).digest()
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  headers.authorization = 'AWS4-HMAC-SHA256 Credential=' + input.credentials.accessKeyId + '/' + scope + ', SignedHeaders=' + names.join(';') + ', Signature=' + signature
  return headers
}

function xmlText(value: string) {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[a-f\d]+);/gi, (_match, entity: string) => {
    if (entity.startsWith('#')) return String.fromCodePoint(entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()]!
  })
}
function xmlTag(xml: string, tag: string) { const match = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(xml); return match ? xmlText(match[1]!) : undefined }

export class S3CompatibleStore implements ReadableBackupStore {
  #credentials: SigningCredentials
  private endpoint: URL
  private bucket: string
  private region: string
  private prefix: string
  private fetcher: typeof fetch
  private now: () => Date
  constructor(options: { endpoint: string; bucket: string; region: string; prefix?: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: () => Date }) {
    const endpoint = new URL(options.endpoint)
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('S3 endpoint must use HTTPS without credentials or query parameters')
    this.endpoint = endpoint
    this.bucket = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).parse(options.bucket)
    this.region = z.string().regex(/^[a-zA-Z0-9-]+$/).parse(options.region)
    this.prefix = options.prefix?.replace(/\/$/, '') ?? ''
    validateKey(this.prefix, true)
    if (this.prefix) this.prefix += '/'
    const env = options.env ?? process.env
    if (!env.BACKUP_ACCESS_KEY_ID || !env.BACKUP_SECRET_ACCESS_KEY) throw new Error('Object storage credentials are not configured')
    this.#credentials = { accessKeyId: env.BACKUP_ACCESS_KEY_ID, secretAccessKey: env.BACKUP_SECRET_ACCESS_KEY,
      ...(env.BACKUP_SESSION_TOKEN ? { sessionToken: env.BACKUP_SESSION_TOKEN } : {}) }
    this.fetcher = options.fetch ?? fetch
    this.now = options.now ?? (() => new Date())
  }
  private async request(method: string, key: string, body?: Uint8Array, query?: Record<string, string>) {
    const url = new URL(this.endpoint)
    url.pathname = url.pathname.replace(/\/$/, '') + '/' + awsEncode(this.bucket) + (key ? '/' + key.split('/').map(awsEncode).join('/') : '')
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value)
    const headers = signAwsV4({ method, url, region: this.region, now: this.now(), body, credentials: this.#credentials })
    try {
      const response = await this.fetcher(url, { method, headers, ...(body ? { body: new Uint8Array(body).buffer } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error('Object storage request failed')
      return response
    } catch { throw new Error('Object storage request failed') }
  }
  async put(key: string, value: Uint8Array) { validateKey(key); const response = await this.request('PUT', this.prefix + key, value); await response.body?.cancel() }
  async get(key: string) { validateKey(key); return new Uint8Array(await (await this.request('GET', this.prefix + key)).arrayBuffer()) }
  async delete(key: string) { validateKey(key); const response = await this.request('DELETE', this.prefix + key); await response.body?.cancel() }
  async list(prefix = '') {
    validateKey(prefix, true)
    const result: BackupObject[] = [], seen = new Set<string>()
    let continuation: string | undefined
    do {
      const query = { 'list-type': '2', prefix: this.prefix + prefix, ...(continuation ? { 'continuation-token': continuation } : {}) }
      const xml = await (await this.request('GET', '', undefined, query)).text()
      if (xml.length > 16 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml) || !xml.includes('<ListBucketResult')) throw new Error('Invalid object storage listing')
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = xmlTag(match[1]!, 'Key'), size = Number(xmlTag(match[1]!, 'Size'))
        if (!key || !key.startsWith(this.prefix + prefix) || !Number.isSafeInteger(size) || size < 0) throw new Error('Invalid object storage item')
        const relativeKey = key.slice(this.prefix.length)
        validateKey(relativeKey)
        result.push({ key: relativeKey, size })
      }
      if (xmlTag(xml, 'IsTruncated') !== 'true') break
      continuation = xmlTag(xml, 'NextContinuationToken')
      if (!continuation || seen.has(continuation)) throw new Error('Invalid object storage pagination')
      seen.add(continuation)
    } while (continuation)
    return result
  }
}

function validateKey(key: string, prefix = false) {
  const value = prefix ? key.replace(/\/$/, '') : key
  if (prefix && value === '') return
  if (!value || /[\\\u0000-\u001f\u007f:]/u.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw new Error('Invalid backup object key')
}

export class LocalDirectoryStore implements ReadableBackupStore {
  private root: string
  constructor(root: string) { this.root = resolve(root) }
  private async file(key: string, create = false) {
    validateKey(key)
    await mkdir(this.root, { recursive: true })
    const rootInfo = await lstat(this.root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Backup store must be a regular directory')
    const parts = key.split('/')
    let parent = this.root
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part)
      if (create) await mkdir(parent).catch(error => { if (error.code !== 'EEXIST') throw error })
      const info = await lstat(parent)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Backup object parent is not a regular directory')
    }
    const path = join(parent, parts.at(-1)!)
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('Backup object is not a regular file')
    return path
  }
  async put(key: string, value: Uint8Array) {
    const path = await this.file(key, true)
    const temporary = join(dirname(path), '.put-' + randomUUID())
    try {
      await writeFile(temporary, value, { flag: 'wx', mode: 0o600 })
      await rename(temporary, path)
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  async get(key: string) { return readFile(await this.file(key)) }
  async delete(key: string) {
    try { await unlink(await this.file(key)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  async list(prefix = '') {
    validateKey(prefix, true)
    await mkdir(this.root, { recursive: true })
    const rootInfo = await lstat(this.root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Backup store must be a regular directory')
    const result: BackupObject[] = []
    const visit = async (parent: string) => {
      for (const entry of await readdir(join(this.root, parent), { withFileTypes: true })) {
        const key = parent ? parent + '/' + entry.name : entry.name
        if (entry.isSymbolicLink()) throw new Error('Backup store contains a symbolic link')
        if (entry.isDirectory()) await visit(key)
        else if (entry.isFile() && !entry.name.startsWith('.put-') && key.startsWith(prefix)) result.push({ key, size: (await lstat(join(this.root, key))).size })
      }
    }
    await visit('')
    return result.sort((left, right) => left.key.localeCompare(right.key))
  }
}

export async function downloadLatestBackup(store: ReadableBackupStore, destination: string) {
  const latest = (await store.list()).filter(object => backupKeyInfo(object.key)?.path === 'manifest.json')
    .sort((left, right) => backupKeyInfo(right.key)!.time - backupKeyInfo(left.key)!.time || left.key.localeCompare(right.key))[0]
  if (!latest) throw new Error('No complete backup found')
  const bytes = await store.get(latest.key)
  if (bytes.byteLength > 16 * 1024 * 1024) throw new Error('Backup manifest is too large')
  const manifest = z.object({ files: z.array(z.object({ path: z.string().regex(/^(mall\.sqlite|uploads\/[a-f0-9-]{36}\.jpg)$/) })).min(1) }).parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
  if (new Set(manifest.files.map(file => file.path)).size !== manifest.files.length || !manifest.files.some(file => file.path === 'mall.sqlite')) throw new Error('Invalid backup file list')
  const root = resolve(destination)
  await mkdir(root)
  await mkdir(join(root, 'uploads'))
  const prefix = latest.key.slice(0, -'manifest.json'.length)
  for (const file of manifest.files) await writeFile(join(root, file.path), await store.get(prefix + file.path), { flag: 'wx', mode: 0o600 })
  await writeFile(join(root, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600 })
  const verified = await verifyBackup(root)
  if (verified.manifest.issues.length) throw new Error('Downloaded backup contains inconsistent data')
  return { ...verified, key: latest.key }
}

export function backupOptionsFromEnvironment(env: NodeJS.ProcessEnv): { store: ReadableBackupStore; stagingPath: string } | undefined {
  if (!env.BACKUP_STORE) return undefined
  try {
    if (!env.BACKUP_STAGING_PATH) throw new Error('missing staging directory')
    if (env.BACKUP_STORE === 'local' && env.BACKUP_LOCAL_DIRECTORY) return { store: new LocalDirectoryStore(env.BACKUP_LOCAL_DIRECTORY), stagingPath: resolve(env.BACKUP_STAGING_PATH) }
    if (env.BACKUP_STORE === 's3' && env.BACKUP_S3_ENDPOINT && env.BACKUP_S3_BUCKET && env.BACKUP_S3_REGION) {
      return { store: new S3CompatibleStore({ endpoint: env.BACKUP_S3_ENDPOINT, bucket: env.BACKUP_S3_BUCKET, region: env.BACKUP_S3_REGION, prefix: env.BACKUP_S3_PREFIX, env }), stagingPath: resolve(env.BACKUP_STAGING_PATH) }
    }
    throw new Error('invalid backup store')
  } catch { throw new Error('Backup configuration is invalid') }
}
