CREATE TABLE price_protection_policies (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version >= 1),
  merchant_id TEXT NOT NULL REFERENCES users(id),
  acting_identity TEXT NOT NULL CHECK(acting_identity = 'merchant'),
  window_days INTEGER NOT NULL CHECK(window_days BETWEEN 1 AND 90),
  budget_per_order_cents INTEGER NOT NULL CHECK(budget_per_order_cents > 0),
  total_budget_cents INTEGER NOT NULL CHECK(total_budget_cents >= budget_per_order_cents),
  announced_at INTEGER NOT NULL CHECK(announced_at > 0),
  effective_at INTEGER NOT NULL CHECK(effective_at > announced_at),
  request_key TEXT NOT NULL,
  UNIQUE(merchant_id, request_key)
);

CREATE TABLE price_protection_confirmations (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
  policy_id TEXT NOT NULL REFERENCES price_protection_policies(id),
  merchant_id TEXT NOT NULL REFERENCES users(id),
  acting_identity TEXT NOT NULL CHECK(acting_identity = 'merchant'),
  identity_subject TEXT NOT NULL CHECK(length(identity_subject) = 64),
  policy_hash TEXT NOT NULL CHECK(length(policy_hash) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  used_at INTEGER,
  CHECK(used_at IS NULL OR (used_at >= created_at AND used_at < expires_at))
);

CREATE TABLE price_protection_publications (
  receipt_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE REFERENCES price_protection_confirmations(token_hash),
  policy_id TEXT NOT NULL UNIQUE REFERENCES price_protection_policies(id),
  merchant_id TEXT NOT NULL REFERENCES users(id),
  acting_identity TEXT NOT NULL CHECK(acting_identity = 'merchant'),
  request_key TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  UNIQUE(merchant_id, request_key)
);

CREATE INDEX pp_merchant_version ON price_protection_policies(merchant_id, version);
CREATE INDEX pp_effective ON price_protection_publications(merchant_id, published_at);
PRAGMA user_version = 28;
