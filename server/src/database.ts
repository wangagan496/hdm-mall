import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SQLInputValue } from 'node:sqlite'

export class Database {
  private connection: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.connection = new DatabaseSync(path)
    this.connection.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;')
    const version = this.one<{ user_version: number }>('PRAGMA user_version')!.user_version
    if (version === 0) this.connection.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'))
    else if (version !== 1) throw new Error('Unsupported database version')
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
