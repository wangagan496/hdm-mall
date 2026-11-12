import type { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { removeServiceSchema } from './legacy-v16.ts'

export function removePromotionShippingSchema(db: DatabaseSync) {
  removeServiceSchema(db)
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='promotions'").get()) return
  const foreignKeys = Number(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys)
  db.exec('PRAGMA foreign_keys=OFF')
  try {
    db.exec(`DROP TRIGGER refunds_shipping_insert; DROP TABLE promotion_changes; DROP TABLE promotions;
      ALTER TABLE orders DROP COLUMN promotion; ALTER TABLE orders DROP COLUMN discount;
      ALTER TABLE order_items DROP COLUMN discount_share; ALTER TABLE after_sale_items DROP COLUMN discount_share;
      DROP INDEX after_sales_shipping_refund;
      ALTER TABLE after_sales DROP COLUMN shipping_refund_id;
      ALTER TABLE after_sales DROP COLUMN shipping_adjustment_reason;
      ALTER TABLE after_sales DROP COLUMN shipping_compensation;
      ALTER TABLE after_sales DROP COLUMN shipping_image_id;
      ALTER TABLE after_sales DROP COLUMN shipping_amount;
      CREATE TABLE refunds_v15 (
        id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id),
        amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
        reason TEXT NOT NULL CHECK(reason IN ('late','duplicate','cancelled','after-sale')),
        after_sale_id TEXT UNIQUE REFERENCES after_sales(id),
        state TEXT NOT NULL CHECK(state IN ('pending','succeeded','failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at INTEGER, created INTEGER NOT NULL, review_at INTEGER, completed_at INTEGER,
        CHECK((reason='after-sale' AND after_sale_id IS NOT NULL) OR (reason<>'after-sale' AND after_sale_id IS NULL)));
      INSERT INTO refunds_v15 SELECT * FROM refunds;
      DROP TABLE refunds; ALTER TABLE refunds_v15 RENAME TO refunds;
      CREATE UNIQUE INDEX refunds_one_payment_reversal ON refunds(payment_id) WHERE reason IN ('late','duplicate','cancelled');
      CREATE INDEX refunds_retry ON refunds(state,next_attempt_at);
      CREATE TRIGGER refunds_amount_insert BEFORE INSERT ON refunds BEGIN
        SELECT CASE WHEN NEW.amount+COALESCE((SELECT SUM(amount) FROM refunds WHERE payment_id=NEW.payment_id),0)>(SELECT amount FROM payments WHERE id=NEW.payment_id)
        THEN RAISE(ABORT,'Refund exceeds payment') END; END;
      CREATE TRIGGER refunds_identity_update BEFORE UPDATE OF payment_id,amount,reason,after_sale_id ON refunds
        BEGIN SELECT RAISE(ABORT,'Refund identity is immutable'); END;
      PRAGMA user_version=15;`)
    const legacy = readFileSync(new URL('../../src/migrations/012-after-sales.sql', import.meta.url), 'utf8').split('CREATE TABLE after_sale_items')[0]!
    const [table, indexes] = legacy.split('CREATE UNIQUE INDEX after_sale_one_active')
    db.exec(table!.replace('CREATE TABLE after_sales (', 'CREATE TABLE after_sales_v15 ('))
    db.exec('INSERT INTO after_sales_v15 SELECT * FROM after_sales; DROP TABLE after_sales; ALTER TABLE after_sales_v15 RENAME TO after_sales;')
    db.exec('CREATE UNIQUE INDEX after_sale_one_active' + indexes)
  } finally { db.exec(`PRAGMA foreign_keys=${foreignKeys}`) }
}
