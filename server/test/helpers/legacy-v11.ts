import type { DatabaseSync } from 'node:sqlite'
import { removeLifecycleSchema } from './legacy-v12.ts'

// Older migration fixtures start from today's schema then roll back their subject migration.
// Remove the later v12 layer first so those fixtures remain genuine v11-or-earlier databases.
export function removeAfterSaleSchema(db: DatabaseSync) {
  removeLifecycleSchema(db)
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='after_sales'").get()) return
  db.exec(`PRAGMA foreign_keys=OFF;
    DROP TABLE after_sale_actions; DROP TABLE after_sale_images; DROP TABLE after_sale_items; DROP TABLE after_sales; DROP TABLE merchant_settings;
    CREATE TABLE refunds_v11 (
      id TEXT PRIMARY KEY,payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
      reason TEXT NOT NULL CHECK(reason IN ('late','duplicate','cancelled')),state TEXT NOT NULL CHECK(state IN ('pending','succeeded','failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),next_attempt_at INTEGER,created INTEGER NOT NULL,review_at INTEGER);
    INSERT INTO refunds_v11 SELECT id,payment_id,amount,reason,state,attempts,next_attempt_at,created,review_at FROM refunds;
    DROP TABLE refunds; ALTER TABLE refunds_v11 RENAME TO refunds; CREATE INDEX refunds_retry ON refunds(state,next_attempt_at);
    PRAGMA user_version=11; PRAGMA foreign_keys=ON;`)
}
