import type { DatabaseSync } from 'node:sqlite'
import { isAllowedIdentityLayout } from './identity-layouts.ts'
import { parseIdentityLayout } from './identity-context/generated.ts'

export function historicalIdentity(db: DatabaseSync, version: number) {
  if (version < 20) {
    const legacy = db.prepare('SELECT 1 FROM users WHERE id=? AND role=?')
    return (id: unknown, identity: unknown, _at: unknown) =>
      typeof id === 'string' && (identity === 'buyer' || identity === 'merchant') && !!legacy.get(id, identity)
  }
  const grant = db.prepare(`SELECT 1 FROM user_identities WHERE user_id=? AND identity=? AND granted_at<=? AND (revoked_at IS NULL OR revoked_at>?)`)
  return (id: unknown, identity: unknown, at: unknown) =>
    typeof id === 'string' && (identity === 'buyer' || identity === 'merchant') &&
    typeof at === 'number' && Number.isSafeInteger(at) && !!grant.get(id, identity, at, at)
}

export function historicalOwnerIdentity(db: DatabaseSync) {
  // Legacy owners could act on their own purchases before merchant accounts gained a separate buyer identity.
  const legacy = db.prepare(`SELECT 1 FROM user_identities WHERE user_id=? AND source='migration-extra' AND granted_at>=?`)
  return (id: unknown, identity: unknown, at: unknown) => identity === 'buyer' ||
    (identity === 'merchant' && typeof id === 'string' && typeof at === 'number' && !!legacy.get(id, at))
}

export function inspectIdentities(db: DatabaseSync) {
  if (db.prepare(`SELECT id FROM users u WHERE NOT EXISTS (SELECT 1 FROM user_identities g WHERE g.user_id=u.id)`).get()) {
    throw new Error('账号缺少身份授予')
  }
  if (db.prepare(`SELECT g.user_id FROM user_identities g WHERE g.source='migration-extra' AND NOT EXISTS
    (SELECT 1 FROM user_identities original WHERE original.user_id=g.user_id AND original.identity='merchant'
      AND original.source='migration-original' AND original.granted_at<=g.granted_at)`).get()) {
    throw new Error('迁移新增买家身份缺少原商家身份')
  }
  if (db.prepare(`SELECT g.user_id FROM user_identities g WHERE g.identity='merchant' AND g.source='migration-original'
    AND NOT EXISTS (SELECT 1 FROM user_identities extra WHERE extra.user_id=g.user_id AND extra.source='migration-extra')`).get()) {
    throw new Error('迁移商家身份缺少新增买家身份')
  }
  if (db.prepare(`SELECT a.user_id FROM user_identities a JOIN user_identities b
    ON a.user_id=b.user_id AND a.identity=b.identity AND a.granted_at<b.granted_at
    WHERE a.revoked_at IS NULL OR a.revoked_at>b.granted_at`).get()) {
    throw new Error('同一身份的授予时间重叠')
  }
  if (db.prepare(`SELECT digest FROM sessions s WHERE NOT EXISTS
    (SELECT 1 FROM user_identities g WHERE g.user_id=s.user_id AND g.identity=s.identity)`).get()) {
    throw new Error('会话身份缺少授予记录')
  }
  const held = historicalIdentity(db, 20)
  for (const layout of db.prepare('SELECT * FROM identity_layouts').iterate()) {
    if (!held(layout.user_id, layout.identity, layout.updated)) throw new Error('首页配置的保存身份无效')
    const config = parseIdentityLayout(JSON.stringify({ identity: layout.identity, hiddenEntries: JSON.parse(String(layout.layout)), revision: layout.revision }))
    if (!config || !isAllowedIdentityLayout(config.identity, config.hiddenEntries)) throw new Error('首页配置入口无效')
  }
}
