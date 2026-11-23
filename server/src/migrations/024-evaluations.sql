ALTER TABLE evaluations ADD COLUMN product_score INTEGER CHECK(product_score=score AND product_score BETWEEN 1 AND 5);
ALTER TABLE evaluations ADD COLUMN logistics_score INTEGER CHECK(logistics_score BETWEEN 1 AND 5);
ALTER TABLE evaluations ADD COLUMN service_score INTEGER CHECK(service_score BETWEEN 1 AND 5);
ALTER TABLE evaluations ADD COLUMN updated INTEGER;
ALTER TABLE evaluations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE evaluations ADD COLUMN public_id TEXT;
ALTER TABLE evaluations ADD COLUMN service_occurred INTEGER NOT NULL DEFAULT 0 CHECK(service_occurred IN (0,1));
UPDATE evaluations SET product_score=score,updated=created,public_id=lower(hex(randomblob(16))),
 service_occurred=EXISTS(SELECT 1 FROM after_sales a WHERE a.order_id=evaluations.order_id AND a.created<=evaluations.created);
CREATE UNIQUE INDEX evaluation_public_id ON evaluations(public_id);

CREATE TABLE evaluation_items (
 order_id TEXT NOT NULL REFERENCES evaluations(order_id), sku_id TEXT NOT NULL, field_id TEXT NOT NULL,
 template_version TEXT NOT NULL, receipt_id TEXT NOT NULL, label TEXT NOT NULL, value TEXT, quote TEXT NOT NULL,
 result TEXT NOT NULL CHECK(result IN ('matches','mismatch','unnoticed')), note TEXT NOT NULL,
 PRIMARY KEY(order_id,sku_id,field_id), FOREIGN KEY(order_id,sku_id) REFERENCES order_item_promise_snapshots(order_id,sku_id)
);
CREATE TABLE evaluation_revisions (
 order_id TEXT NOT NULL REFERENCES evaluations(order_id), revision INTEGER NOT NULL CHECK(revision>0),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), PRIMARY KEY(order_id,revision)
);
CREATE TABLE merchant_evaluation_replies (
 order_id TEXT PRIMARY KEY REFERENCES evaluations(order_id), actor_id TEXT NOT NULL REFERENCES users(id),
 content TEXT NOT NULL, created INTEGER NOT NULL
);

-- Inventory reservations also advance products.revision. Only listing changes retire the public review cohort.
ALTER TABLE products ADD COLUMN review_edition INTEGER NOT NULL DEFAULT 1;
ALTER TABLE order_items ADD COLUMN review_edition INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER review_edition_product AFTER UPDATE OF name,description,picture,status,category ON products
WHEN OLD.name IS NOT NEW.name OR OLD.description IS NOT NEW.description OR OLD.picture IS NOT NEW.picture
 OR OLD.status IS NOT NEW.status OR OLD.category IS NOT NEW.category
BEGIN UPDATE products SET review_edition=review_edition+1 WHERE id=NEW.id; END;
CREATE TRIGGER review_edition_sku AFTER UPDATE OF spec,price,enabled ON skus
WHEN OLD.spec IS NOT NEW.spec OR OLD.price IS NOT NEW.price OR OLD.enabled IS NOT NEW.enabled
BEGIN UPDATE products SET review_edition=review_edition+1 WHERE id=NEW.product_id; END;
CREATE TRIGGER freeze_review_edition AFTER INSERT ON order_items
BEGIN UPDATE order_items SET review_edition=(SELECT review_edition FROM products WHERE id=NEW.product_id)
 WHERE order_id=NEW.order_id AND sku_id=NEW.sku_id; END;
PRAGMA user_version=24;
