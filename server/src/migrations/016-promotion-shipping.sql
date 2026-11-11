CREATE TABLE promotions (
 id INTEGER PRIMARY KEY CHECK(id=1),
 threshold INTEGER NOT NULL CHECK(typeof(threshold)='integer' AND threshold BETWEEN 1 AND 2147483647),
 discount INTEGER NOT NULL CHECK(typeof(discount)='integer' AND discount>0 AND discount<threshold),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0)
);
INSERT INTO promotions VALUES(1,9900,1000,1,1);
CREATE TABLE promotion_changes (
 request_key TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id),
 request_body TEXT NOT NULL CHECK(json_valid(request_body)),
 result TEXT NOT NULL CHECK(json_valid(result)), created INTEGER NOT NULL
);
ALTER TABLE orders ADD COLUMN discount INTEGER NOT NULL DEFAULT 0 CHECK(typeof(discount)='integer' AND discount>=0);
ALTER TABLE orders ADD COLUMN promotion TEXT CHECK(promotion IS NULL OR json_valid(promotion));
ALTER TABLE order_items ADD COLUMN discount_share INTEGER NOT NULL DEFAULT 0 CHECK(typeof(discount_share)='integer' AND discount_share BETWEEN 0 AND price*count);
ALTER TABLE after_sale_items ADD COLUMN discount_share INTEGER NOT NULL DEFAULT 0 CHECK(typeof(discount_share)='integer' AND discount_share>=0);
ALTER TABLE after_sales ADD COLUMN shipping_amount INTEGER CHECK(shipping_amount IS NULL OR (typeof(shipping_amount)='integer' AND shipping_amount BETWEEN 1 AND 10000));
ALTER TABLE after_sales ADD COLUMN shipping_image_id TEXT REFERENCES after_sale_images(image_id);
ALTER TABLE after_sales ADD COLUMN shipping_compensation INTEGER CHECK(shipping_compensation IS NULL OR (typeof(shipping_compensation)='integer' AND shipping_compensation BETWEEN 0 AND shipping_amount));
ALTER TABLE after_sales ADD COLUMN shipping_adjustment_reason TEXT;
ALTER TABLE after_sales ADD COLUMN shipping_refund_id TEXT REFERENCES refunds(id);
CREATE UNIQUE INDEX after_sales_shipping_refund ON after_sales(shipping_refund_id);
CREATE TABLE refunds_v16 (
 id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id),
 amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
 reason TEXT NOT NULL CHECK(reason IN ('late','duplicate','cancelled','after-sale','shipping')),
 after_sale_id TEXT REFERENCES after_sales(id),
 state TEXT NOT NULL CHECK(state IN ('pending','succeeded','failed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at INTEGER, created INTEGER NOT NULL, review_at INTEGER, completed_at INTEGER,
 CHECK((reason IN ('after-sale','shipping') AND after_sale_id IS NOT NULL) OR (reason NOT IN ('after-sale','shipping') AND after_sale_id IS NULL)),
 UNIQUE(after_sale_id,reason)
);
INSERT INTO refunds_v16 SELECT * FROM refunds;
DROP TABLE refunds;
ALTER TABLE refunds_v16 RENAME TO refunds;
CREATE UNIQUE INDEX refunds_one_payment_reversal ON refunds(payment_id) WHERE reason IN ('late','duplicate','cancelled');
CREATE INDEX refunds_retry ON refunds(state,next_attempt_at);
CREATE TRIGGER refunds_amount_insert BEFORE INSERT ON refunds WHEN NEW.reason<>'shipping' BEGIN
 SELECT CASE WHEN NEW.amount+COALESCE((SELECT SUM(amount) FROM refunds WHERE payment_id=NEW.payment_id AND reason<>'shipping'),0)>(SELECT amount FROM payments WHERE id=NEW.payment_id)
 THEN RAISE(ABORT,'Refund exceeds payment') END;
END;
CREATE TRIGGER refunds_shipping_insert BEFORE INSERT ON refunds WHEN NEW.reason='shipping' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM after_sales WHERE id=NEW.after_sale_id AND payment_id=NEW.payment_id AND shipping_compensation=NEW.amount)
 THEN RAISE(ABORT,'Shipping compensation mismatch') END;
END;
CREATE TRIGGER refunds_identity_update BEFORE UPDATE OF payment_id,amount,reason,after_sale_id ON refunds
 BEGIN SELECT RAISE(ABORT,'Refund identity is immutable'); END;
