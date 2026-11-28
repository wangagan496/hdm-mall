-- 阶段5 花钱刹车：规则版本、在途占额与待买清单
CREATE TABLE spending_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL CHECK(version >= 1),
  monthly_budget_cents INTEGER CHECK(monthly_budget_cents IS NULL OR monthly_budget_cents > 0),
  per_order_limit_cents INTEGER CHECK(per_order_limit_cents IS NULL OR per_order_limit_cents > 0),
  cooldown_threshold_cents INTEGER CHECK(cooldown_threshold_cents IS NULL OR cooldown_threshold_cents > 0),
  cooldown_hours INTEGER CHECK(cooldown_hours IS NULL OR (cooldown_hours BETWEEN 1 AND 72)),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  request_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, version),
  UNIQUE(user_id, request_key)
);

-- 在途占额：订单创建时预留，付款成功转已花，取消/超时/退款释放
CREATE TABLE spending_reservations (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  month_key TEXT NOT NULL,
  cents INTEGER NOT NULL CHECK(cents > 0),
  rule_version INTEGER,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','released')),
  release_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 待买清单：达到冷静阈值时写入，确认前不产生订单
CREATE TABLE purchase_wishlist (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL,
  goods TEXT NOT NULL,
  address_id TEXT NOT NULL,
  expected_amount_cents INTEGER NOT NULL CHECK(expected_amount_cents > 0),
  quoted_total_cents INTEGER NOT NULL CHECK(quoted_total_cents > 0),
  promotion_revision INTEGER,
  rule_version INTEGER,
  return_policy_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(return_policy_confirmed IN (0,1)),
  expected_return_policy_token TEXT,
  cooldown_until INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK(status IN ('waiting','cancelled','confirmed','expired')),
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, request_key)
);

CREATE INDEX sr_user_month ON spending_reservations(user_id, month_key, state);
CREATE INDEX pw_user_status ON purchase_wishlist(user_id, status, cooldown_until);
PRAGMA user_version = 31;
