import type { DatabaseSync } from 'node:sqlite'
import { historicalIdentity } from '../identity-backup.ts'
import type { PromiseEntry } from '../promises/generated.ts'
import { parseSourceRecord } from './generated.ts'
import { isMaterialJpeg, materialDigest, materialRecord, redactMaterialSummary, type MaterialRow } from './materials.ts'

export const sourceRecordTables = ['product_source_batches', 'source_materials', 'order_item_source_records']

export function inspectSourceRecords(db: DatabaseSync) {
  const held = historicalIdentity(db, 22)
  const materials = new Map<string, MaterialRow>()
  for (const value of db.prepare(`SELECT m.*, (SELECT MAX(previous.version) FROM source_materials previous
    WHERE previous.product_id=m.product_id AND previous.kind=m.kind AND previous.batch=m.batch AND previous.version<m.version) previous_version
    FROM source_materials m`).iterate()) {
    const row = value as unknown as MaterialRow
    const bytes = value.attachment as Uint8Array
    if (!held(row.actor_id, value.acting_identity, row.uploaded_at) || !(bytes instanceof Uint8Array) ||
      !isMaterialJpeg(bytes) || materialDigest(bytes) !== value.sha256 || row.version !== Number(value.previous_version ?? 0) + 1 ||
      row.verification_status === 'verified' || redactMaterialSummary(row.summary) !== row.summary ||
      !parseSourceRecord(JSON.stringify(materialRecord(row, row.batch, row.uploaded_at)))) {
      throw new Error('来源材料记录或附件无效')
    }
    materials.set(row.id, row)
  }
  for (const row of db.prepare('SELECT product_id,entries,created_at FROM promise_drafts').iterate()) {
    for (const entry of JSON.parse(String(row.entries)) as PromiseEntry[]) {
      const ref = entry.sourceRef
      if (ref?.field !== 'material') continue
      const material = materials.get(ref.materialId ?? '')
      if (!material || material.product_id !== row.product_id || material.version !== entry.sourceRevision ||
        material.summary.slice(ref.start, ref.end) !== entry.quote || material.uploaded_at > Number(row.created_at) ||
        material.valid_from > Number(row.created_at) || material.valid_until <= Number(row.created_at)) {
        throw new Error('承诺引用了无效的材料版本')
      }
    }
  }
  const orderMaterials = db.prepare(`SELECT s.order_id,s.sku_id,o.created,s.snapshot FROM order_item_promise_snapshots s
    JOIN orders o ON o.id=s.order_id`)
  const sources = db.prepare('SELECT * FROM order_item_source_records WHERE order_id=? AND sku_id=?')
  for (const order of orderMaterials.iterate()) {
    const entries = (JSON.parse(String(order.snapshot)).entries as PromiseEntry[]).filter(entry => entry.sourceRef?.field === 'material')
    const rows = sources.all(order.order_id!, order.sku_id!)
    if (rows.length !== entries.length) throw new Error('订单缺少下单时的来源记录')
    for (const row of rows) {
      const entry = entries.find(item => item.fieldId === row.field_id)
      const material = materials.get(String(row.material_id))
      const snapshot = parseSourceRecord(String(row.snapshot))
      const at = Number(order.created)
      if (!material || !snapshot || entry?.sourceRef?.materialId !== material.id || entry.sourceRevision !== material.version) {
        throw new Error('订单来源记录与承诺不一致')
      }
      // A withdrawal and the order can share a millisecond.
      const atOrder = material.withdrawn_at === at && snapshot.availability !== 'withdrawn' ? { ...material, withdrawn_at: null } : material
      if (JSON.stringify(snapshot) !== JSON.stringify(materialRecord(atOrder, row.order_batch as string | null, at))) {
        throw new Error('订单来源记录与下单时的材料状态不一致')
      }
    }
  }
}
