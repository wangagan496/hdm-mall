CREATE INDEX IF NOT EXISTS skus_product_availability ON skus(product_id,enabled,stock,price);
CREATE INDEX IF NOT EXISTS categories_parent ON categories(parent_id);
PRAGMA user_version=19;
