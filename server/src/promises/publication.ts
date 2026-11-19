import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { confirmationSubject, type Accounts, type User } from '../accounts.ts'
import type { Clock } from '../clock.ts'
import type { Database } from '../database.ts'
import { AppError, ensure } from '../errors.ts'
import type { PromiseExtractor } from './extract.ts'
import type { PromiseEntry as Entry } from './generated.ts'

type Decision = { fieldId: string; decision: 'accept' | 'reject' }
interface Product { id: string; name: string; description: string; category: string; revision: number }
interface DraftRow {
  id: string; actor_id: string; product_revision: number; template_version: string
  entries: string; issues: string; draft_hash: string
}
interface ConfirmationRow {
  draft_id: string; product_id: string; product_revision: number; actor_id: string; acting_identity: string
  identity_subject: string; draft_hash: string; decisions: string; created_at: number; expires_at: number; used_at: number | null
}
export interface PublicationRow {
  receipt_id: string; template_version: string; product_revision: number; published_at: number; entries: string
}

const confirmationLifetimeMs = 5 * 60_000
const fieldId = z.string().min(1).max(100)
export const confirmPromisesSchema = z.strictObject({ draftId: z.string().uuid(), decisions: z.array(z.strictObject({ fieldId,
  decision: z.enum(['accept', 'reject']) })).min(1).max(100) })
export const publishPromisesSchema = z.strictObject({ confirmationToken: z.string().regex(/^[a-f0-9]{64}$/), requestKey: z.string().uuid() })

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export function promiseDraftHash(productId: string, revision: number, version: string, entriesJson: string) {
  return digest(JSON.stringify([productId, revision, version, entriesJson]))
}
export function presentPromisePublication(row: PublicationRow) {
  return { receiptId: row.receipt_id, templateVersion: row.template_version, productRevision: row.product_revision,
    publishedAt: row.published_at, entries: JSON.parse(row.entries) as Entry[] }
}
export type PromiseSnapshot = ReturnType<typeof presentPromisePublication>

export function acceptedPromiseEntries(entries: Entry[], decisions: Decision[]) {
  const known = entries.filter(entry => entry.status === 'known')
  const recorded = new Map(decisions.map(decision => [decision.fieldId, decision.decision]))
  if (known.length !== decisions.length || recorded.size !== decisions.length || known.some(entry => !recorded.has(entry.fieldId))) return null
  if (!known.some(entry => recorded.get(entry.fieldId) === 'accept')) return null
  return entries.filter(entry => entry.status !== 'known' || recorded.get(entry.fieldId) === 'accept')
}

export function currentPromisePublication(db: Database, productId: string) {
  return db.one<PublicationRow>('SELECT * FROM promise_publications WHERE product_id=? ORDER BY rowid DESC LIMIT 1', productId)
}

export class PromisePublications {
  private readonly db: Database
  private readonly accounts: Accounts
  private readonly clock: Clock
  private readonly extractor: PromiseExtractor

  constructor(db: Database, accounts: Accounts, clock: Clock, extractor: PromiseExtractor) {
    this.db = db
    this.accounts = accounts
    this.clock = clock
    this.extractor = extractor
  }

  private merchant(user: User) {
    this.accounts.assertCurrent(user)
    ensure(user.identity === 'merchant', 403, '需要店主身份')
  }

  private product(productId: string) {
    const product = this.db.one<Product>('SELECT id,name,description,category,revision FROM products WHERE id=?', productId)
    ensure(product, 404, '商品不存在')
    return product
  }

  private currentDraft(product: Product, user: User) {
    const draft = this.db.one<DraftRow>(`SELECT * FROM promise_drafts
      WHERE product_id=? AND product_revision=? ORDER BY rowid DESC LIMIT 1`, product.id, product.revision)
    if (!draft || draft.actor_id !== user.id || this.db.one('SELECT 1 FROM promise_publications WHERE draft_id=?', draft.id)) return null
    return draft
  }

  state(user: User, productId: string) {
    this.merchant(user)
    const product = this.product(productId)
    const draft = this.currentDraft(product, user)
    const published = currentPromisePublication(this.db, productId)
    return { published: published ? presentPromisePublication(published) : null,
      draft: draft ? { id: draft.id, templateVersion: draft.template_version, productRevision: draft.product_revision,
        entries: JSON.parse(draft.entries) as Entry[], issues: JSON.parse(draft.issues) as string[] } : null }
  }

