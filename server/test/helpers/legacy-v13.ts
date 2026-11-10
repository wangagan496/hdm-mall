import type { DatabaseSync } from 'node:sqlite'
import { removeReturnPolicySchema } from './legacy-v14.ts'
export function removeAuditSchema(db:DatabaseSync){
  removeReturnPolicySchema(db)
  if(!db.prepare("SELECT name FROM sqlite_master WHERE name='audit_log'").get())return
  db.exec('DROP TABLE IF EXISTS audit_log; PRAGMA user_version=13;')
}
