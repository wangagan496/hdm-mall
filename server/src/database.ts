import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SQLInputValue } from 'node:sqlite'
import { migrateAvatarPaths } from './migrations/005-avatar-path.ts'
import { backfillAudit } from './migrations/014-audit-backfill.ts'

export class Database {
  private connection: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.connection = new DatabaseSync(path)
    try {
      this.connection.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;')
      const version = this.one<{ user_version: number }>('PRAGMA user_version')!.user_version
      if (version === 0) this.connection.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'))
      else if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].includes(version)) throw new Error('Unsupported database version')
      if (version < 2) {
        this.connection.exec(`BEGIN IMMEDIATE;
        CREATE TABLE categories(id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES categories(id), source_key TEXT UNIQUE NOT NULL);
        CREATE TABLE product_categories(product_id TEXT PRIMARY KEY REFERENCES products(id), category_id TEXT NOT NULL REFERENCES categories(id));
        CREATE INDEX product_categories_category ON product_categories(category_id);
        CREATE INDEX orders_owner_state_created ON orders(owner_id,state,created DESC,id);
        PRAGMA user_version=2;
          COMMIT;`)
      }
      if (version < 3) {
        this.transaction(() => this.connection.exec(readFileSync(new URL('./migrations/003-inventory.sql', import.meta.url), 'utf8')))
      }
      if (version < 4) {
        this.transaction(() => this.connection.exec(readFileSync(new URL('./migrations/004-stock-adjustment.sql', import.meta.url), 'utf8')))
      }
      if (version < 5) this.transaction(() => migrateAvatarPaths(this.connection))
      if (version < 6) {
        this.transaction(() => this.connection.exec(readFileSync(new URL('./migrations/006-address-autosave.sql', import.meta.url), 'utf8')))
      }
      if (version < 7) {
        this.transaction(() => this.connection.exec(readFileSync(new URL('./migrations/007-payments.sql', import.meta.url), 'utf8')))
      }
      if (version < 8) {
        this.transaction(() => this.connection.exec(readFileSync(new URL('./migrations/008-order-cancellation.sql', import.meta.url), 'utf8')))
      }
      if (version < 9) {
        this.transaction(() => this.connection.exec(readFileSync(new URL('./migrations/009-cart-requests.sql', import.meta.url), 'utf8')))
      }
      if (version < 10) {
        this.transaction(() => this.connection.exec(readFileSync(new URL('./migrations/010-product-management.sql', import.meta.url), 'utf8')))
      }
      if (version < 11) {
        this.transaction(() => this.connection.exec(readFileSync(new URL('./migrations/011-product-stock-revision.sql', import.meta.url), 'utf8')))
      }
      if (version < 12) {
        // Rebuild referenced tables without rewriting child foreign keys to temporary names.
        this.connection.exec('PRAGMA foreign_keys=OFF')
        try {
          this.transaction(() => {
            this.connection.exec(readFileSync(new URL('./migrations/012-after-sales.sql', import.meta.url), 'utf8'))
            if (this.all('PRAGMA foreign_key_check').length) throw new Error('After-sale migration foreign key check failed')
          })
        } finally { this.connection.exec('PRAGMA foreign_keys=ON') }
      }
      if (version < 13) this.transaction(() => this.connection.exec(readFileSync(new URL('./migrations/013-account-lifecycle.sql', import.meta.url), 'utf8')))
      if (version < 14) this.transaction(() => {
        this.connection.exec(readFileSync(new URL('./migrations/014-audit-log.sql', import.meta.url), 'utf8'))
        backfillAudit(this)
      })
    } catch (error) {
      this.connection.close()
      throw error
    }
  }
  one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.connection.prepare(sql).get(...params) as T | undefined
  }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.connection.prepare(sql).all(...params) as T[]
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.connection.prepare(sql).run(...params)
  }
  transaction<T>(action: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.connection.exec('COMMIT')
      return result
    } catch (error) {
      this.connection.exec('ROLLBACK')
      throw error
    }
  }
  close() { this.connection.close() }
}