  async extract(user: User, productId: string) {
    this.merchant(user)
    const product = this.product(productId)
    const specifications = this.db.all<{ spec: string }>('SELECT spec FROM skus WHERE product_id=? AND enabled=1 ORDER BY id', productId)
      .map(sku => sku.spec).join('\n')
    const result = await this.extractor.extract({ productId, actorId: user.id, revision: product.revision, category: product.category,
      name: product.name, description: product.description, specifications })
    return this.db.transaction(() => {
      this.merchant(user)
      if (this.product(productId).revision !== product.revision) throw new AppError(409, '商品资料已修改，请重新抽取承诺', 'PROMISE_DRAFT_STALE')
      const entries = JSON.stringify(result.entries)
      this.db.run(`INSERT INTO promise_drafts(id,product_id,actor_id,product_revision,template_version,model_call_id,entries,issues,draft_hash,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, randomUUID(), productId, user.id, product.revision, result.templateVersion, result.callId, entries,
      JSON.stringify(result.issues), promiseDraftHash(productId, product.revision, result.templateVersion, entries), this.clock.now())
      return this.state(user, productId)
    })
  }

  confirm(user: User, productId: string, data: z.infer<typeof confirmPromisesSchema>) {
    return this.db.transaction(() => {
      this.merchant(user)
      const product = this.product(productId)
      const draft = this.currentDraft(product, user)
      if (!draft || draft.id !== data.draftId) throw new AppError(409, '承诺草稿已更新或发布，请刷新后逐条核对', 'PROMISE_DRAFT_STALE')
      const entries = JSON.parse(draft.entries) as Entry[]
      ensure(acceptedPromiseEntries(entries, data.decisions), 400, '请逐条选择确认或不采纳，并至少确认一条承诺')
      const now = this.clock.now(), expiresAt = now + confirmationLifetimeMs
      const confirmationToken = randomBytes(32).toString('hex')
      this.db.run(`INSERT INTO promise_confirmations(token_hash,draft_id,actor_id,acting_identity,identity_subject,product_id,
        product_revision,draft_hash,decisions,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, digest(confirmationToken), draft.id,
      user.id, user.identity, confirmationSubject(user, 'publish-promises'), productId, product.revision, draft.draft_hash, JSON.stringify(data.decisions), now, expiresAt)
      return { confirmationToken, expiresAt }
    })
  }

  publish(user: User, productId: string, data: z.infer<typeof publishPromisesSchema>): PromiseSnapshot {
    return this.db.transaction(() => {
      this.merchant(user)
      const tokenHash = digest(data.confirmationToken)
      const previous = this.db.one<PublicationRow>(`SELECT * FROM promise_publications
        WHERE actor_id=? AND product_id=? AND request_key=?`, user.id, productId, data.requestKey)
      if (previous) return presentPromisePublication(previous)
      const confirmation = this.db.one<ConfirmationRow>('SELECT * FROM promise_confirmations WHERE token_hash=?', tokenHash)
      const now = this.clock.now()
      if (!confirmation || confirmation.actor_id !== user.id || confirmation.acting_identity !== user.identity ||
        confirmation.product_id !== productId || confirmation.identity_subject !== confirmationSubject(user, 'publish-promises') ||
        confirmation.used_at !== null || confirmation.created_at > now || confirmation.expires_at <= now) {
        throw new AppError(409, '发布确认已失效，请重新确认后发布', 'PROMISE_CONFIRMATION_INVALID')
      }
      const product = this.product(productId)
      const draft = this.currentDraft(product, user)
      if (!draft || draft.id !== confirmation.draft_id || product.revision !== confirmation.product_revision ||
        draft.draft_hash !== confirmation.draft_hash || draft.draft_hash !== promiseDraftHash(productId, product.revision, draft.template_version, draft.entries)) {
        throw new AppError(409, '商品资料或承诺草稿已更新，请重新抽取并逐条确认', 'PROMISE_DRAFT_STALE')
      }
      const entries = acceptedPromiseEntries(JSON.parse(draft.entries) as Entry[], JSON.parse(confirmation.decisions) as Decision[])
      ensure(entries, 409, '请重新逐条确认后发布')
      ensure(this.db.run('UPDATE promise_confirmations SET used_at=? WHERE token_hash=? AND used_at IS NULL', now, tokenHash).changes === 1,
        409, '发布确认已使用，请查看发布回执')
      const receipt: PublicationRow = { receipt_id: randomUUID(), template_version: draft.template_version,
        product_revision: product.revision, published_at: now, entries: JSON.stringify(entries) }
      this.db.run(`INSERT INTO promise_publications(receipt_id,request_key,token_hash,draft_id,actor_id,acting_identity,product_id,
        product_revision,template_version,entries,published_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, receipt.receipt_id, data.requestKey, tokenHash, draft.id,
      user.id, user.identity, productId, receipt.product_revision, receipt.template_version, receipt.entries, receipt.published_at)
      return presentPromisePublication(receipt)
    })
  }

  receipt(user: User, productId: string, requestKey: string) {
    this.merchant(user)
    const row = this.db.one<PublicationRow>('SELECT * FROM promise_publications WHERE actor_id=? AND product_id=? AND request_key=?', user.id, productId, requestKey)
    ensure(row, 404, '暂未找到发布回执')
    return presentPromisePublication(row)
  }
}
