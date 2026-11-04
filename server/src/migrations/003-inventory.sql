CREATE TABLE inventory_movements (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 sku_id TEXT NOT NULL REFERENCES skus(id),
 order_id TEXT REFERENCES orders(id),
 actor_id TEXT REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('opening','reserve','cancel','expire')),
 delta INTEGER NOT NULL CHECK(typeof(delta)='integer'),
 balance INTEGER NOT NULL CHECK(typeof(balance)='integer' AND balance>=0),
 business_key TEXT NOT NULL UNIQUE,
 created INTEGER NOT NULL,
 CHECK((kind='opening' AND order_id IS NULL AND actor_id IS NULL AND delta>=0)
   OR (kind='reserve' AND order_id IS NOT NULL AND actor_id IS NOT NULL AND delta<0)
   OR (kind='cancel' AND order_id IS NOT NULL AND actor_id IS NOT NULL AND delta>0)
   OR (kind='expire' AND order_id IS NOT NULL AND actor_id IS NULL AND delta>0))
);
CREATE UNIQUE INDEX inventory_one_opening ON inventory_movements(sku_id) WHERE kind='opening';
CREATE UNIQUE INDEX inventory_one_reservation ON inventory_movements(order_id,sku_id) WHERE kind='reserve';
CREATE UNIQUE INDEX inventory_one_release ON inventory_movements(order_id,sku_id) WHERE kind IN ('cancel','expire');
CREATE INDEX inventory_sku_history ON inventory_movements(sku_id,id DESC);
-- 仅记录迁移时的实际可售库存，不编造迁移前的出入库历史。
INSERT INTO inventory_movements(sku_id,kind,delta,balance,business_key,created)
 SELECT id,'opening',stock,stock,'opening:'||id,CAST(unixepoch('subsec')*1000 AS INTEGER) FROM skus;
CREATE TRIGGER inventory_no_update BEFORE UPDATE ON inventory_movements
 BEGIN SELECT RAISE(ABORT,'Inventory history is append-only'); END;
CREATE TRIGGER inventory_no_delete BEFORE DELETE ON inventory_movements
 BEGIN SELECT RAISE(ABORT,'Inventory history is append-only'); END;
PRAGMA user_version=3;
