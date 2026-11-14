ALTER TABLE payments ADD COLUMN channel_transaction_id TEXT;
ALTER TABLE refunds ADD COLUMN channel_refund_id TEXT;
CREATE UNIQUE INDEX payments_channel_reference ON payments(channel_transaction_id) WHERE channel_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX refunds_channel_reference ON refunds(channel_refund_id) WHERE channel_refund_id IS NOT NULL;
CREATE TABLE mock_channel_bill (
 kind TEXT NOT NULL CHECK(kind IN ('payment','refund')),
 business_id TEXT NOT NULL,
 channel_id TEXT NOT NULL UNIQUE,
 amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
 state TEXT NOT NULL CHECK(state IN ('pending','succeeded','failed')),
 occurred_at INTEGER NOT NULL CHECK(typeof(occurred_at)='integer' AND occurred_at>=0),
 PRIMARY KEY(kind,business_id)
);
CREATE INDEX mock_channel_bill_day ON mock_channel_bill(occurred_at);
CREATE TABLE reconciliation_runs (
 date TEXT PRIMARY KEY,
 state TEXT NOT NULL CHECK(state IN ('completed','failed')),
 checked_at INTEGER NOT NULL,
 next_retry_at INTEGER,
 summary TEXT NOT NULL CHECK(json_valid(summary))
);
CREATE TABLE reconciliation_differences (
 id TEXT PRIMARY KEY,
 date TEXT NOT NULL REFERENCES reconciliation_runs(date),
 kind TEXT NOT NULL CHECK(kind IN ('payment','refund')),
 business_id TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('channel-only','local-only','amount','state')),
 description TEXT NOT NULL,
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
 active INTEGER NOT NULL CHECK(active IN (0,1)),
 state TEXT NOT NULL CHECK(state IN ('pending','resolved')),
 reason TEXT,
 handled_by TEXT REFERENCES users(id),
 handled_at INTEGER,
 CHECK((state='pending' AND reason IS NULL AND handled_by IS NULL AND handled_at IS NULL) OR
   (state='resolved' AND length(trim(reason)) BETWEEN 5 AND 200 AND handled_by IS NOT NULL AND handled_at IS NOT NULL)),
 UNIQUE(date,kind,business_id,category)
);
CREATE INDEX reconciliation_differences_date ON reconciliation_differences(date,active,state);
ALTER TABLE orders ADD COLUMN signed_at INTEGER CHECK(signed_at IS NULL OR (typeof(signed_at)='integer' AND signed_at>=shipped_at));
CREATE TABLE shipments (
 order_id TEXT PRIMARY KEY REFERENCES orders(id),
 carrier TEXT NOT NULL CHECK(length(trim(carrier)) BETWEEN 2 AND 30),
 tracking_no TEXT NOT NULL CHECK(length(tracking_no) BETWEEN 6 AND 40),
 source TEXT NOT NULL CHECK(source IN ('mock','unavailable','carrier')),
 state TEXT NOT NULL CHECK(state IN ('waiting','collected','transit','delivering','signed')),
 created INTEGER NOT NULL CHECK(typeof(created)='integer' AND created>=0)
);
CREATE TABLE logistics_events (
 order_id TEXT NOT NULL REFERENCES shipments(order_id),
 id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('collected','transit','delivering','signed')),
 occurred_at INTEGER NOT NULL CHECK(typeof(occurred_at)='integer' AND occurred_at>=0),
 description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 200),
 PRIMARY KEY(order_id,id),
 UNIQUE(order_id,state,occurred_at,description)
);
CREATE INDEX logistics_events_time ON logistics_events(order_id,occurred_at,id);
PRAGMA user_version=18;
