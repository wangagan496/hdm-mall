CREATE TABLE after_sales (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>0),
 requested_by TEXT NOT NULL REFERENCES users(id), payment_id TEXT NOT NULL REFERENCES payments(id),
 kind TEXT NOT NULL CHECK(kind IN ('return-no-reason','return-quality','refund-missing')),
 description TEXT NOT NULL CHECK(length(description)<=200 AND (kind='return-no-reason' OR length(trim(description))>=5)),
 state TEXT NOT NULL CHECK(state IN ('pending','awaiting-return','returned','refunding','refunded','rejected','withdrawn','closed','refund-rejected')),
 amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
 created INTEGER NOT NULL, review_deadline INTEGER NOT NULL CHECK(review_deadline=created+172800000),
 approved_at INTEGER, return_deadline INTEGER, returned_at INTEGER, inspect_deadline INTEGER,
 resolved_at INTEGER, resolved_by TEXT REFERENCES users(id),
 return_address TEXT CHECK(return_address IS NULL OR json_valid(return_address)),
 carrier TEXT, tracking_no TEXT, reject_reason TEXT,
 refund_id TEXT UNIQUE REFERENCES refunds(id),
 UNIQUE(order_id,sequence),
 CHECK(return_deadline IS NULL OR (approved_at IS NOT NULL AND return_deadline=approved_at+604800000)),
 CHECK(inspect_deadline IS NULL OR (returned_at IS NOT NULL AND inspect_deadline=returned_at+864000000)),
 CHECK((state='pending' AND approved_at IS NULL AND return_deadline IS NULL AND resolved_at IS NULL AND refund_id IS NULL)
 OR (state='awaiting-return' AND kind<>'refund-missing' AND approved_at IS NOT NULL AND return_deadline IS NOT NULL AND return_address IS NOT NULL AND returned_at IS NULL AND refund_id IS NULL AND resolved_at IS NULL)
 OR (state='returned' AND kind<>'refund-missing' AND return_address IS NOT NULL AND return_deadline IS NOT NULL AND returned_at IS NOT NULL AND inspect_deadline IS NOT NULL AND length(carrier)>0 AND length(tracking_no)>0 AND refund_id IS NULL AND resolved_at IS NULL)
 OR (state IN ('refunding','refunded') AND refund_id IS NOT NULL AND resolved_at IS NOT NULL AND approved_at IS NOT NULL)
 OR (state='closed' AND return_deadline IS NOT NULL AND returned_at IS NULL AND resolved_at IS NOT NULL AND refund_id IS NULL)
 OR (state='withdrawn' AND returned_at IS NULL AND resolved_at IS NOT NULL AND resolved_by=requested_by AND refund_id IS NULL)
 OR (state='rejected' AND approved_at IS NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND length(trim(reject_reason)) BETWEEN 5 AND 200 AND refund_id IS NULL)
 OR (state='refund-rejected' AND kind='return-no-reason' AND returned_at IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND length(trim(reject_reason)) BETWEEN 5 AND 200 AND refund_id IS NULL))
);
CREATE UNIQUE INDEX after_sale_one_active ON after_sales(order_id) WHERE state IN ('pending','awaiting-return','returned','refunding');
CREATE INDEX after_sale_due ON after_sales(state,review_deadline,return_deadline,inspect_deadline);
CREATE TABLE after_sale_items (
 after_sale_id TEXT NOT NULL REFERENCES after_sales(id), sku_id TEXT NOT NULL REFERENCES skus(id),
 count INTEGER NOT NULL CHECK(typeof(count)='integer' AND count>0),
 restock_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(restock_count)='integer' AND restock_count BETWEEN 0 AND count),
 PRIMARY KEY(after_sale_id,sku_id)
);
CREATE TABLE after_sale_images (
 image_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id),
 order_id TEXT NOT NULL REFERENCES orders(id), application_key TEXT NOT NULL,
 after_sale_id TEXT REFERENCES after_sales(id), request_key TEXT NOT NULL UNIQUE,
 sha256 TEXT NOT NULL CHECK(length(sha256)=64), path TEXT NOT NULL UNIQUE, created INTEGER NOT NULL
);
CREATE INDEX after_sale_images_application ON after_sale_images(actor_id,application_key);
CREATE TABLE after_sale_actions (
 id TEXT PRIMARY KEY, after_sale_id TEXT NOT NULL REFERENCES after_sales(id), actor_id TEXT REFERENCES users(id),
 action TEXT NOT NULL CHECK(action IN ('request','withdraw','approve','reject','ship-back','inspect','refund-reject','auto-approve','auto-refund','close')),
 request_key TEXT NOT NULL UNIQUE, request_body TEXT NOT NULL CHECK(json_valid(request_body)),
 result TEXT NOT NULL CHECK(json_valid(result)), created INTEGER NOT NULL,
 CHECK((action IN ('auto-approve','auto-refund','close') AND actor_id IS NULL AND request_key=action||':'||after_sale_id)
 OR (action NOT IN ('auto-approve','auto-refund','close') AND actor_id IS NOT NULL))
);
CREATE TABLE merchant_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), return_address TEXT NOT NULL CHECK(json_valid(return_address)),
 updated_by TEXT NOT NULL REFERENCES users(id), updated_at INTEGER NOT NULL
);
CREATE TABLE refunds_v12 (
 id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id),
 amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
 reason TEXT NOT NULL CHECK(reason IN ('late','duplicate','cancelled','after-sale')),
 after_sale_id TEXT UNIQUE REFERENCES after_sales(id),
 state TEXT NOT NULL CHECK(state IN ('pending','succeeded','failed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at INTEGER, created INTEGER NOT NULL, review_at INTEGER,
 CHECK((reason='after-sale' AND after_sale_id IS NOT NULL) OR (reason<>'after-sale' AND after_sale_id IS NULL))
);
INSERT INTO refunds_v12(id,payment_id,amount,reason,state,attempts,next_attempt_at,created,review_at)
 SELECT id,payment_id,amount,reason,state,attempts,next_attempt_at,created,review_at FROM refunds;
DROP TABLE refunds;
ALTER TABLE refunds_v12 RENAME TO refunds;
CREATE UNIQUE INDEX refunds_one_payment_reversal ON refunds(payment_id) WHERE reason IN ('late','duplicate','cancelled');
CREATE INDEX refunds_retry ON refunds(state,next_attempt_at);
CREATE TRIGGER refunds_amount_insert BEFORE INSERT ON refunds BEGIN
 SELECT CASE WHEN NEW.amount+COALESCE((SELECT SUM(amount) FROM refunds WHERE payment_id=NEW.payment_id),0)>(SELECT amount FROM payments WHERE id=NEW.payment_id)
 THEN RAISE(ABORT,'Refund exceeds payment') END;
END;
CREATE TRIGGER refunds_identity_update BEFORE UPDATE OF payment_id,amount,reason,after_sale_id ON refunds
 BEGIN SELECT RAISE(ABORT,'Refund identity is immutable'); END;
CREATE TABLE inventory_movements_v12 (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 sku_id TEXT NOT NULL REFERENCES skus(id), order_id TEXT REFERENCES orders(id), actor_id TEXT REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('opening','reserve','cancel','expire','adjust','return')),
 delta INTEGER NOT NULL CHECK(typeof(delta)='integer'),
 balance INTEGER NOT NULL CHECK(typeof(balance)='integer' AND balance>=0),
 business_key TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, reason TEXT,
 CHECK((kind='opening' AND order_id IS NULL AND actor_id IS NULL AND delta>=0 AND reason IS NULL)
 OR (kind='reserve' AND order_id IS NOT NULL AND actor_id IS NOT NULL AND delta<0 AND reason IS NULL)
 OR (kind='cancel' AND order_id IS NOT NULL AND actor_id IS NOT NULL AND delta>0 AND reason IS NULL)
 OR (kind='expire' AND order_id IS NOT NULL AND actor_id IS NULL AND delta>0 AND reason IS NULL)
 OR (kind='adjust' AND order_id IS NULL AND actor_id IS NOT NULL AND delta<>0 AND reason IS NOT NULL AND length(trim(reason)) BETWEEN 5 AND 200)
 OR (kind='return' AND order_id IS NOT NULL AND delta>0 AND reason IS NULL AND business_key LIKE 'return:%'))
);
INSERT INTO inventory_movements_v12 SELECT * FROM inventory_movements;
DROP TABLE inventory_movements;
ALTER TABLE inventory_movements_v12 RENAME TO inventory_movements;
CREATE UNIQUE INDEX inventory_one_opening ON inventory_movements(sku_id) WHERE kind='opening';
CREATE UNIQUE INDEX inventory_one_reservation ON inventory_movements(order_id,sku_id) WHERE kind='reserve';
CREATE UNIQUE INDEX inventory_one_release ON inventory_movements(order_id,sku_id) WHERE kind IN ('cancel','expire');
CREATE INDEX inventory_sku_history ON inventory_movements(sku_id,id DESC);
CREATE TRIGGER inventory_no_update BEFORE UPDATE ON inventory_movements
 BEGIN SELECT RAISE(ABORT,'Inventory history is append-only'); END;
CREATE TRIGGER inventory_no_delete BEFORE DELETE ON inventory_movements
 BEGIN SELECT RAISE(ABORT,'Inventory history is append-only'); END;
PRAGMA user_version=12;
