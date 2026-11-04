import type { DatabaseSync } from 'node:sqlite'
import { localAvatarPath } from '../avatar.ts'

// 调用者提供事务；迁移失败时资料和版本一起回滚，旧快照不受影响。
export function migrateAvatarPaths(db: DatabaseSync): void {
  for (const row of db.prepare('SELECT id,profile FROM users ORDER BY rowid').all()) {
    const profile: unknown = JSON.parse(String(row.profile))
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('账号资料格式无效，无法迁移头像')
    const data = profile as Record<string, unknown>
    const path = localAvatarPath(data.avatar)
    if (path && path !== data.avatar) {
      db.prepare('UPDATE users SET profile=? WHERE id=?').run(JSON.stringify({ ...data, avatar: path }), row.id!)
    }
  }
  db.exec('PRAGMA user_version=5')
}
