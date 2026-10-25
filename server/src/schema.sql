BEGIN IMMEDIATE;
CREATE TABLE users (
 id TEXT PRIMARY KEY, account TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
 nickname TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'buyer' CHECK(role IN ('buyer','merchant')),
 profile TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE sessions (digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE relations (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), friend_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL CHECK(status IN ('pending','accepted','revoked')), created INTEGER NOT NULL,
 UNIQUE(owner_id,friend_id), CHECK(owner_id<>friend_id)
);
CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, picture TEXT NOT NULL, description TEXT NOT NULL);
CREATE TABLE skus (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), spec TEXT NOT NULL,
 price INTEGER NOT NULL CHECK(price>0), stock INTEGER NOT NULL CHECK(stock>=0)
);
CREATE TABLE carts (
 user_id TEXT NOT NULL REFERENCES users(id), sku_id TEXT NOT NULL REFERENCES skus(id),
 count INTEGER NOT NULL CHECK(count>0), selected INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(user_id,sku_id)
);
CREATE TABLE addresses (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL);
CREATE TABLE orders (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), state INTEGER NOT NULL CHECK(state BETWEEN 1 AND 6),
 amount INTEGER NOT NULL CHECK(amount>0), address TEXT NOT NULL, request_key TEXT NOT NULL, request_body TEXT NOT NULL,
 created INTEGER NOT NULL, expires INTEGER NOT NULL, invited_payer TEXT REFERENCES users(id),
 paid_by TEXT REFERENCES users(id), paid_at INTEGER, received_by TEXT REFERENCES users(id), received_at INTEGER,
 shipped_at INTEGER, UNIQUE(owner_id,request_key)
);
CREATE TABLE order_items (
 order_id TEXT NOT NULL REFERENCES orders(id), sku_id TEXT NOT NULL REFERENCES skus(id),
 product_id TEXT NOT NULL, name TEXT NOT NULL, picture TEXT NOT NULL, spec TEXT NOT NULL,
 price INTEGER NOT NULL, count INTEGER NOT NULL CHECK(count>0), PRIMARY KEY(order_id,sku_id)
);
CREATE TABLE evaluations (
 order_id TEXT PRIMARY KEY REFERENCES orders(id), score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
 content TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE INDEX order_owner ON orders(owner_id,created);
CREATE INDEX relation_friend ON relations(friend_id,status);
CREATE INDEX order_expiry ON orders(state,expires);
PRAGMA user_version=1;
COMMIT;
