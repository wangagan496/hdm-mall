import type { User } from './accounts.ts'
import type { Clock } from './clock.ts'
import type { Database } from './database.ts'
import { AppError, ensure } from './errors.ts'
import { IDENTITY_ENTRIES } from './identity-context/entries.ts'
import { parseIdentityLayout, parseIdentityLayoutUpdate, type Identity, type IdentityLayout } from './identity-context/generated.ts'

export function isAllowedIdentityLayout(identity: Identity, hiddenEntries: readonly string[]): boolean {
  const allowed = new Set(IDENTITY_ENTRIES[identity].filter(entry => !entry.locked).map(entry => entry.id))
  return new Set(hiddenEntries).size === hiddenEntries.length && hiddenEntries.every(entry => allowed.has(entry))
}

export class IdentityLayouts {
  private readonly db: Database
  private readonly clock: Clock

  constructor(db: Database, clock: Clock) {
    this.db = db
    this.clock = clock
  }

  get(user: User): IdentityLayout {
    const row = this.db.one<{ layout: string; revision: number }>(
      'SELECT layout,revision FROM identity_layouts WHERE user_id=? AND identity=?', user.id, user.identity)
    if (!row) return { identity: user.identity, hiddenEntries: [], revision: 0 }
    const layout = parseIdentityLayout(JSON.stringify({ identity: user.identity, hiddenEntries: JSON.parse(row.layout), revision: row.revision }))
    ensure(layout && isAllowedIdentityLayout(layout.identity, layout.hiddenEntries), 500, '入口配置无法读取')
    return layout
  }

  save(user: User, value: unknown): IdentityLayout {
    const update = parseIdentityLayoutUpdate(JSON.stringify(value) ?? '')
    if (!update || !isAllowedIdentityLayout(user.identity, update.hiddenEntries)) {
      throw new AppError(400, '入口无效或不能隐藏', 'INVALID_IDENTITY_LAYOUT')
    }
    return this.db.transaction(() => {
      const current = this.get(user)
      if (current.revision !== update.expectedRevision) {
        throw new AppError(409, '入口配置已更新，请重新加载再保存', 'IDENTITY_LAYOUT_CHANGED', current)
      }
      const revision = current.revision + 1
      ensure(Number.isSafeInteger(revision), 409, '入口配置已达最高版本')
      const hiddenEntries = [...update.hiddenEntries].sort()
      this.db.run(`INSERT INTO identity_layouts(user_id,identity,layout,revision,updated) VALUES(?,?,?,?,?)
        ON CONFLICT(user_id,identity) DO UPDATE SET layout=excluded.layout,revision=excluded.revision,updated=excluded.updated`,
      user.id, user.identity, JSON.stringify(hiddenEntries), revision, this.clock.now())
      return { identity: user.identity, hiddenEntries, revision }
    })
  }
}
