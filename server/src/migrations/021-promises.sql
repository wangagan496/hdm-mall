CREATE TABLE promise_model_calls (
 id TEXT PRIMARY KEY, purpose TEXT NOT NULL CHECK(purpose='extract-promises'), model TEXT NOT NULL,
 prompt_version TEXT NOT NULL, template_version TEXT NOT NULL,
 product_id TEXT NOT NULL REFERENCES products(id), actor_id TEXT NOT NULL REFERENCES users(id),
 product_revision INTEGER NOT NULL CHECK(product_revision>0), started_at INTEGER NOT NULL, finished_at INTEGER,
 token_count INTEGER CHECK(token_count IS NULL OR token_count>=0), reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens>0),
 provider_http_status INTEGER CHECK(provider_http_status BETWEEN 100 AND 599),
 provider_error_code TEXT CHECK(provider_error_code GLOB '[0-9][0-9][0-9][0-9]'),
 status TEXT NOT NULL CHECK(status IN ('pending','succeeded','partial','invalid','timeout','failed','quota-exhausted')),
 CHECK((status='pending' AND finished_at IS NULL AND token_count IS NULL) OR (status<>'pending' AND finished_at IS NOT NULL))
);
CREATE INDEX promise_calls_rate ON promise_model_calls(product_id,started_at);

CREATE TABLE promise_drafts (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), actor_id TEXT NOT NULL REFERENCES users(id),
 product_revision INTEGER NOT NULL CHECK(product_revision>0), template_version TEXT NOT NULL,
 model_call_id TEXT NOT NULL UNIQUE REFERENCES promise_model_calls(id),
 entries TEXT NOT NULL CHECK(json_valid(entries)), issues TEXT NOT NULL CHECK(json_valid(issues)),
 draft_hash TEXT NOT NULL CHECK(length(draft_hash)=64), created_at INTEGER NOT NULL
);
CREATE INDEX promise_product_drafts ON promise_drafts(product_id);

CREATE TABLE promise_confirmations (
 token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64), draft_id TEXT NOT NULL REFERENCES promise_drafts(id),
 actor_id TEXT NOT NULL REFERENCES users(id), acting_identity TEXT NOT NULL CHECK(acting_identity='merchant'),
 identity_subject TEXT NOT NULL CHECK(length(identity_subject)=64), product_id TEXT NOT NULL REFERENCES products(id),
 product_revision INTEGER NOT NULL CHECK(product_revision>0), draft_hash TEXT NOT NULL CHECK(length(draft_hash)=64),
 decisions TEXT NOT NULL CHECK(json_valid(decisions)), created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at), used_at INTEGER,
 CHECK(used_at IS NULL OR (used_at>=created_at AND used_at<expires_at))
);

CREATE TABLE promise_publications (
 receipt_id TEXT PRIMARY KEY, request_key TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE REFERENCES promise_confirmations(token_hash),
 draft_id TEXT NOT NULL UNIQUE REFERENCES promise_drafts(id), actor_id TEXT NOT NULL REFERENCES users(id),
 acting_identity TEXT NOT NULL CHECK(acting_identity='merchant'), product_id TEXT NOT NULL REFERENCES products(id),
 product_revision INTEGER NOT NULL CHECK(product_revision>0), template_version TEXT NOT NULL,
 entries TEXT NOT NULL CHECK(json_valid(entries)), published_at INTEGER NOT NULL,
 UNIQUE(actor_id,product_id,request_key)
);
CREATE INDEX promise_product_publications ON promise_publications(product_id);

CREATE TABLE order_item_promise_snapshots (
 order_id TEXT NOT NULL, sku_id TEXT NOT NULL, receipt_id TEXT NOT NULL REFERENCES promise_publications(receipt_id),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), PRIMARY KEY(order_id,sku_id),
 FOREIGN KEY(order_id,sku_id) REFERENCES order_items(order_id,sku_id)
);

CREATE TABLE order_promise_checks (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL, sku_id TEXT NOT NULL, field_id TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), acting_identity TEXT NOT NULL CHECK(acting_identity='buyer'),
 result TEXT NOT NULL CHECK(result IN ('matches','mismatch')), checked_at INTEGER NOT NULL,
 FOREIGN KEY(order_id,sku_id) REFERENCES order_item_promise_snapshots(order_id,sku_id)
);
CREATE INDEX promise_check_item_field ON order_promise_checks(order_id,sku_id,field_id);

CREATE TABLE after_sale_promise_links (
 after_sale_id TEXT PRIMARY KEY REFERENCES after_sales(id), check_id TEXT NOT NULL REFERENCES order_promise_checks(id)
);
PRAGMA user_version=21;
