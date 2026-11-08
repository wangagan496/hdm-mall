import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { constants, copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { avatarFileName, localAvatarPath } from './avatar.ts'

const imageName = avatarFileName
const tables = ['users', 'sessions', 'relations', 'products', 'skus', 'carts', 'addresses',
  'orders', 'order_items', 'evaluations', 'categories', 'product_categories'] as const
const issueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inventory-mismatch'), skuId: z.string() }).strict(),
  z.object({ type: z.literal('unsupported-avatar'), userId: z.string() }).strict(),
  z.object({ type: z.literal('missing-avatar'), userId: z.string() }).strict(),
  z.object({ type: z.literal('payment-mismatch'), orderId: z.string() }).strict(),
  z.object({ type: z.literal('cancel-request-mismatch'), orderId: z.string() }).strict(),
  z.object({ type: z.literal('missing-product-image'), path: z.string() }).strict(),
  z.object({ type: z.literal('missing-order-image'), orderId: z.string(), path: z.string() }).strict(),
  z.object({ type: z.literal('product-image-mismatch'), productId: z.string() }).strict(),
  z.object({ type: z.literal('product-image-hash-mismatch'), imageId: z.string() }).strict(),
])
type BackupIssue = z.infer<typeof issueSchema>
const manifestSchema = z.object({
  format: z.literal(1), schemaVersion: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8), z.literal(9), z.literal(10), z.literal(11)]), createdAt: z.iso.datetime(),
  issues: z.array(issueSchema).default([]),
  files: z.array(z.object({
    path: z.string().refine(path => path === 'mall.sqlite' ||
      (path.startsWith('uploads/') && imageName.test(path.slice(8)))),
    bytes: z.number().int().nonnegative().safe(), sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict()).min(1)
}).strict()
type Manifest = z.infer<typeof manifestSchema>

async function regularFile(path: string) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`要求普通文件：${basename(path)}`)
  return info
}

async function directory(path: string) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('目录不能是符号链接或其他文件类型')
  return realpath(path)
}

