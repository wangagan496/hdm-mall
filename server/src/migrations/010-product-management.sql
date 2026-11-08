ALTER TABLE products ADD COLUMN status TEXT NOT NULL DEFAULT 'on' CHECK(status IN ('on','off'));
ALTER TABLE products ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE skus ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1));
CREATE UNIQUE INDEX product_enabled_spec ON skus(product_id,spec) WHERE enabled=1;
CREATE TABLE product_images (
 image_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
 sha256 TEXT NOT NULL, path TEXT NOT NULL UNIQUE, product_id TEXT REFERENCES products(id), created INTEGER NOT NULL,
 UNIQUE(actor_id,request_key)
);
CREATE TABLE product_changes (
 actor_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('create','edit')),
 product_id TEXT NOT NULL REFERENCES products(id), request_body TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL,
 PRIMARY KEY(actor_id,request_key)
);
-- 任意库存路径（预占、释放、盘点、商品编辑）都使旧商品表单过期。
CREATE TRIGGER product_revision_sku_update AFTER UPDATE OF spec,price,stock,enabled ON skus
WHEN OLD.spec IS NOT NEW.spec OR OLD.price IS NOT NEW.price OR OLD.stock IS NOT NEW.stock OR OLD.enabled IS NOT NEW.enabled
BEGIN UPDATE products SET revision=revision+1 WHERE id=NEW.product_id; END;
CREATE TRIGGER product_revision_sku_insert AFTER INSERT ON skus
BEGIN UPDATE products SET revision=revision+1 WHERE id=NEW.product_id; END;
CREATE TRIGGER product_revision_fields AFTER UPDATE OF name,description,picture,status ON products
WHEN OLD.name IS NOT NEW.name OR OLD.description IS NOT NEW.description OR OLD.picture IS NOT NEW.picture OR OLD.status IS NOT NEW.status
BEGIN UPDATE products SET revision=revision+1 WHERE id=NEW.id; END;
PRAGMA user_version=10;
