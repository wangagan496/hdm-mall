import type { DatabaseSync } from 'node:sqlite'
import { historicalIdentity } from '../identity-backup.ts'
import { parsePromiseDraft, parsePromiseSnapshot } from './generated.ts'
import { acceptedPromiseEntries, confirmPromisesSchema, presentPromisePublication, promiseDraftHash, type PublicationRow } from './publication.ts'

export const promiseTables = ['promise_model_calls', 'promise_drafts', 'promise_confirmations', 'promise_publications',
  'order_item_promise_snapshots', 'order_promise_checks', 'after_sale_promise_links']

export function inspectPromises(db: DatabaseSync) {
  const held = historicalIdentity(db, 21)
  for (const call of db.prepare('SELECT * FROM promise_model_calls').iterate()) {
    if (!held(call.actor_id, 'merchant', call.started_at) || (call.finished_at !== null && Number(call.finished_at) < Number(call.started_at))) {
      throw new Error('承诺抽取调用记录无效')
    }
  }
  const drafts = db.prepare(`SELECT d.*,c.product_id call_product,c.actor_id call_actor,c.product_revision call_revision,
    c.template_version call_template,c.status call_status,c.finished_at call_finished
    FROM promise_drafts d JOIN promise_model_calls c ON c.id=d.model_call_id`)
  const entriesByDraft = new Map<string, NonNullable<ReturnType<typeof parsePromiseDraft>>['entries']>()
  for (const row of drafts.iterate()) {
    const draft = parsePromiseDraft(JSON.stringify({ id: row.id, productRevision: row.product_revision, templateVersion: row.template_version,
      entries: JSON.parse(String(row.entries)), issues: JSON.parse(String(row.issues)) }))
    if (!draft || row.product_id !== row.call_product || row.actor_id !== row.call_actor || row.product_revision !== row.call_revision ||
      row.template_version !== row.call_template || !['succeeded', 'partial'].includes(String(row.call_status)) ||
      Number(row.created_at) < Number(row.call_finished) || !held(row.actor_id, 'merchant', row.created_at) ||
      row.draft_hash !== promiseDraftHash(String(row.product_id), draft.productRevision, draft.templateVersion, String(row.entries))) {
      throw new Error('承诺草稿与抽取记录不一致')
    }
    if (new Set(draft.entries.map(entry => entry.fieldId)).size !== draft.entries.length || !draft.entries.some(entry => entry.status === 'known') ||
      draft.entries.some(entry => entry.status === 'known' ? !entry.value || !entry.quote || !entry.sourceRef ||
        entry.sourceRevision !== draft.productRevision || entry.quote.length !== entry.sourceRef.end - entry.sourceRef.start :
        entry.value !== null || entry.unit !== null || entry.condition !== null || entry.quote !== null || entry.sourceRef !== null || entry.sourceRevision !== null)) {
      throw new Error('承诺草稿缺少有效的原文引用')
    }
    entriesByDraft.set(draft.id, draft.entries)
  }
  const confirmations = db.prepare(`SELECT c.*,d.actor_id draft_actor,d.product_id draft_product,d.product_revision draft_revision,
    d.draft_hash actual_hash,d.template_version,p.receipt_id,p.actor_id publication_actor,p.product_id publication_product,
    p.product_revision publication_revision,p.draft_id publication_draft,p.template_version publication_template,
    p.entries publication_entries,p.published_at publication_time,d.created_at draft_created
    FROM promise_confirmations c JOIN promise_drafts d ON d.id=c.draft_id LEFT JOIN promise_publications p ON p.token_hash=c.token_hash`)
  for (const row of confirmations.iterate()) {
    const data = confirmPromisesSchema.safeParse({ draftId: row.draft_id, decisions: JSON.parse(String(row.decisions)) })
    const draftEntries = entriesByDraft.get(String(row.draft_id))
    const accepted = data.success && draftEntries && acceptedPromiseEntries(draftEntries, data.data.decisions)
    const published = row.used_at !== null
    if (!accepted || row.actor_id !== row.draft_actor || row.product_id !== row.draft_product || row.draft_hash !== row.actual_hash ||
      row.product_revision !== row.draft_revision || !held(row.actor_id, row.acting_identity, row.created_at) ||
      Number(row.created_at) < Number(row.draft_created) || published !== (row.receipt_id !== null) ||
      (published && (row.actor_id !== row.publication_actor || row.product_id !== row.publication_product ||
        row.product_revision !== row.publication_revision || row.draft_id !== row.publication_draft || row.template_version !== row.publication_template ||
        row.used_at !== row.publication_time || !held(row.actor_id, row.acting_identity, row.used_at) ||
        JSON.stringify(accepted) !== row.publication_entries))) {
      throw new Error('承诺确认凭据与发布回执不一致')
    }
  }
  const snapshots = db.prepare(`SELECT p.*,s.snapshot,i.product_id item_product,o.created order_created
    FROM order_item_promise_snapshots s JOIN promise_publications p ON p.receipt_id=s.receipt_id
    JOIN order_items i ON i.order_id=s.order_id AND i.sku_id=s.sku_id JOIN orders o ON o.id=i.order_id`)
  for (const row of snapshots.iterate()) {
    const snapshot = parsePromiseSnapshot(String(row.snapshot))
    if (!snapshot || row.item_product !== row.product_id || Number(row.published_at) > Number(row.order_created) ||
      JSON.stringify(snapshot) !== JSON.stringify(presentPromisePublication(row as unknown as PublicationRow))) {
      throw new Error('订单商品承诺快照与下单时的发布回执不一致')
    }
  }
  const checks = db.prepare(`SELECT c.*,s.snapshot,o.owner_id,o.received_at,
    EXISTS(SELECT 1 FROM user_identities g WHERE g.user_id=c.actor_id AND g.identity='merchant' AND g.granted_at<=c.checked_at) AS own_store
    FROM order_promise_checks c JOIN order_item_promise_snapshots s ON s.order_id=c.order_id AND s.sku_id=c.sku_id
    JOIN orders o ON o.id=c.order_id`)
  for (const row of checks.iterate()) {
    const snapshot = parsePromiseSnapshot(String(row.snapshot))
    if (!snapshot?.entries.some(entry => entry.fieldId === row.field_id && entry.status === 'known') || row.owner_id !== row.actor_id ||
      row.own_store || row.received_at === null || Number(row.checked_at) < Number(row.received_at) || !held(row.actor_id, row.acting_identity, row.checked_at)) {
      throw new Error('订单商品承诺核对记录无效')
    }
  }
  const links = db.prepare(`SELECT a.request_body,l.check_id,c.order_id,c.sku_id,c.field_id,c.actor_id,c.result,c.checked_at,
    s.order_id sale_order,s.requested_by,s.created,
    EXISTS(SELECT 1 FROM after_sale_items i WHERE i.after_sale_id=s.id AND i.sku_id=c.sku_id) linked_item
    FROM after_sale_actions a JOIN after_sales s ON s.id=a.after_sale_id
    LEFT JOIN after_sale_promise_links l ON l.after_sale_id=s.id LEFT JOIN order_promise_checks c ON c.id=l.check_id
    WHERE a.action='request'`)
  for (const row of links.iterate()) {
    const ref = JSON.parse(String(row.request_body)).promiseMismatch
    if (Boolean(ref) !== (row.check_id !== null) || ref && (row.order_id !== row.sale_order || ref.skuId !== row.sku_id ||
      ref.fieldId !== row.field_id || row.actor_id !== row.requested_by || row.result !== 'mismatch' ||
      Number(row.checked_at) > Number(row.created) || !row.linked_item)) {
      throw new Error('售后申请引用的原始承诺不符记录无效')
    }
  }
}