function inside(parent: string, child: string) {
  const part = relative(parent, child)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

// 目标必须全新且与源目录分离；不递归创建父级，不覆盖已有数据库或备份。
async function newDestination(path: string, sources: string[]) {
  const absolute = resolve(path)
  const parent = await directory(dirname(absolute))
  const target = join(parent, basename(absolute))
  if (sources.some(source => inside(source, target))) throw new Error('目标必须位于源数据及备份目录之外')
  await mkdir(target, { mode: 0o700 })
  return target
}

async function fingerprint(root: string, path: string) {
  const file = join(root, path)
  const before = await regularFile(file)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  const after = await regularFile(file)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('检查期间文件发生变化')
  return { path, bytes: after.size, sha256: hash.digest('hex') }
}

function inspectCancellations(db: DatabaseSync) {
  const invalid = new Set<string>()
  for (const row of db.prepare("SELECT order_id FROM order_cancel_requests WHERE state='pending' GROUP BY order_id HAVING COUNT(*)>1").all()) invalid.add(String(row.order_id))
  const requests = db.prepare("SELECT c.*,o.state AS order_state,o.owner_id,o.amount AS order_amount,o.paid_by,o.paid_at,o.shipped_at,p.order_id AS payment_order,p.payer_id,p.amount AS payment_amount,p.state AS payment_state,p.channel_paid_at,r.payment_id AS refund_payment,r.amount AS refund_amount,r.reason AS refund_reason,EXISTS(SELECT 1 FROM refunds existing WHERE existing.payment_id=c.payment_id) AS payment_refunded FROM order_cancel_requests c JOIN orders o ON o.id=c.order_id JOIN payments p ON p.id=c.payment_id LEFT JOIN refunds r ON r.id=c.refund_id").all()
  for (const request of requests) {
    const approved = request.state === 'approved' || request.state === 'auto-approved'
    let valid = request.requested_by === request.owner_id && request.payment_order === request.order_id && request.payer_id === request.paid_by &&
      request.payment_amount === request.order_amount && request.channel_paid_at === request.paid_at && request.payment_state === 'succeeded'
    if (request.state === 'pending') valid &&= request.order_state === 2 && request.shipped_at === null && request.payment_refunded === 0
    if (request.state === 'rejected-shipped') valid &&= [3, 4, 5].includes(Number(request.order_state)) && request.shipped_at === request.resolved_at && request.payment_refunded === 0
    if (approved) valid &&= request.order_state === 6 && request.shipped_at === null && request.refund_payment === request.payment_id &&
      request.refund_amount === request.payment_amount && request.refund_reason === 'cancelled'
    const actions = db.prepare('SELECT a.*,u.role FROM order_cancel_actions a LEFT JOIN users u ON u.id=a.actor_id WHERE a.cancel_request_id=?').all(request.id!)
    const terminalAction = request.state === 'withdrawn' ? 'withdraw' : request.state === 'approved' ? 'approve' : request.state === 'auto-approved' ? 'auto-approve' : 'reject-and-ship'
    valid &&= actions.length === (request.state === 'pending' ? 1 : 2) && actions.filter(action => action.action === 'request').length === 1
    for (const action of actions) {
      const initial = action.action === 'request'
      const actorValid = initial || action.action === 'withdraw' ? action.actor_id === request.requested_by :
        action.action === 'auto-approve' ? action.actor_id === null : action.actor_id === request.resolved_by && action.role === 'merchant'
      const expectedState = initial ? 'pending' : request.state
      const expectedTime = initial ? request.created : request.resolved_at
      const expectedRefund = !initial && approved ? request.refund_id : null
      const body = JSON.stringify({ orderId: request.order_id, ...(initial ? {} : { cancelRequestId: request.id }), action: action.action,
        ...(action.action === 'reject-and-ship' ? { reason: request.reject_reason } : {}) })
      const result = JSON.parse(String(action.result)) as Record<string, unknown> | null
      valid &&= actorValid && (initial || action.action === terminalAction) && action.order_id === request.order_id && action.created === expectedTime && action.request_body === body &&
        result !== null && typeof result === 'object' && result.id === action.id && result.orderId === request.order_id && result.cancelRequestId === request.id &&
        result.action === action.action && result.appliedState === expectedState && result.appliedAt === expectedTime && result.refundId === expectedRefund
    }
    if (!valid) invalid.add(String(request.order_id))
  }
  return [...invalid].sort()
}

function inspectDatabase(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('数据库完整性检查失败')
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('数据库外键检查失败')
    const version = db.prepare('PRAGMA user_version').get()?.user_version
    if (version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7 && version !== 8 && version !== 9 && version !== 10 && version !== 11) throw new Error('仅支持数据库版本 2 至 11')
    const counts: Record<string, number> = {}
    for (const table of [...tables, ...(version >= 3 ? ['inventory_movements'] : []),
      ...(version >= 6 ? ['address_save_sessions', 'address_tombstones'] : []),
      ...(version >= 7 ? ['payments', 'refunds', 'refund_retry_actions', 'payment_notices', 'payment_review_resolutions'] : []),
      ...(version >= 8 ? ['order_cancel_requests', 'order_cancel_actions'] : []),
      ...(version >= 9 ? ['cart_requests'] : []), ...(version >= 10 ? ['product_images', 'product_changes'] : [])]) {
      counts[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count)
    }
    const issues: BackupIssue[] = []
    if (version >= 3) {
      for (const row of db.prepare(`SELECT s.id FROM skus s WHERE
        NOT EXISTS(SELECT 1 FROM inventory_movements m WHERE m.sku_id=s.id AND m.kind='opening') OR
        s.stock<>(SELECT COALESCE(SUM(m.delta),0) FROM inventory_movements m WHERE m.sku_id=s.id) ORDER BY s.id`).iterate()) {
        issues.push({ type: 'inventory-mismatch', skuId: String(row.id) })
      }
    }
    if (version >= 7) {
      for (const order of db.prepare('SELECT id,state,shipped_at,paid_by,paid_at,amount FROM orders WHERE paid_by IS NOT NULL').all()) {
        const effective = Number(db.prepare("SELECT COUNT(*) AS count FROM payments p WHERE p.order_id=? AND p.state='succeeded' AND p.payer_id=? AND p.amount=? AND p.channel_paid_at=? AND NOT EXISTS(SELECT 1 FROM refunds r WHERE r.payment_id=p.id)").get(order.id!, order.paid_by!, order.amount!, order.paid_at!)!.count)
        let valid = effective === 1
        if (version >= 8 && order.state === 6) {
          const cancellation = db.prepare("SELECT c.payment_id,r.payment_id AS refund_payment,r.reason,r.amount,p.amount AS paid_amount,p.state AS payment_state,p.order_id,p.payer_id,p.channel_paid_at FROM order_cancel_requests c LEFT JOIN refunds r ON r.id=c.refund_id LEFT JOIN payments p ON p.id=c.payment_id WHERE c.order_id=? AND c.state IN ('approved','auto-approved')").all(order.id!)
          if (cancellation.length) {
            const request = cancellation[0]!
            valid = cancellation.length === 1 && effective === 0 && order.shipped_at === null && request.payment_id === request.refund_payment &&
              request.reason === 'cancelled' && request.amount === order.amount && request.paid_amount === order.amount && request.payment_state === 'succeeded' &&
              request.order_id === order.id && request.payer_id === order.paid_by && request.channel_paid_at === order.paid_at
          }
        }
        if (!valid) issues.push({ type: 'payment-mismatch', orderId: String(order.id) })
      }
    }
    if (version >= 8) {
      for (const orderId of inspectCancellations(db)) issues.push({ type: 'cancel-request-mismatch', orderId })
    }
    const uploads = new Set<string>()
    const avatarUsers: { path: string; userId: string }[] = []
    for (const row of db.prepare('SELECT id, profile FROM users ORDER BY id').iterate()) {
      const profile: unknown = JSON.parse(String(row.profile))
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('账号资料格式无效')
      const avatar = (profile as { avatar?: unknown }).avatar
      if (avatar === undefined || avatar === '') continue
      const path = typeof avatar === 'string' ? localAvatarPath(avatar) : undefined
      if (!path) {
        issues.push({ type: 'unsupported-avatar', userId: String(row.id) })
        continue
      }
      uploads.add(path.slice(1))
      avatarUsers.push({ path: path.slice(1), userId: String(row.id) })
    }
    const productImages = new Set<string>()
    const orderImages: { path: string; orderId: string }[] = []
    const registeredImages: { path: string; imageId: string; sha256: string }[] = []
    if (version >= 10) {
      for (const row of db.prepare('SELECT image_id,path,sha256 FROM product_images ORDER BY image_id').iterate()) {
        const path = localAvatarPath(row.path)
        if (!path) throw new Error('商品图片登记路径无效')
        productImages.add(path.slice(1))
        registeredImages.push({ path: path.slice(1), imageId: String(row.image_id), sha256: String(row.sha256) })
      }
      for (const row of db.prepare('SELECT id,picture FROM products ORDER BY id').iterate()) {
        const path = localAvatarPath(row.picture)
        if (!path) continue
        productImages.add(path.slice(1))
        if (!db.prepare('SELECT image_id FROM product_images WHERE product_id=? AND path=?').get(row.id!, path)) {
          issues.push({ type: 'product-image-mismatch', productId: String(row.id) })
        }
      }
      for (const row of db.prepare('SELECT DISTINCT order_id,picture FROM order_items ORDER BY order_id,picture').iterate()) {
        const path = localAvatarPath(row.picture)
        if (path) orderImages.push({ path: path.slice(1), orderId: String(row.order_id) })
      }
      for (const path of productImages) uploads.add(path)
      for (const row of orderImages) uploads.add(row.path)
    }
    return { counts, uploads: [...uploads].sort(), avatarUsers, productImages: [...productImages].sort(), orderImages, registeredImages,
      issues, schemaVersion: version as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 }
  } finally { db.close() }
}

