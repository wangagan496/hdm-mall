import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { Database } from './database.ts'
import { systemClock, type Clock } from './clock.ts'
import { AppError, ensure } from './errors.ts'
import { localAvatarPath } from './avatar.ts'

export interface User { id: string; account: string; nickname: string; role: 'buyer' | 'merchant'; profile: string }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export class Accounts {
  db: Database
  publicUrl: string
  readonly clock: Clock
  constructor(db: Database, publicUrl: string, clock: Clock = systemClock) {
    this.db = db; this.publicUrl = publicUrl.replace(/\/$/, ''); this.clock = clock
  }
  register(account: string, password: string, role: User['role'] = 'buyer') {
    const salt = randomBytes(16).toString('hex')
    const hash = scryptSync(password, salt, 64).toString('hex')
    const id = randomUUID()
    try { this.db.run('INSERT INTO users(id,account,password,nickname,role) VALUES(?,?,?,?,?)', id, account, `${salt}:${hash}`, account, role) }
    catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new AppError(409, '账号已存在')
      throw error
    }
    return { id }
  }
  login(account: string, password: string) {
    const user = this.db.one<User & { password: string }>('SELECT * FROM users WHERE account=?', account)
    const [salt, hash] = user?.password.split(':') ?? ['invalid-account-salt', '00'.repeat(64)]
    const valid = timingSafeEqual(scryptSync(password, salt!, 64), Buffer.from(hash!, 'hex'))
    ensure(user && valid, 401, '账号或密码不正确')
    const token = randomBytes(32).toString('hex')
    this.db.run('DELETE FROM sessions WHERE expires<?', this.clock.now())
    this.db.run('INSERT INTO sessions VALUES(?,?,?)', digest(token), user.id, this.clock.now() + 24 * 3600_000)
    return { ...this.profile(user), token }
  }
  authenticate(authorization: string | undefined): User {
    ensure(authorization && authorization.startsWith('Bearer '), 401, '请先登录')
    const user = this.db.one<User>('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.digest=? AND s.expires>?', digest(authorization.slice(7)), this.clock.now())
    ensure(user, 401, '登录已过期，请重新登录')
    return user
  }
  logout(authorization: string) { this.db.run('DELETE FROM sessions WHERE digest=?', digest(authorization.slice(7))) }
  profile(user: User) {
    const stored = JSON.parse(user.profile)
    const path = localAvatarPath(stored.avatar)
    return { avatar: '', birthday: '', cityCode: '', provinceCode: '', countyCode: '', gender: '未知', profession: '', fullLocation: '', mobile: '',
      ...stored, ...(path ? { avatar: this.publicUrl + path } : {}), id: user.id, account: user.account, nickname: user.nickname, role: user.role }
  }
  updateProfile(user: User, data: Record<string, string>) {
    const latest = this.db.one<User>('SELECT * FROM users WHERE id=?', user.id)!
    const profile = { ...JSON.parse(latest.profile), ...data }
    const path = localAvatarPath(profile.avatar)
    if (path) profile.avatar = path
    this.db.run('UPDATE users SET nickname=?, profile=? WHERE id=?', data.nickname ?? latest.nickname, JSON.stringify(profile), user.id)
    return this.profile({ ...latest, nickname: data.nickname ?? latest.nickname, profile: JSON.stringify(profile) })
  }
  relations(user: User) {
    return this.db.all('SELECT r.id,r.status,r.owner_id AS ownerId,r.friend_id AS friendId,u.account AS ownerAccount,f.account AS friendAccount FROM relations r JOIN users u ON u.id=r.owner_id JOIN users f ON f.id=r.friend_id WHERE (r.owner_id=? OR r.friend_id=?) AND r.status<>?', user.id, user.id, 'revoked')
  }
  relationsPage(user: User, page: number, pageSize: number, scope: 'all' | 'payer') {
    const where = scope === 'payer' ? "r.owner_id=? AND r.status='accepted'" : "(r.owner_id=? OR r.friend_id=?) AND r.status<>'revoked'"
    const params = scope === 'payer' ? [user.id] : [user.id, user.id]
    const counts = this.db.one<{ count: number }>(`SELECT COUNT(*) AS count FROM relations r WHERE ${where}`, ...params)!.count
    const offset = (page - 1) * pageSize
    const items = offset >= counts ? [] : this.db.all(`SELECT r.id,r.status,r.owner_id AS ownerId,r.friend_id AS friendId,
      u.account AS ownerAccount,f.account AS friendAccount FROM relations r
      JOIN users u ON u.id=r.owner_id JOIN users f ON f.id=r.friend_id WHERE ${where}
      ORDER BY r.created DESC,r.id COLLATE BINARY ASC LIMIT ? OFFSET ?`, ...params, pageSize, offset)
    return { items, counts, pages: Math.ceil(counts / pageSize), page, pageSize }
  }
  invite(user: User, account: string) {
    const friend = this.db.one<User>('SELECT * FROM users WHERE account=?', account)
    ensure(friend && friend.id !== user.id && friend.role === 'buyer', 400, '请输入其他买家账号')
    return this.db.transaction(() => {
      const existing = this.db.one<{ id: string; status: string }>('SELECT id,status FROM relations WHERE owner_id=? AND friend_id=?', user.id, friend.id)
      if (existing && existing.status !== 'revoked') return { id: existing.id }
      const id = randomUUID()
      if (existing) this.db.run('DELETE FROM relations WHERE id=?', existing.id)
      this.db.run('INSERT INTO relations VALUES(?,?,?,?,?)', id, user.id, friend.id, 'pending', this.clock.now())
      return { id }
    })
  }
  updateRelation(user: User, id: string, action: 'accept' | 'revoke') {
    const relation = this.db.one<{ owner_id: string; friend_id: string; status: string }>('SELECT * FROM relations WHERE id=?', id)
    ensure(relation, 404, '绑定请求不存在')
    if (action === 'accept') {
      ensure(relation.friend_id === user.id, 403, '只能由受邀亲友确认绑定')
      ensure(relation.status === 'pending', 409, '请求已处理')
    } else ensure(relation.owner_id === user.id || relation.friend_id === user.id, 403, '无权解除此关系')
    this.db.run('UPDATE relations SET status=? WHERE id=?', action === 'accept' ? 'accepted' : 'revoked', id)
    return { id }
  }
  bound(owner: string, friend: string): boolean {
    return !!this.db.one('SELECT id FROM relations WHERE owner_id=? AND friend_id=? AND status=?', owner, friend, 'accepted')
  }
  addresses(user: User) {
    return this.db.all<{ id: string; data: string }>('SELECT * FROM addresses WHERE user_id=?', user.id).map(row => ({ ...JSON.parse(row.data), id: row.id }))
  }
  saveAddress(user: User, data: Record<string, unknown>, id?: string, requestKey?: string, revision?: number) {
    return this.db.transaction(() => {
      ensure(requestKey ? Number.isSafeInteger(revision) && revision! > 0 : revision === undefined, 400, '自动保存需要编辑标识和正整数版本')
      const session = requestKey ? this.db.one<{ address_id: string; revision: number }>(
        'SELECT address_id,revision FROM address_save_sessions WHERE user_id=? AND request_key=?', user.id, requestKey) : undefined
      ensure(!id || !session || session.address_id === id, 409, '编辑标识已用于其他地址')
      const key = id ?? session?.address_id ?? (requestKey ? digest(`address:${user.id}:${requestKey}`) : randomUUID())
      ensure(!this.db.one('SELECT id FROM address_tombstones WHERE id=? AND user_id=?', key, user.id), 410, '地址已删除')
      const previous = this.db.one<{ data: string }>('SELECT data FROM addresses WHERE id=? AND user_id=?', key, user.id)
      ensure(!id || previous, 404, '地址不存在')
      // 先比较版本，再修改地址和默认标记；迟到或重复请求不产生写入。
      if (session && revision! <= session.revision) return { id: key }
      const merged = { fullLocation: '', provinceCode: 0, cityCode: 0, countyCode: 0, isDefault: 1, ...JSON.parse(previous?.data ?? '{}'), ...data }
      if (merged.isDefault === 0) {
        for (const address of this.addresses(user)) {
          this.db.run('UPDATE addresses SET data=? WHERE id=?', JSON.stringify({ ...address, isDefault: 1 }), address.id)
        }
      }
      this.db.run('INSERT INTO addresses VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', key, user.id, JSON.stringify(merged))
      if (requestKey) this.db.run(`INSERT INTO address_save_sessions VALUES(?,?,?,?)
        ON CONFLICT(user_id,request_key) DO UPDATE SET revision=excluded.revision`, user.id, requestKey, key, revision!)
      return { id: key }
    })
  }
  deleteAddress(user: User, id: string) {
    return this.db.transaction(() => {
      this.db.run('INSERT OR IGNORE INTO address_tombstones SELECT id,user_id FROM addresses WHERE id=? AND user_id=?', id, user.id)
      this.db.run('DELETE FROM addresses WHERE id=? AND user_id=?', id, user.id)
      return { id }
    })
  }
}
