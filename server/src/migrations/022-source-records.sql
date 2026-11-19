CREATE TABLE product_source_batches (
 product_id TEXT PRIMARY KEY REFERENCES products(id),
 batch TEXT NOT NULL CHECK(length(batch) BETWEEN 1 AND 40)
);

CREATE TABLE source_materials (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
 kind TEXT NOT NULL CHECK(kind IN ('batch-note','authorization','inspection-report')),
 batch TEXT NOT NULL CHECK(length(batch) BETWEEN 1 AND 40), version INTEGER NOT NULL CHECK(version>0),
 product_name TEXT NOT NULL CHECK(length(product_name) BETWEEN 1 AND 100),
 valid_from INTEGER NOT NULL CHECK(valid_from>=0), valid_until INTEGER NOT NULL CHECK(valid_until>valid_from),
 summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 400),
 actor_id TEXT NOT NULL REFERENCES users(id), acting_identity TEXT NOT NULL CHECK(acting_identity='merchant'),
 uploaded_at INTEGER NOT NULL, withdrawn_at INTEGER CHECK(withdrawn_at>=uploaded_at),
 request_key TEXT NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 attachment BLOB NOT NULL CHECK(length(attachment) BETWEEN 3 AND 524288),
 verification_status TEXT NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('provided','pending','verified','unverifiable')),
 verifier_id TEXT REFERENCES users(id), verified_at INTEGER CHECK(verified_at>=uploaded_at),
 verification_basis TEXT CHECK(length(trim(verification_basis)) BETWEEN 1 AND 400),
 CHECK((verification_status='verified' AND verifier_id IS NOT NULL AND verified_at IS NOT NULL AND verification_basis IS NOT NULL)
    OR (verification_status<>'verified' AND verifier_id IS NULL AND verified_at IS NULL AND verification_basis IS NULL)),
 UNIQUE(product_id,kind,batch,version), UNIQUE(actor_id,request_key)
);

CREATE TABLE order_item_source_records (
 order_id TEXT NOT NULL, sku_id TEXT NOT NULL, field_id TEXT NOT NULL,
 material_id TEXT NOT NULL REFERENCES source_materials(id),
 order_batch TEXT, snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
 PRIMARY KEY(order_id,sku_id,field_id),
 FOREIGN KEY(order_id,sku_id) REFERENCES order_item_promise_snapshots(order_id,sku_id)
);
PRAGMA user_version=22;
