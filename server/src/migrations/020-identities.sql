CREATE TABLE user_identities (
  user_id TEXT NOT NULL REFERENCES users(id),
  identity TEXT NOT NULL CHECK(identity IN ('buyer','merchant')),
  source TEXT NOT NULL CHECK(source IN ('migration-original','migration-extra','registration-default','configured-merchant')),
  granted_at INTEGER NOT NULL CHECK(typeof(granted_at)='integer' AND granted_at BETWEEN 0 AND 9007199254740991),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at BETWEEN granted_at+1 AND 9007199254740991)),
  PRIMARY KEY(user_id,identity,granted_at),
  CHECK((source NOT IN ('migration-extra','registration-default') OR identity='buyer')
    AND (source<>'configured-merchant' OR identity='merchant')
    AND (source<>'migration-original' OR granted_at=0))
);
CREATE UNIQUE INDEX user_identities_active ON user_identities(user_id,identity) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX user_identities_migration_original ON user_identities(user_id) WHERE source='migration-original';
CREATE UNIQUE INDEX user_identities_migration_extra ON user_identities(user_id) WHERE source='migration-extra';
CREATE TRIGGER user_identities_no_delete BEFORE DELETE ON user_identities
  BEGIN SELECT RAISE(ABORT,'identity grant history cannot be deleted'); END;
CREATE TRIGGER user_identities_revoke_only BEFORE UPDATE ON user_identities
  WHEN OLD.user_id IS NOT NEW.user_id OR OLD.identity IS NOT NEW.identity OR OLD.source IS NOT NEW.source
    OR OLD.granted_at IS NOT NEW.granted_at OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
  BEGIN SELECT RAISE(ABORT,'identity grants can only be revoked'); END;
CREATE TRIGGER users_role_read_only BEFORE UPDATE OF role ON users WHEN OLD.role IS NOT NEW.role
  BEGIN SELECT RAISE(ABORT,'legacy account role cannot be changed'); END;

ALTER TABLE sessions ADD COLUMN identity TEXT NOT NULL DEFAULT 'buyer' CHECK(identity IN ('buyer','merchant'));
ALTER TABLE sessions ADD COLUMN identity_revision INTEGER NOT NULL DEFAULT 0
  CHECK(typeof(identity_revision)='integer' AND identity_revision>=0 AND identity_revision<=9007199254740991);
UPDATE sessions SET identity=(SELECT role FROM users WHERE id=sessions.user_id);

CREATE TABLE identity_layouts (
  user_id TEXT NOT NULL REFERENCES users(id),
  identity TEXT NOT NULL CHECK(identity IN ('buyer','merchant')),
  layout TEXT NOT NULL CHECK(json_valid(layout)),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0 AND revision<=9007199254740991),
  updated INTEGER NOT NULL CHECK(typeof(updated)='integer' AND updated>=0 AND updated<=9007199254740991),
  PRIMARY KEY(user_id,identity)
);

ALTER TABLE after_sale_actions ADD COLUMN acting_identity TEXT CHECK(acting_identity IN ('buyer','merchant'));
UPDATE after_sale_actions SET acting_identity=(SELECT role FROM users WHERE id=after_sale_actions.actor_id);
ALTER TABLE order_cancel_actions ADD COLUMN acting_identity TEXT CHECK(acting_identity IN ('buyer','merchant'));
UPDATE order_cancel_actions SET acting_identity=(SELECT role FROM users WHERE id=order_cancel_actions.actor_id);

CREATE TABLE audit_log_v20 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created INTEGER NOT NULL CHECK(typeof(created)='integer' AND created>=0),
  actor_id TEXT REFERENCES users(id),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('merchant','buyer','system')),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK(target_type IN ('product','sku','order','after_sale','refund','payment','settings','account')),
  target_id TEXT NOT NULL,
  order_id TEXT REFERENCES orders(id),
  summary TEXT NOT NULL CHECK(json_valid(summary) AND json_type(summary)='object'),
  result TEXT NOT NULL CHECK(result IN ('success','denied')),
  request_key TEXT,
  CHECK((actor_kind='system' AND actor_id IS NULL) OR (actor_kind<>'system' AND actor_id IS NOT NULL))
);
INSERT INTO audit_log_v20 SELECT * FROM audit_log ORDER BY id;
DROP TABLE audit_log;
ALTER TABLE audit_log_v20 RENAME TO audit_log;
CREATE INDEX audit_log_time ON audit_log(created DESC,id DESC);
CREATE INDEX audit_log_order ON audit_log(order_id,created DESC,id DESC);
CREATE INDEX audit_log_target ON audit_log(target_type,target_id,created DESC);
CREATE INDEX audit_log_actor ON audit_log(actor_id,action,created DESC);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit log is append only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit log is append only'); END;
