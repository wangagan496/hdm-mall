import type { DatabaseSync } from 'node:sqlite'

export function removeReconciliationLogisticsSchema(db:DatabaseSync) {
  // Older fixtures also remove the later category indexes before dropping SKU columns.
  db.exec('DROP INDEX IF EXISTS skus_product_availability; DROP INDEX IF EXISTS categories_parent;')
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='reconciliation_runs'").get()) return
  db.exec(`DROP TABLE logistics_events; DROP TABLE shipments; DROP TABLE reconciliation_differences;
    DROP TABLE reconciliation_runs; DROP TABLE mock_channel_bill;
    DROP INDEX payments_channel_reference; DROP INDEX refunds_channel_reference;
    ALTER TABLE payments DROP COLUMN channel_transaction_id;
    ALTER TABLE refunds DROP COLUMN channel_refund_id;
    ALTER TABLE orders DROP COLUMN signed_at;`)
}
