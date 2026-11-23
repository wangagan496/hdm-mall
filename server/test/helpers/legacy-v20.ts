import type { DatabaseSync } from 'node:sqlite'

export function removeEvaluationSchema(db: DatabaseSync) {
  if(db.prepare('PRAGMA user_version').get()!.user_version===27) db.exec(`DROP TABLE evaluation_service_records;
    DROP TRIGGER evaluation_followup_no_delete; DROP TRIGGER evaluation_followup_no_update; DROP TABLE evaluation_followups; PRAGMA user_version=26;`)
  if(db.prepare('PRAGMA user_version').get()!.user_version===26) db.exec(`DROP TABLE review_dispute_conclusions;
    DROP TABLE review_dispute_actions; DROP TABLE review_disputes; PRAGMA user_version=25;`)
  if(db.prepare('PRAGMA user_version').get()!.user_version===25) db.exec(`DROP VIEW required_evaluation_sizes;
    DROP TRIGGER freeze_size_category; DROP TABLE evaluation_sizes; ALTER TABLE order_items DROP COLUMN size_category;
    ALTER TABLE evaluations DROP COLUMN size_shift; ALTER TABLE evaluations DROP COLUMN size_fit; PRAGMA user_version=24;`)
  if (db.prepare('PRAGMA user_version').get()!.user_version === 24) {
    db.exec(`DROP TRIGGER freeze_review_edition; DROP TRIGGER review_edition_product; DROP TRIGGER review_edition_sku;
      ALTER TABLE products DROP COLUMN review_edition; ALTER TABLE order_items DROP COLUMN review_edition;
      DROP TABLE merchant_evaluation_replies; DROP TABLE evaluation_revisions; DROP TABLE evaluation_items; DROP INDEX evaluation_public_id;
      ALTER TABLE evaluations DROP COLUMN product_score; ALTER TABLE evaluations DROP COLUMN logistics_score;
      ALTER TABLE evaluations DROP COLUMN service_score; ALTER TABLE evaluations DROP COLUMN updated;
      ALTER TABLE evaluations DROP COLUMN revision; ALTER TABLE evaluations DROP COLUMN public_id;
      ALTER TABLE evaluations DROP COLUMN service_occurred; PRAGMA user_version=23;`)
  }
}

export function removePromiseSchema(db: DatabaseSync) {
  removeEvaluationSchema(db)
  if (db.prepare('PRAGMA user_version').get()!.user_version === 23) {
    db.exec('DROP INDEX after_sales_size_reason; ALTER TABLE after_sales DROP COLUMN size_reason; PRAGMA user_version=22;')
  }
  if (db.prepare('PRAGMA user_version').get()!.user_version !== 22) return
  db.exec('DROP TABLE order_item_source_records; DROP TABLE source_materials; DROP TABLE product_source_batches; PRAGMA user_version=21;')
  if (db.prepare('PRAGMA user_version').get()!.user_version !== 21) return
  db.exec(`DROP TABLE after_sale_promise_links; DROP TABLE order_promise_checks; DROP TABLE order_item_promise_snapshots;
    DROP TABLE promise_publications; DROP TABLE promise_confirmations; DROP TABLE promise_drafts; DROP TABLE promise_model_calls;
    PRAGMA user_version=20;`)
}
