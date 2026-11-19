import type { DatabaseSync } from 'node:sqlite'

export function removePromiseSchema(db: DatabaseSync) {
  if (db.prepare('PRAGMA user_version').get()!.user_version !== 21) return
  db.exec(`DROP TABLE after_sale_promise_links; DROP TABLE order_promise_checks; DROP TABLE order_item_promise_snapshots;
    DROP TABLE promise_publications; DROP TABLE promise_confirmations; DROP TABLE promise_drafts; DROP TABLE promise_model_calls;
    PRAGMA user_version=20;`)
}
