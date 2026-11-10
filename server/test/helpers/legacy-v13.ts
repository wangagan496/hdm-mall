import type { DatabaseSync } from 'node:sqlite'
export function removeAuditSchema(db:DatabaseSync){
  if(!db.prepare("SELECT name FROM sqlite_master WHERE name='audit_log'").get())return
  db.exec('DROP TABLE IF EXISTS audit_log; PRAGMA user_version=13;')
}