function snapshotIssues(database: ReturnType<typeof inspectDatabase>, files: Manifest['files']): BackupIssue[] {
  const images = files.map(file => file.path)
  return [...database.issues, ...database.avatarUsers.filter(user => !images.includes(user.path))
    .map(user => ({ type: 'missing-avatar' as const, userId: user.userId })),
    ...database.productImages.filter(path => !images.includes(path)).map(path => ({ type: 'missing-product-image' as const, path })),
    ...database.orderImages.filter(row => !images.includes(row.path)).map(row => ({ type: 'missing-order-image' as const, ...row })),
    ...database.registeredImages.filter(row => files.some(file => file.path === row.path && file.sha256 !== row.sha256))
      .map(row => ({ type: 'product-image-hash-mismatch' as const, imageId: row.imageId }))]
}

// 备份文件不携带 WAL；恢复时只需要快照本身，不能混入旁边的旧日志。
function standaloneDatabase(path: string, clearSessions = false) {
  const db = new DatabaseSync(path)
  try {
    if (clearSessions) db.exec('DELETE FROM sessions')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const mode = db.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode
    if (mode !== 'delete') throw new Error('无法生成独立数据库快照')
  } finally { db.close() }
}

async function checkFiles(root: string, manifest: Manifest) {
  const names = manifest.files.map(file => file.path)
  if (new Set(names).size !== names.length || !names.includes('mall.sqlite')) throw new Error('清单文件重复或缺少数据库')
  await directory(join(root, 'uploads'))
  const top = (await readdir(root)).sort()
  if (JSON.stringify(top) !== JSON.stringify(['mall.sqlite', 'manifest.json', 'uploads'])) {
    throw new Error('备份包含未登记文件或数据库日志')
  }
  const images = (await readdir(join(root, 'uploads'))).map(name => `uploads/${name}`).sort()
  if (JSON.stringify(images) !== JSON.stringify(names.filter(name => name !== 'mall.sqlite').sort())) {
    throw new Error('上传文件与清单不一致')
  }
  for (const expected of manifest.files) {
    const actual = await fingerprint(root, expected.path)
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`备份校验失败：${expected.path}`)
  }
  const database = inspectDatabase(join(root, 'mall.sqlite'))
  if (database.schemaVersion !== manifest.schemaVersion) throw new Error('数据库版本与清单不一致')
  if (images.some(image => !database.uploads.includes(image))) throw new Error('数据库头像引用与备份文件不一致')
  const actualIssues = snapshotIssues(database, manifest.files)
  const issueKeys = (issues: BackupIssue[]) => JSON.stringify(issues.map(issue => JSON.stringify(issueSchema.parse(issue))).sort())
  if (issueKeys(actualIssues) !== issueKeys(manifest.issues)) {
    throw new Error('库存与流水、支付或头像引用的不一致项与清单 issues 不符')
  }
  return database
}

