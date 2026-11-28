-- 价格事件表：记录商品/SKU 价格变化及来源
CREATE TABLE price_events (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES users(id),
  goods_id TEXT NOT NULL,
  sku_id TEXT,
  old_price_cents INTEGER NOT NULL CHECK(old_price_cents > 0),
  new_price_cents INTEGER NOT NULL CHECK(new_price_cents > 0),
  promotion_rule_id TEXT,
  observed_at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('merchant_edit','promotion_add','promotion_remove','promotion_change')),
  CHECK(new_price_cents < old_price_cents)
);

-- 补差草稿表：雷达生成，买家确认前只读
CREATE TABLE compensation_drafts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  policy_id TEXT NOT NULL REFERENCES price_protection_policies(id),
  price_event_id TEXT NOT NULL REFERENCES price_events(id),
  merchant_id TEXT NOT NULL REFERENCES users(id),
  buyer_id TEXT NOT NULL REFERENCES users(id),
  basket_delta_cents INTEGER NOT NULL CHECK(basket_delta_cents > 0),
  capped_cents INTEGER NOT NULL CHECK(capped_cents > 0),
  per_line JSON NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','pending_budget','confirmed','expired','cancelled'))
);

-- 补差回执表：买家确认后写入
CREATE TABLE compensation_receipts (
  receipt_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL UNIQUE REFERENCES compensation_drafts(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  policy_id TEXT NOT NULL REFERENCES price_protection_policies(id),
  buyer_id TEXT NOT NULL REFERENCES users(id),
  confirmed_cents INTEGER NOT NULL CHECK(confirmed_cents > 0),
  request_key TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL,
  channel_status TEXT NOT NULL DEFAULT 'pending' CHECK(channel_status IN ('pending','executed','failed','unknown')),
  channel_ref TEXT,
  UNIQUE(order_id, request_key)
);

CREATE INDEX pe_merchant_goods ON price_events(merchant_id, goods_id, observed_at);
CREATE INDEX cd_buyer_status ON compensation_drafts(buyer_id, status, expires_at);
CREATE INDEX cr_order ON compensation_receipts(order_id, confirmed_at);
PRAGMA user_version = 29;
