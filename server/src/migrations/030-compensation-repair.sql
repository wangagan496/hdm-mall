-- 修复 4B 草稿重算唯一索引、条件指纹绑定与雷达/余额聚合索引
CREATE TABLE compensation_drafts_v30 (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  policy_id TEXT NOT NULL REFERENCES price_protection_policies(id),
  price_event_id TEXT NOT NULL REFERENCES price_events(id),
  merchant_id TEXT NOT NULL REFERENCES users(id),
  buyer_id TEXT NOT NULL REFERENCES users(id),
  basket_delta_cents INTEGER NOT NULL CHECK(basket_delta_cents > 0),
  capped_cents INTEGER NOT NULL CHECK(capped_cents > 0),
  per_line JSON NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','pending_budget','confirmed','expired','cancelled')),
  condition_hash TEXT
);

INSERT INTO compensation_drafts_v30(
  id,order_id,policy_id,price_event_id,merchant_id,buyer_id,
  basket_delta_cents,capped_cents,per_line,idempotency_key,created_at,expires_at,status,condition_hash
)
SELECT
  id,order_id,policy_id,price_event_id,merchant_id,buyer_id,
  basket_delta_cents,capped_cents,per_line,idempotency_key,created_at,expires_at,status,NULL
FROM compensation_drafts;

DROP TABLE compensation_drafts;
ALTER TABLE compensation_drafts_v30 RENAME TO compensation_drafts;

-- 仅对非 cancelled 草稿保持单幂等键唯一，允许条件变化撤销旧草稿后用同一事件重建新草稿
CREATE UNIQUE INDEX cd_idempotency_live ON compensation_drafts(idempotency_key) WHERE status <> 'cancelled';
CREATE INDEX cd_buyer_status ON compensation_drafts(buyer_id, status, expires_at);
CREATE INDEX cd_order_active ON compensation_drafts(order_id, status, expires_at, capped_cents) WHERE status IN ('pending','pending_budget');
CREATE INDEX cd_expiring ON compensation_drafts(expires_at) WHERE status IN ('pending','pending_budget');

-- 订单与活动余额统计覆盖索引（equality-before-range + partial filter）
CREATE INDEX cr_order_active ON compensation_receipts(order_id, confirmed_cents) WHERE channel_status <> 'failed';
CREATE INDEX cr_policy_active ON compensation_receipts(policy_id, confirmed_cents) WHERE channel_status <> 'failed';

-- 降价雷达扫描窗口期内已付款订单覆盖局部索引（免回表且消除 ORDER BY 临时 B-Tree）
CREATE INDEX orders_paid_radar ON orders(paid_at, id, owner_id, amount) WHERE state IN (2,3,4,5) AND paid_at IS NOT NULL;
CREATE INDEX ppp_effective ON price_protection_policies(effective_at, id);

CREATE TABLE compensation_radar_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  last_scan_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO compensation_radar_state(id, last_scan_at) VALUES(1, 0);

PRAGMA user_version = 30;
