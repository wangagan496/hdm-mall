import type { DatabaseSync } from 'node:sqlite'

export function removeServiceSchema(db: DatabaseSync) {
  db.exec('DROP TABLE IF EXISTS service_images; DROP TABLE IF EXISTS service_messages; DROP TABLE IF EXISTS service_threads; DROP TABLE IF EXISTS review_moderation; DROP TABLE IF EXISTS invoices;')
}
