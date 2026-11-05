CREATE TABLE payments (
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES orders(id),
 payer_id TEXT NOT NULL REFERENCES users(id),
 amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
 state TEXT NOT NULL CHECK(state IN ('pending','succeeded','failed','closed')),
 created INTEGER NOT NULL,
 grace_deadline INTEGER NOT NULL,
 channel_paid_at INTEGER,
 closed_at INTEGER,
 callback_state TEXT CHECK(callback_state IS NULL OR callback_state IN ('success','fail','unknown','closed')),
 mismatch_count INTEGER NOT NULL DEFAULT 0 CHECK(mismatch_count>=0),
 query_count INTEGER NOT NULL DEFAULT 0 CHECK(query_count>=0),
 next_query_at INTEGER,
 last_query_at INTEGER,
 review_at INTEGER,
 CHECK((state='succeeded' AND channel_paid_at IS NOT NULL) OR state<>'succeeded')
);
CREATE UNIQUE INDEX payments_one_pending_per_order ON payments(order_id) WHERE state='pending';
CREATE INDEX payments_order_created ON payments(order_id,created,id);
CREATE INDEX payments_reconcile ON payments(state,next_query_at,grace_deadline);
CREATE TABLE refunds (
 id TEXT PRIMARY KEY,
 payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
 amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
 reason TEXT NOT NULL CHECK(reason IN ('late','duplicate','cancelled')),
 state TEXT NOT NULL CHECK(state IN ('pending','succeeded','failed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at INTEGER,
 created INTEGER NOT NULL,
 review_at INTEGER
);
CREATE INDEX refunds_retry ON refunds(state,next_attempt_at);
CREATE TABLE payment_notices (
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES orders(id),
 recipient_id TEXT NOT NULL REFERENCES users(id),
 payment_id TEXT REFERENCES payments(id),
 refund_id TEXT REFERENCES refunds(id),
 kind TEXT NOT NULL CHECK(kind IN ('refund','review')),
 created INTEGER NOT NULL,
 viewed_at INTEGER
);
CREATE INDEX payment_notices_unread ON payment_notices(recipient_id,viewed_at,order_id);
CREATE TABLE payment_review_resolutions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
 merchant_id TEXT NOT NULL REFERENCES users(id),
 request_key TEXT NOT NULL UNIQUE,
 outcome TEXT NOT NULL CHECK(outcome IN ('paid','unpaid')),
 paid_at INTEGER,
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 200),
 created INTEGER NOT NULL,
 CHECK((outcome='paid' AND paid_at IS NOT NULL) OR (outcome='unpaid' AND paid_at IS NULL))
);
CREATE TABLE refund_retry_actions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 refund_id TEXT NOT NULL REFERENCES refunds(id),
 merchant_id TEXT NOT NULL REFERENCES users(id),
 request_key TEXT NOT NULL UNIQUE,
 created INTEGER NOT NULL
);
CREATE INDEX refund_retry_actions_refund ON refund_retry_actions(refund_id,created);
INSERT INTO payments(id,order_id,payer_id,amount,state,created,grace_deadline,channel_paid_at)
 SELECT 'legacy:'||id,id,paid_by,amount,'succeeded',paid_at,paid_at,paid_at
 FROM orders WHERE paid_by IS NOT NULL ORDER BY id;
PRAGMA user_version=7;
