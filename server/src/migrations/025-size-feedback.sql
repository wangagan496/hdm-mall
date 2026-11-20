ALTER TABLE evaluations ADD COLUMN size_fit TEXT CHECK(size_fit IN ('larger','true','smaller'));
ALTER TABLE evaluations ADD COLUMN size_shift TEXT CHECK(size_shift IS NULL OR
  (size_fit IS NOT NULL AND size_fit IN ('larger','smaller') AND size_shift IN ('half','full')));

-- Keep category eligibility at purchase, including after a catalog edit.
ALTER TABLE order_items ADD COLUMN size_category INTEGER NOT NULL DEFAULT 0 CHECK(size_category IN (0,1));
UPDATE order_items SET size_category=EXISTS(SELECT 1 FROM products p WHERE p.id=order_items.product_id AND p.category IN ('服饰','鞋靴'));
CREATE TRIGGER freeze_size_category AFTER INSERT ON order_items BEGIN
  UPDATE order_items SET size_category=EXISTS(SELECT 1 FROM products p WHERE p.id=NEW.product_id AND p.category IN ('服饰','鞋靴'))
    WHERE order_id=NEW.order_id AND sku_id=NEW.sku_id;
END;

-- An order can contain several shoe sizes with different fit feedback.
CREATE TABLE evaluation_sizes (
  order_id TEXT NOT NULL REFERENCES evaluations(order_id), sku_id TEXT NOT NULL,
  size_fit TEXT NOT NULL CHECK(size_fit IN ('larger','true','smaller')),
  size_shift TEXT CHECK(size_shift IS NULL OR (size_fit<>'true' AND size_shift IN ('half','full'))),
  PRIMARY KEY(order_id,sku_id), FOREIGN KEY(order_id,sku_id) REFERENCES order_item_promise_snapshots(order_id,sku_id)
);
CREATE VIEW required_evaluation_sizes AS SELECT i.order_id,i.sku_id FROM order_items i
  JOIN order_item_promise_snapshots s USING(order_id,sku_id)
  WHERE i.size_category=1 AND EXISTS(SELECT 1 FROM json_each(s.snapshot,'$.entries') f
    WHERE f.value->>'fieldId' IN ('size-chart','fit') AND f.value->>'status'='known');
PRAGMA user_version=25;
