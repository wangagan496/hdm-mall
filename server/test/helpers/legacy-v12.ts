import type { DatabaseSync } from 'node:sqlite'
export function removeLifecycleSchema(db:DatabaseSync){
 if(!db.prepare("SELECT name FROM sqlite_master WHERE name='consents'").get())return
 db.exec(`DROP TABLE consent_requests; DROP TABLE consents; DROP TABLE account_deletions; DROP TABLE account_notices; DROP TABLE account_file_deletions;
 DROP INDEX users_deletion_due; DROP INDEX orders_retention;
 ALTER TABLE users DROP COLUMN status; ALTER TABLE users DROP COLUMN deletion_requested_at;
 ALTER TABLE users DROP COLUMN deletion_due_at; ALTER TABLE users DROP COLUMN deleted_at;
 ALTER TABLE orders DROP COLUMN retain_until; ALTER TABLE orders DROP COLUMN personal_data_cleared_at;
 ALTER TABLE refunds DROP COLUMN completed_at; PRAGMA user_version=12;`)
}
