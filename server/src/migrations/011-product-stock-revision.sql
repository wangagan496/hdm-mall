-- Stock changes are guarded separately by expectedStock; buyer reservations must not stale merchant edits.
DROP TRIGGER product_revision_sku_update;
CREATE TRIGGER product_revision_sku_update AFTER UPDATE OF spec,price,enabled ON skus
WHEN OLD.spec IS NOT NEW.spec OR OLD.price IS NOT NEW.price OR OLD.enabled IS NOT NEW.enabled
BEGIN UPDATE products SET revision=revision+1 WHERE id=NEW.product_id; END;
PRAGMA user_version=11;