export async function verifyBackup(path: string) {
  const root = await directory(resolve(path))
  const info = await regularFile(join(root, 'manifest.json'))
  if (info.size > 16 * 1024 * 1024) throw new Error('备份清单过大')
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')))
  const database = await checkFiles(root, manifest)
  return { root, manifest, counts: database.counts }
}

export async function createBackup(options: { databasePath: string; uploadsPath: string; destination: string }) {
  const source = resolve(options.databasePath)
  await regularFile(source) // 防止 SQLite 把拼错的路径创建成空数据库。
  const sourceRoot = await realpath(dirname(source))
  // 缺失的头像记入清单，其他文件读取错误仍阻止备份。
  const uploadsRoot = resolve(options.uploadsPath)
  let resolvedUploads = uploadsRoot
  try { resolvedUploads = await directory(uploadsRoot) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const destination = await newDestination(options.destination, [sourceRoot, resolvedUploads])
  const snapshot = join(destination, 'mall.sqlite')
  const connection = new DatabaseSync(source, { readOnly: true })
  try { await sqliteBackup(connection, snapshot) } finally { connection.close() }
  standaloneDatabase(snapshot)
  const database = inspectDatabase(snapshot)
  await mkdir(join(destination, 'uploads'), { mode: 0o700 })
  const copiedImages: string[] = []
  // 当前上传先完整写文件再提交头像引用，UUID 文件不会覆盖或删除；从快照收集引用即可对应同一份数据。
  for (const path of database.uploads) {
    const original = join(resolvedUploads, basename(path))
    try {
      await regularFile(original)
      await copyFile(original, join(destination, path), constants.COPYFILE_EXCL)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const copied = await fingerprint(destination, path)
    const sourceHash = await fingerprint(resolvedUploads, basename(path))
    if (copied.sha256 !== sourceHash.sha256 || copied.bytes !== sourceHash.bytes) throw new Error('复制期间头像发生变化')
    copiedImages.push(path)
  }
  const files = []
  for (const path of ['mall.sqlite', ...copiedImages]) files.push(await fingerprint(destination, path))
  const manifest: Manifest = { format: 1, schemaVersion: database.schemaVersion, createdAt: new Date().toISOString(),
    files, issues: snapshotIssues(database, files) }
  // 清单最后写入；缺失、部分写入或文件哈希不符的目录不能通过校验。
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return verifyBackup(destination)
}

export async function restoreBackup(options: { backupPath: string; destination: string; allowInconsistent?: boolean }) {
  const verified = await verifyBackup(options.backupPath)
  if (verified.manifest.issues.length && !options.allowInconsistent) {
    throw new Error('快照含不一致数据；确认后使用 --allow-inconsistent 才能恢复')
  }
  const destination = await newDestination(options.destination, [verified.root])
  await mkdir(join(destination, 'uploads'), { mode: 0o700 })
  for (const file of verified.manifest.files) {
    await copyFile(join(verified.root, file.path), join(destination, file.path), constants.COPYFILE_EXCL)
    const copied = await fingerprint(destination, file.path)
    if (copied.sha256 !== file.sha256 || copied.bytes !== file.bytes) throw new Error('恢复复制期间备份发生变化')
  }
  const snapshot = join(destination, 'mall.sqlite')
  inspectDatabase(snapshot)
  // 已退出或已过期的会话不能因回滚备份重新生效；恢复后统一重新登录。
  standaloneDatabase(snapshot, true)
  const database = inspectDatabase(snapshot)
  const report = { format: 1, restoredAt: new Date().toISOString(), backupCreatedAt: verified.manifest.createdAt,
    sourceDatabaseSha256: verified.manifest.files.find(file => file.path === 'mall.sqlite')!.sha256,
    sessionPolicy: 'all-sessions-revoked', counts: database.counts, issues: verified.manifest.issues }
  await writeFile(join(destination, 'restore-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return { root: destination, report }
}
