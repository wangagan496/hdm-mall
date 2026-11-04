CREATE TABLE IF NOT EXISTS address_save_sessions(
  user_id TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL,
  address_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY(user_id, request_key)
);
CREATE TABLE IF NOT EXISTS address_tombstones(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id)
);
PRAGMA user_version=6;