DROP TRIGGER refunds_shipping_insert;
CREATE TABLE after_sales_v16 (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>0),
 requested_by TEXT NOT NULL REFERENCES users(id), payment_id TEXT NOT NULL REFERENCES payments(id),
 kind TEXT NOT NULL CHECK(kind IN ('return-no-reason','return-quality','refund-missing')),
 description TEXT NOT NULL CHECK(length(description)<=200 AND (kind='return-no-reason' OR length(trim(description))>=5)),
 state TEXT NOT NULL CHECK(state IN ('pending','awaiting-return','returned','refunding','refunded','completed','rejected','withdrawn','closed','refund-rejected')),
 amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>=0), created INTEGER NOT NULL,
 review_deadline INTEGER NOT NULL CHECK(review_deadline=created+172800000), approved_at INTEGER,
 return_deadline INTEGER, returned_at INTEGER, inspect_deadline INTEGER, resolved_at INTEGER, resolved_by TEXT REFERENCES users(id),
 return_address TEXT CHECK(return_address IS NULL OR json_valid(return_address)), carrier TEXT, tracking_no TEXT, reject_reason TEXT,
 refund_id TEXT UNIQUE REFERENCES refunds(id),
 shipping_amount INTEGER CHECK(shipping_amount IS NULL OR (typeof(shipping_amount)='integer' AND shipping_amount BETWEEN 1 AND 10000)),
 shipping_image_id TEXT REFERENCES after_sale_images(image_id),
 shipping_compensation INTEGER CHECK(shipping_compensation IS NULL OR (typeof(shipping_compensation)='integer' AND shipping_compensation BETWEEN 0 AND shipping_amount)),
 shipping_adjustment_reason TEXT, shipping_refund_id TEXT REFERENCES refunds(id),
 UNIQUE(order_id,sequence),
 CHECK(return_deadline IS NULL OR (approved_at IS NOT NULL AND return_deadline=approved_at+604800000)),
 CHECK(inspect_deadline IS NULL OR (returned_at IS NOT NULL AND inspect_deadline=returned_at+864000000)),
 CHECK((state='pending' AND approved_at IS NULL AND return_deadline IS NULL AND resolved_at IS NULL AND refund_id IS NULL)
 OR (state='awaiting-return' AND kind<>'refund-missing' AND approved_at IS NOT NULL AND return_deadline IS NOT NULL AND return_address IS NOT NULL AND returned_at IS NULL AND refund_id IS NULL AND resolved_at IS NULL)
 OR (state='returned' AND kind<>'refund-missing' AND return_address IS NOT NULL AND return_deadline IS NOT NULL AND returned_at IS NOT NULL AND inspect_deadline IS NOT NULL AND length(carrier)>0 AND length(tracking_no)>0 AND refund_id IS NULL AND resolved_at IS NULL)
 OR (state IN ('refunding','refunded') AND refund_id IS NOT NULL AND resolved_at IS NOT NULL AND approved_at IS NOT NULL)
 OR (state='completed' AND amount=0 AND refund_id IS NULL AND resolved_at IS NOT NULL AND approved_at IS NOT NULL)
 OR (state='closed' AND return_deadline IS NOT NULL AND returned_at IS NULL AND resolved_at IS NOT NULL AND refund_id IS NULL)
 OR (state='withdrawn' AND returned_at IS NULL AND resolved_at IS NOT NULL AND resolved_by=requested_by AND refund_id IS NULL)
 OR (state='rejected' AND approved_at IS NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND length(trim(reject_reason)) BETWEEN 5 AND 200 AND refund_id IS NULL)
 OR (state='refund-rejected' AND kind='return-no-reason' AND returned_at IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND length(trim(reject_reason)) BETWEEN 5 AND 200 AND refund_id IS NULL))
);
INSERT INTO after_sales_v16 SELECT id,order_id,sequence,requested_by,payment_id,kind,description,state,amount,created,review_deadline,approved_at,return_deadline,returned_at,inspect_deadline,resolved_at,resolved_by,return_address,carrier,tracking_no,reject_reason,refund_id,shipping_amount,shipping_image_id,shipping_compensation,shipping_adjustment_reason,shipping_refund_id FROM after_sales;
DROP TABLE after_sales;
ALTER TABLE after_sales_v16 RENAME TO after_sales;
CREATE UNIQUE INDEX after_sale_one_active ON after_sales(order_id) WHERE state IN ('pending','awaiting-return','returned','refunding');
CREATE INDEX after_sale_due ON after_sales(state,review_deadline,return_deadline,inspect_deadline);
CREATE UNIQUE INDEX after_sales_shipping_refund ON after_sales(shipping_refund_id);
CREATE TRIGGER refunds_shipping_insert BEFORE INSERT ON refunds WHEN NEW.reason='shipping' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM after_sales WHERE id=NEW.after_sale_id AND payment_id=NEW.payment_id AND shipping_compensation=NEW.amount)
 THEN RAISE(ABORT,'Shipping compensation mismatch') END;
END;
PRAGMA user_version=16;
