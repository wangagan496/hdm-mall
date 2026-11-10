CREATE TABLE audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 created INTEGER NOT NULL CHECK(typeof(created)='integer' AND created>=0),
 actor_id TEXT REFERENCES users(id),
 actor_kind TEXT NOT NULL CHECK(actor_kind IN ('merchant','buyer','system')),
 action TEXT NOT NULL,
 target_type TEXT NOT NULL CHECK(target_type IN ('product','sku','order','after_sale','refund','payment','settings')),
 target_id TEXT NOT NULL,
 order_id TEXT REFERENCES orders(id),
 summary TEXT NOT NULL CHECK(json_valid(summary) AND json_type(summary)='object'),
 result TEXT NOT NULL CHECK(result IN ('success','denied')),
 request_key TEXT,
 CHECK((actor_kind='system' AND actor_id IS NULL) OR (actor_kind<>'system' AND actor_id IS NOT NULL))
);
CREATE INDEX audit_log_time ON audit_log(created DESC,id DESC);
CREATE INDEX audit_log_order ON audit_log(order_id,created DESC,id DESC);
CREATE INDEX audit_log_target ON audit_log(target_type,target_id,created DESC);
CREATE INDEX audit_log_actor ON audit_log(actor_id,action,created DESC);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit log is append only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit log is append only'); END;
PRAGMA user_version=14;
