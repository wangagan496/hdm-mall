ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleting','deleted'));
ALTER TABLE users ADD COLUMN deletion_requested_at INTEGER;
ALTER TABLE users ADD COLUMN deletion_due_at INTEGER;
ALTER TABLE users ADD COLUMN deleted_at INTEGER;
ALTER TABLE orders ADD COLUMN retain_until INTEGER;
ALTER TABLE orders ADD COLUMN personal_data_cleared_at INTEGER;
ALTER TABLE refunds ADD COLUMN completed_at INTEGER;
CREATE TABLE consents (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), version TEXT NOT NULL,
 agreed_at INTEGER NOT NULL, source TEXT NOT NULL CHECK(source IN ('startup','login')),
 action TEXT NOT NULL CHECK(action IN ('agreed','withdrawn')), request_key TEXT NOT NULL UNIQUE,
 request_body TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE UNIQUE INDEX consents_agreed ON consents(user_id,version) WHERE action='agreed';
CREATE TABLE consent_requests (
 request_key TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 consent_id TEXT NOT NULL REFERENCES consents(id), request_body TEXT NOT NULL
);
CREATE TABLE account_deletions (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL CHECK(action IN ('request','cancel')),
 request_key TEXT NOT NULL UNIQUE,request_body TEXT NOT NULL,result TEXT NOT NULL,created INTEGER NOT NULL
);
CREATE TABLE account_notices (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),message TEXT NOT NULL,created INTEGER NOT NULL
);
CREATE TABLE account_file_deletions (path TEXT PRIMARY KEY,created INTEGER NOT NULL);
CREATE INDEX users_deletion_due ON users(status,deletion_due_at);
CREATE INDEX orders_retention ON orders(retain_until);
PRAGMA user_version=13;
