import { removeAfterSaleSchema } from './helpers/legacy-v11.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildApp } from '../src/app.ts'
import { createBackup, restoreBackup } from '../src/backup.ts'
import { Database } from '../src/database.ts'
import { localAvatarPath } from '../src/avatar.ts'

const password = 'avatar-portability-test'
const name = '00000000-0000-4000-8000-000000000001.jpg'
const path = `/uploads/${name}`
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])
const oldOrigin = 'https://old.example.test'
const newOrigin = 'https://new.example.test'

async function legacyFixture(root: string) {
  const data = join(root, 'live'), uploadsPath = join(data, 'uploads'), databasePath = join(data, 'mall.sqlite')
  await mkdir(uploadsPath, { recursive: true })
  await writeFile(join(uploadsPath, name), jpeg)
  const f = await buildApp({ databasePath, uploadsPath, publicUrl: oldOrigin, mockPayments: true })
  try {
    const user = f.accounts.register('legacy_buyer', password)
    f.db.run('UPDATE users SET profile=? WHERE id=?', JSON.stringify({ avatar: oldOrigin + path, profession: '测试职业', cityCode: '110100' }), user.id)
    // 版本 4 与 5 的表结构相同，构造版本 4 的绝对头像引用及版本标记。
    const legacy = new DatabaseSync(databasePath)
    try { removeAfterSaleSchema(legacy); legacy.exec('DROP TRIGGER product_revision_sku_update; DROP TRIGGER product_revision_sku_insert; DROP TRIGGER product_revision_fields; DROP INDEX product_enabled_spec; DROP TABLE product_changes; DROP TABLE product_images; ALTER TABLE skus DROP COLUMN enabled; ALTER TABLE products DROP COLUMN revision; ALTER TABLE products DROP COLUMN status; DROP TABLE cart_requests; DROP TABLE order_cancel_actions; DROP TABLE order_cancel_requests; DROP TABLE refund_retry_actions; DROP TABLE payment_review_resolutions; DROP TABLE payment_notices; DROP TABLE refunds; DROP TABLE payments; PRAGMA user_version=4') }
    finally { legacy.close() }
  } finally { await f.app.close() }
  return { databasePath, uploadsPath }
}

