CREATE TABLE invoices (
 order_id TEXT PRIMARY KEY REFERENCES orders(id),
 title_type TEXT NOT NULL CHECK(title_type IN ('individual','company')),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
 tax_id TEXT NOT NULL DEFAULT '',
 email TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','issued')),
 number TEXT NOT NULL DEFAULT '',
 requested_at INTEGER NOT NULL,
 issued_at INTEGER,
 issued_by TEXT REFERENCES users(id),
 issue_key TEXT,
 CHECK(title_type<>'company' OR length(tax_id) BETWEEN 15 AND 20),
 CHECK((status='requested' AND issued_at IS NULL AND issued_by IS NULL AND issue_key IS NULL) OR
       (status='issued' AND issued_at IS NOT NULL AND issued_by IS NOT NULL AND issue_key IS NOT NULL))
);
CREATE TABLE review_moderation (
 order_id TEXT PRIMARY KEY REFERENCES evaluations(order_id),
 reason TEXT NOT NULL CHECK(reason IN ('广告','辱骂','无关内容','泄露隐私','其他')),
 hidden_at INTEGER NOT NULL,
 hidden_by TEXT NOT NULL REFERENCES users(id)
);
CREATE TABLE service_threads (
 buyer_id TEXT PRIMARY KEY REFERENCES users(id),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 buyer_read_id INTEGER NOT NULL DEFAULT 0 CHECK(buyer_read_id>=0),
 retain_until INTEGER
);
CREATE TABLE service_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 buyer_id TEXT NOT NULL REFERENCES service_threads(buyer_id),
 sender_id TEXT NOT NULL REFERENCES users(id),
 sender_kind TEXT NOT NULL CHECK(sender_kind IN ('buyer','merchant')),
 order_id TEXT REFERENCES orders(id),
 content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 500),
 created INTEGER NOT NULL,
 request_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(sender_id,request_key)
);
CREATE INDEX service_messages_thread ON service_messages(buyer_id,id);
CREATE INDEX service_messages_sender ON service_messages(buyer_id,sender_kind,id);
CREATE INDEX service_threads_updated ON service_threads(updated DESC,buyer_id);
CREATE TABLE service_images (
 image_id TEXT PRIMARY KEY,
 path TEXT NOT NULL UNIQUE,
 buyer_id TEXT NOT NULL REFERENCES users(id),
 uploader_id TEXT NOT NULL REFERENCES users(id),
 request_key TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 message_id INTEGER REFERENCES service_messages(id),
 created INTEGER NOT NULL,
 UNIQUE(uploader_id,request_key)
);
CREATE INDEX service_images_message ON service_images(message_id);
PRAGMA user_version=17;
