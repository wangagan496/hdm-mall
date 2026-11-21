import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Accounts, User } from '../accounts.ts'
import type { Clock } from '../clock.ts'
import type { Database } from '../database.ts'
import { AppError, ensure } from '../errors.ts'
import type { PromiseEntry } from '../promises/generated.ts'
import type { MaterialKind, ProductMaterials, SourceAvailability, SourceRecord, VerificationStatus } from './generated.ts'

export const materialLimit = 512 * 1024
const batchValue = z.string().trim().regex(/^[\p{L}\p{N}_-]{1,40}$/u)
export const materialBatchSchema = z.strictObject({ batch: batchValue })
export const materialUploadSchema = z.strictObject({
  requestKey: z.string().uuid(),
  kind: z.enum(['batch-note', 'authorization', 'inspection-report'] satisfies MaterialKind[]),
  batch: batchValue,
  previousVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  validFrom: z.iso.date(), validThrough: z.iso.date(),
  summary: z.string().trim().min(1).max(400),
})
export type MaterialUpload = z.infer<typeof materialUploadSchema>

export interface MaterialRow {
  id: string; product_id: string; kind: MaterialKind; batch: string; version: number; product_name: string
  valid_from: number; valid_until: number; summary: string; actor_id: string; uploaded_at: number
  withdrawn_at: number | null; verification_status: VerificationStatus
  verifier_id: string | null; verified_at: number | null; verification_basis: string | null
}

const metadata = 'id,product_id,kind,batch,version,product_name,valid_from,valid_until,summary,actor_id,uploaded_at,' +
  'withdrawn_at,verification_status,verifier_id,verified_at,verification_basis'
