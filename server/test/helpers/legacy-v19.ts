import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

export function removeIdentitySchema(db: DatabaseSync) {
  if (db.prepare('PRAGMA user_version').get()!.user_version !== 20) return
  db.exec(`DROP TABLE identity_layouts; DROP TABLE user_identities; DROP TRIGGER users_role_read_only;
    ALTER TABLE sessions DROP COLUMN identity_revision; ALTER TABLE sessions DROP COLUMN identity;
    ALTER TABLE after_sale_actions DROP COLUMN acting_identity;
    ALTER TABLE order_cancel_actions DROP COLUMN acting_identity;
    CREATE TEMP TABLE original_audit_log AS SELECT * FROM audit_log; DROP TABLE audit_log;`)
  db.exec(readFileSync(new URL('../../src/migrations/014-audit-log.sql', import.meta.url), 'utf8'))
  db.exec('INSERT INTO audit_log SELECT * FROM original_audit_log ORDER BY id; DROP TABLE original_audit_log; PRAGMA user_version=19;')
}
