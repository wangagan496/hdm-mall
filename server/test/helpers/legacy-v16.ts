import type { DatabaseSync } from 'node:sqlite'
import { removeReconciliationLogisticsSchema } from './legacy-v17.ts'

export function removeServiceSchema(db: DatabaseSync) {
  removeReconciliationLogisticsSchema(db)
  db.exec('DROP TABLE IF EXISTS service_images; DROP TABLE IF EXISTS service_messages; DROP TABLE IF EXISTS service_threads; DROP TABLE IF EXISTS review_moderation; DROP TABLE IF EXISTS invoices;')
}
