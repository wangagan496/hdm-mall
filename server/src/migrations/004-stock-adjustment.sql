ALTER TABLE inventory_movements RENAME TO inventory_movements_v3;
CREATE TABLE inventory_movements (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 sku_id TEXT NOT NULL REFERENCES skus(id), order_id TEXT REFERENCES orders(id), actor_id TEXT REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('opening','reserve','cancel','expire','adjust')),
 delta INTEGER NOT NULL CHECK(typeof(delta)='integer'),
 balance INTEGER NOT NULL CHECK(typeof(balance)='integer' AND balance>=0),
 business_key TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, reason TEXT,
 CHECK((kind='opening' AND order_id IS NULL AND actor_id IS NULL AND delta>=0 AND reason IS NULL)
   OR (kind='reserve' AND order_id IS NOT NULL AND actor_id IS NOT NULL AND delta<0 AND reason IS NULL)
   OR (kind='cancel' AND order_id IS NOT NULL AND actor_id IS NOT NULL AND delta>0 AND reason IS NULL)
   OR (kind='expire' AND order_id IS NOT NULL AND actor_id IS NULL AND delta>0 AND reason IS NULL)
   OR (kind='adjust' AND order_id IS NULL AND actor_id IS NOT NULL AND delta<>0 AND reason IS NOT NULL AND length(trim(reason)) BETWEEN 5 AND 200))
);
INSERT INTO inventory_movements(id,sku_id,order_id,actor_id,kind,delta,balance,business_key,created)
 SELECT id,sku_id,order_id,actor_id,kind,delta,balance,business_key,created FROM inventory_movements_v3;
DROP TABLE inventory_movements_v3;
CREATE UNIQUE INDEX inventory_one_opening ON inventory_movements(sku_id) WHERE kind='opening';
CREATE UNIQUE INDEX inventory_one_reservation ON inventory_movements(order_id,sku_id) WHERE kind='reserve';
CREATE UNIQUE INDEX inventory_one_release ON inventory_movements(order_id,sku_id) WHERE kind IN ('cancel','expire');
CREATE INDEX inventory_sku_history ON inventory_movements(sku_id,id DESC);
CREATE TRIGGER inventory_no_update BEFORE UPDATE ON inventory_movements
 BEGIN SELECT RAISE(ABORT,'Inventory history is append-only'); END;
CREATE TRIGGER inventory_no_delete BEFORE DELETE ON inventory_movements
 BEGIN SELECT RAISE(ABORT,'Inventory history is append-only'); END;
PRAGMA user_version=4;