export const materialDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export const isMaterialJpeg = (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff

export function redactMaterialSummary(text: string) {
  return text.replace(/(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '〔已隐藏〕')
    .replace(/(?:身份证(?:号)?|联系电话|手机(?:号)?|电话|地址|联系人|微信|签名|签字人)\s*[:：]\s*[^\r\n。；，;,]+/gu, '〔已隐藏〕')
    .replace(/(?<!\d)\d(?:[ -]?\d){6,17}[0-9Xx]?(?!\d)/gu, '〔已隐藏〕')
}

export function saleBatch(db: Database, productId: string) {
  return db.one<{ batch: string }>('SELECT batch FROM product_source_batches WHERE product_id=?', productId)?.batch ?? null
}

export function sourceAvailability(row: MaterialRow, batch: string | null, now: number): SourceAvailability {
  if (row.withdrawn_at !== null && row.withdrawn_at <= now) return 'withdrawn'
  if (row.valid_until <= now) return 'expired'
  if (row.batch !== batch) return 'batch-mismatch'
  if (row.valid_from > now) return 'not-yet-valid'
  return 'applicable'
}

export function materialRecord(row: MaterialRow, batch: string | null, now: number): SourceRecord {
  const verified = row.verification_status === 'verified' && row.verified_at !== null && row.verified_at <= now
  return { materialId: row.id, kind: row.kind, version: row.version, productId: row.product_id, productName: row.product_name,
    batch: row.batch, validFrom: row.valid_from, validUntil: row.valid_until, summary: row.summary,
    verificationStatus: !verified && row.verification_status === 'verified' ? 'pending' : row.verification_status,
    availability: sourceAvailability(row, batch, now),
    verifier: verified ? row.verifier_id : null, verifiedAt: verified ? row.verified_at : null,
    basis: verified ? row.verification_basis : null }
}

export function materialById(db: Database, id: string) {
  return db.one<MaterialRow>(`SELECT ${metadata} FROM source_materials WHERE id=?`, id)
}

export function extractionMaterials(db: Database, productId: string, now: number) {
  const batch = saleBatch(db, productId)
  return db.all<MaterialRow>(`SELECT ${metadata} FROM source_materials m WHERE product_id=? AND batch=?
    AND version=(SELECT MAX(version) FROM source_materials newer
      WHERE newer.product_id=m.product_id AND newer.kind=m.kind AND newer.batch=m.batch)
    ORDER BY kind`, productId, batch)
    .filter(row => row.verification_status !== 'unverifiable' && sourceAvailability(row, batch, now) === 'applicable')
    .map(row => ({ id: row.id, version: row.version, text: row.summary }))
}

export function requireCurrentMaterials(db: Database, productId: string, entries: PromiseEntry[], now: number) {
  const active = extractionMaterials(db, productId, now)
  for (const entry of entries) {
    const ref = entry.sourceRef
    if (ref?.field !== 'material') continue
    const material = active.find(row => row.id === ref.materialId && row.version === entry.sourceRevision)
    if (!material || material.text.slice(ref.start, ref.end) !== entry.quote) {
      throw new AppError(409, '承诺所用材料已更新、失效或批次不匹配，请重新抽取', 'PROMISE_DRAFT_STALE')
    }
  }
}

export function productMaterialSources(db: Database, productId: string, entries: PromiseEntry[], now: number) {
  const batch = saleBatch(db, productId)
  return entries.flatMap(entry => {
    const ref = entry.sourceRef
    if (ref?.field !== 'material' || !ref.materialId) return []
    const material = materialById(db, ref.materialId)
    if (!material || material.product_id !== productId || material.version !== entry.sourceRevision) return []
    const record = materialRecord(material, batch, now)
    return [{ fieldId: entry.fieldId, record, currentAvailability: record.availability }]
  })
}

export class SourceMaterials {
  private readonly db: Database
  private readonly accounts: Accounts
  private readonly clock: Clock

  constructor(db: Database, accounts: Accounts, clock: Clock) {
    this.db = db
    this.accounts = accounts
    this.clock = clock
  }

  requireOwner(user: User, productId: string) {
    this.accounts.assertCurrent(user)
    ensure(user.identity === 'merchant', 403, '需要店主身份')
    const product = this.db.one<{ name: string; owner_id: string | null }>(`SELECT p.name,COALESCE(
      (SELECT actor_id FROM product_changes WHERE product_id=p.id AND action='create' ORDER BY rowid LIMIT 1),
      (SELECT g.user_id FROM user_identities g JOIN users u ON u.id=g.user_id WHERE g.identity='merchant'
        ORDER BY g.granted_at,u.rowid LIMIT 1)) owner_id FROM products p WHERE p.id=?`, productId)
    ensure(product, 404, '商品不存在')
    ensure(product.owner_id === user.id, 403, '只有该商品的店主可以管理来源材料')
    return product
  }

  list(user: User, productId: string): ProductMaterials {
    this.requireOwner(user, productId)
    const batch = saleBatch(this.db, productId), now = this.clock.now()
    const rows = this.db.all<MaterialRow>(`SELECT ${metadata} FROM source_materials
      WHERE product_id=? AND actor_id=? ORDER BY rowid DESC LIMIT 100`, productId, user.id)
    return { batch, materials: rows.map(row => materialRecord(row, batch, now)) }
  }

  setBatch(user: User, productId: string, batch: string) {
    return this.db.transaction(() => {
      this.requireOwner(user, productId)
      this.db.run(`INSERT INTO product_source_batches(product_id,batch) VALUES(?,?)
        ON CONFLICT(product_id) DO UPDATE SET batch=excluded.batch`, productId, batch)
      return this.list(user, productId)
    })
  }

  upload(user: User, productId: string, data: MaterialUpload, bytes: Buffer) {
    ensure(bytes.length <= materialLimit, 413, '材料图片过大，请换一张')
    ensure(isMaterialJpeg(bytes), 400, '请选择 JPEG 材料照片')
    // Inclusive dates in the storefront's calendar (China Standard Time).
    const validFrom = Date.parse(data.validFrom + 'T00:00:00+08:00')
    const validUntil = Date.parse(data.validThrough + 'T00:00:00+08:00') + 86_400_000
    ensure(validFrom >= 0 && validUntil > validFrom, 400, '有效期结束日不能早于开始日')
    const summary = redactMaterialSummary(data.summary)
    const sha256 = materialDigest(bytes)
    return this.db.transaction(() => {
      const product = this.requireOwner(user, productId)
      const now = this.clock.now(), batch = saleBatch(this.db, productId)
      const prior = this.db.one<MaterialRow & { sha256: string }>(
        `SELECT ${metadata},sha256 FROM source_materials WHERE actor_id=? AND request_key=?`, user.id, data.requestKey)
      const same = (row: MaterialRow & { sha256: string }) => row.product_id === productId && row.kind === data.kind &&
        row.batch === data.batch && row.valid_from === validFrom && row.valid_until === validUntil &&
        row.summary === summary && row.sha256 === sha256
      if (prior) {
        ensure(same(prior) && prior.version === data.previousVersion + 1, 409, '同一次上传不能更换材料')
        return materialRecord(prior, batch, now)
      }
      const latest = this.db.one<MaterialRow & { sha256: string }>(`SELECT ${metadata},sha256 FROM source_materials
        WHERE product_id=? AND kind=? AND batch=? ORDER BY version DESC LIMIT 1`, productId, data.kind, data.batch)
      ensure(!latest || latest.actor_id === user.id, 403, '不能更新其他店主上传的材料')
      ensure(!latest || !same(latest), 409, '相同材料已经上传')
      ensure(data.previousVersion === (latest?.version ?? 0), 409, '材料版本已更新，请刷新后再提交')
      const id = randomUUID()
      this.db.run(`INSERT INTO source_materials(id,product_id,kind,batch,version,product_name,valid_from,valid_until,summary,
        actor_id,acting_identity,uploaded_at,request_key,sha256,attachment) VALUES(?,?,?,?,?,?,?,?,?,?,'merchant',?,?,?,?)`,
      id, productId, data.kind, data.batch, data.previousVersion + 1, product.name, validFrom, validUntil, summary,
      user.id, now, data.requestKey, sha256, bytes)
      return materialRecord(materialById(this.db, id)!, batch, now)
    })
  }

  private ownedMaterial(user: User, productId: string, id: string) {
    this.requireOwner(user, productId)
    const row = materialById(this.db, id)
    ensure(row && row.product_id === productId && row.actor_id === user.id, 404, '材料不存在')
    return row
  }

  markVerified(_user: User, _productId: string, _id: string,
    _record: { verifier: string; verifiedAt: number; basis: string }) {
    throw new AppError(403, '本阶段未接入具备核验资格的人员')
  }

  attachment(user: User, productId: string, id: string) {
    this.ownedMaterial(user, productId, id)
    return Buffer.from(this.db.one<{ attachment: Uint8Array }>('SELECT attachment FROM source_materials WHERE id=?', id)!.attachment)
  }

  withdraw(user: User, productId: string, id: string) {
    return this.db.transaction(() => {
      this.ownedMaterial(user, productId, id)
      this.db.run('UPDATE source_materials SET withdrawn_at=? WHERE id=? AND withdrawn_at IS NULL', this.clock.now(), id)
      return this.list(user, productId)
    })
  }
}