test('上传头像只持久保存相对路径，接口仍返回完整地址且备份恢复后跟随新服务地址', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-avatar-upload-'))
  const options = { databasePath: join(root, 'live', 'mall.sqlite'), uploadsPath: join(root, 'live', 'uploads'), publicUrl: oldOrigin, mockPayments: true }
  const f = await buildApp(options)
  try {
    const user = f.accounts.register('avatar_buyer', password)
    const login = f.accounts.login('avatar_buyer', password)
    const boundary = 'avatar-portability-boundary'
    const response = await f.app.inject({ method: 'POST', url: '/member/profile/avatar',
      headers: { authorization: `Bearer ${login.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), jpeg, Buffer.from(`\r\n--${boundary}--\r\n`)]) })
    assert.equal(response.statusCode, 200)
    const url = new URL(response.json().result.avatar)
    assert.equal(url.origin, oldOrigin)
    assert.equal(JSON.parse(f.db.one<{ profile: string }>('SELECT profile FROM users WHERE id=?', user.id)!.profile).avatar, url.pathname)
    const backup = await createBackup({ ...options, destination: join(root, 'backup') })
    const restored = await restoreBackup({ backupPath: backup.root, destination: join(root, 'restored') })
    const next = await buildApp({ databasePath: join(restored.root, 'mall.sqlite'), uploadsPath: join(restored.root, 'uploads'), publicUrl: newOrigin + '/', mockPayments: true })
    try {
      const loginResponse = await next.app.inject({ method: 'POST', url: '/login', payload: { account: 'avatar_buyer', password } })
      assert.equal(loginResponse.statusCode, 200)
      assert.equal(loginResponse.json().result.avatar, newOrigin + url.pathname)
      const image = await next.app.inject(url.pathname)
      assert.equal(image.statusCode, 200)
      assert.deepEqual(image.rawPayload, jpeg)
    } finally { await next.app.close() }
  } finally { await f.app.close(); await rm(root, { recursive: true, force: true }) }
})

test('旧版绝对头像随备份恢复迁移，登录读取和资料保存均返回新域名且原备份不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-avatar-legacy-'))
  try {
    const options = await legacyFixture(root)
    const backup = await createBackup({ ...options, destination: join(root, 'v4-backup') })
    assert.equal(backup.manifest.schemaVersion, 4)
    const original = await readFile(join(backup.root, 'mall.sqlite'))
    const restored = await restoreBackup({ backupPath: backup.root, destination: join(root, 'restored') })
    const nextOptions = { databasePath: join(restored.root, 'mall.sqlite'), uploadsPath: join(restored.root, 'uploads'), publicUrl: newOrigin, mockPayments: true }
    const next = await buildApp(nextOptions)
    try {
      const login = next.accounts.login('legacy_buyer', password)
      assert.equal(login.avatar, newOrigin + path)
      const headers = { authorization: `Bearer ${login.token}` }
      const profile = await next.app.inject({ url: '/member/profile', headers: { ...headers, host: 'untrusted.invalid', 'x-forwarded-host': 'untrusted.invalid' } })
      assert.equal(profile.json().result.avatar, newOrigin + path)
      assert.equal(profile.json().result.profession, '测试职业')
      const saved = await next.app.inject({ method: 'PUT', url: '/member/profile', headers, payload: {
        nickname: '迁移后昵称', gender: '未知', birthday: '', profession: '修改后职业', provinceCode: '110000', cityCode: '110100', countyCode: '', avatar: 'https://untrusted.invalid/replace.jpg'
      } })
      assert.equal(saved.statusCode, 200)
      assert.equal(saved.json().result.avatar, newOrigin + path)
      const stored = JSON.parse(next.db.one<{ profile: string }>('SELECT profile FROM users WHERE id=?', login.id)!.profile)
      assert.equal(stored.avatar, path)
      assert.equal(stored.profession, '修改后职业')
      assert.equal(next.db.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 19)
      const address = await next.app.listen({ host: '127.0.0.1', port: 0 })
      const httpProfile = await fetch(address + '/member/profile', { headers })
      assert.equal(httpProfile.status, 200)
      assert.equal((await httpProfile.json() as { result: { avatar: string } }).result.avatar, newOrigin + path)
      assert.deepEqual(Buffer.from(await (await fetch(address + path)).arrayBuffer()), jpeg)
    } finally { await next.app.close() }
    const restarted = await buildApp(nextOptions)
    try { assert.equal(restarted.accounts.login('legacy_buyer', password).avatar, newOrigin + path) }
    finally { await restarted.app.close() }
    assert.deepEqual(await readFile(join(backup.root, 'mall.sqlite')), original)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('外部头像和含跳转编码凭据的路径不迁移为本地引用，备份记录不支持的头像', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-avatar-paths-'))
  const invalid = ['https://external.example.test/portrait.png', `//external.example.test${path}`,
    `/uploads/../uploads/${name}`, `${oldOrigin}/unused/../uploads/${name}`, `${oldOrigin}${path}?`,
    `${oldOrigin}${path}?token=secret`, `${oldOrigin}${path}#`, `https://user:password@old.example.test${path}`,
    `/uploads/%30${name.slice(1)}`, `/uploads/\\${name}`, path + '/other.jpg', path + '\n']
  try {
    const options = await legacyFixture(root)
    const old = new DatabaseSync(options.databasePath)
    try {
      for (const [i, avatar] of invalid.entries()) {
        old.prepare('INSERT INTO users(id,account,password,nickname,role,profile) VALUES(?,?,?,?,?,?)')
          .run(`invalid-${i}`, `invalid-${i}`, 'unused', '不支持的旧头像', 'buyer', JSON.stringify({ avatar }))
      }
    } finally { old.close() }
    const db = new Database(options.databasePath)
    try {
      for (const [i, avatar] of invalid.entries()) {
        assert.equal(localAvatarPath(avatar), null, avatar)
        assert.equal(JSON.parse(db.one<{ profile: string }>('SELECT profile FROM users WHERE id=?', `invalid-${i}`)!.profile).avatar, avatar)
      }
      const backup = await createBackup({ ...options, destination: join(root, 'invalid-backup') })
      assert.deepEqual(backup.manifest.issues.filter(issue => issue.type === 'unsupported-avatar')
        .map(issue => issue.userId).sort(), invalid.map((_, i) => `invalid-${i}`).sort())
      await assert.rejects(restoreBackup({ backupPath: backup.root, destination: join(root, 'rejected-restore') }), /快照含不一致数据/)
    } finally { db.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('头像迁移中途失败时资料与版本一起回滚，修复后可重新迁移', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-avatar-rollback-'))
  try {
    const options = await legacyFixture(root)
    const old = new DatabaseSync(options.databasePath)
    try {
      old.exec("INSERT INTO users(id,account,password,nickname,role,profile) VALUES('invalid','invalid','unused','invalid','buyer','not-json')")
    } finally { old.close() }
    assert.throws(() => { const unexpected = new Database(options.databasePath); unexpected.close() })
    const check = new DatabaseSync(options.databasePath)
    try {
      assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 4)
      assert.equal(JSON.parse(String(check.prepare("SELECT profile FROM users WHERE account='legacy_buyer'").get()!.profile)).avatar, oldOrigin + path)
      check.exec("DELETE FROM users WHERE id='invalid'")
    } finally { check.close() }
    const recovered = new Database(options.databasePath)
    try {
      assert.equal(recovered.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 19)
      assert.equal(JSON.parse(recovered.one<{ profile: string }>("SELECT profile FROM users WHERE account='legacy_buyer'")!.profile).avatar, path)
    } finally { recovered.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
