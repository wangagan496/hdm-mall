import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, access, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { buildApp } from '../src/app.ts'
import { createBackup, restoreBackup, verifyBackup } from '../src/backup.ts'

const run = promisify(execFile)
const password = 'backup-test-password'
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hdm-backup-'))
  const data = join(root, 'live')
  await mkdir(data)
  const databasePath = join(data, 'mall.sqlite'), uploadsPath = join(data, 'uploads')
  const appOptions = { databasePath, uploadsPath, publicUrl: 'http://127.0.0.1:3000', mockPayments: true }
  const context = await buildApp(appOptions)
  context.db.run('PRAGMA wal_autocheckpoint=0')
  context.accounts.register('backup_buyer', password)
  const user = context.accounts.login('backup_buyer', password)
  const auth = { authorization: `Bearer ${user.token}` }
  const authenticated = context.accounts.authenticate(auth.authorization)
  const avatar = async () => {
    const boundary = 'hdm-backup-test-boundary'
    const result = await context.app.inject({ method: 'POST', url: '/member/profile/avatar',
      headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
        jpeg, Buffer.from(`\r\n--${boundary}--\r\n`)]) })
    assert.equal(result.statusCode, 200)
    return new URL(result.json().result.avatar).pathname.slice('/uploads/'.length)
  }
  return { ...context, root, data, databasePath, uploadsPath, appOptions, user, auth, authenticated, avatar,
    backup: (name = 'backup') => createBackup({ databasePath, uploadsPath, destination: join(root, name) }),
    close: async () => { await context.app.close(); await rm(root, { recursive: true, force: true }) } }
}

test('在线 WAL 快照与头像恢复后，订单库存亲友一致，旧会话失效且可重新登录', async () => {
  const f = await fixture()
  try {
    const image = await f.avatar()
    f.accounts.register('backup_friend', password)
    const friend = f.accounts.login('backup_friend', password)
    const invitation = f.accounts.invite(f.authenticated, 'backup_friend')
    f.accounts.updateRelation(f.accounts.authenticate(`Bearer ${friend.token}`), invitation.id, 'accept')
    const address = f.accounts.saveAddress(f.authenticated, { receiver: '备份测试', contact: '13800000000', address: '仅测试', isDefault: 0 })
    const order = await f.app.inject({ method: 'POST', url: '/member/order', headers: f.auth,
      payload: { requestKey: randomUUID(), addressId: address.id, goods: [{ skuId: 'hdm-1-a', count: 2 }] } })
    assert.equal(order.statusCode, 200)
    const id = order.json().result.id as string
    assert.equal((await f.app.inject({ method: 'POST', url: `/member/order/${id}/mock-pay`, headers: f.auth,
      payload: { amountCents: 3800 } })).statusCode, 200)
    assert.ok((await stat(f.databasePath + '-wal')).size > 0)
    const snapshotTables = ['users', 'relations', 'products', 'skus', 'carts', 'addresses', 'orders', 'order_items', 'evaluations', 'categories', 'product_categories', 'inventory_movements']
    const expected = new Map(snapshotTables.map(table => [table, f.db.all(`SELECT * FROM ${table} ORDER BY rowid`)]))
    const started = performance.now()
    const backup = await f.backup()
    const backupMs = performance.now() - started
    assert.deepEqual(backup.manifest.files.map(file => file.path), ['mall.sqlite', `uploads/${image}`])
    assert.equal(backup.counts.orders, 1)
    f.accounts.logout(f.auth.authorization)
    f.accounts.updateProfile(f.authenticated, { nickname: '备份后修改' })
    const restoreStart = performance.now()
    const restored = await restoreBackup({ backupPath: backup.root, destination: join(f.root, 'restored') })
    const restoreMs = performance.now() - restoreStart
    assert.equal(restored.report.sessionPolicy, 'all-sessions-revoked')
    assert.equal(restored.report.counts.sessions, 0)
    const next = await buildApp({ ...f.appOptions, databasePath: join(restored.root, 'mall.sqlite'), uploadsPath: join(restored.root, 'uploads') })
    try {
      for (const table of snapshotTables) assert.deepEqual(next.db.all(`SELECT * FROM ${table} ORDER BY rowid`), expected.get(table), table)
      const address = await next.app.listen({ host: '127.0.0.1', port: 0 })
      assert.equal((await fetch(address + '/member/profile', { headers: f.auth })).status, 401)
      const login = await fetch(address + '/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: 'backup_buyer', password }) })
      assert.equal(login.status, 200)
      const loginBody = await login.json() as { result: { token: string; nickname: string } }
      assert.equal(loginBody.result.nickname, 'backup_buyer')
      const detail = await fetch(address + `/member/order/${id}`, { headers: { authorization: `Bearer ${loginBody.result.token}` } })
      assert.equal(detail.status, 200)
      const body = await detail.json() as { result: { orderState: number; payMoney: number } }
      assert.equal(body.result.orderState, 2)
      assert.equal(body.result.payMoney, 38)
      assert.equal(next.db.one<{ stock: number }>('SELECT stock FROM skus WHERE id=?', 'hdm-1-a')!.stock, 18)
      assert.deepEqual(Buffer.from(await (await fetch(address + `/uploads/${image}`)).arrayBuffer()), jpeg)
    } finally { await next.app.close() }
    assert.equal((await verifyBackup(backup.root)).counts.sessions, 2, '恢复不修改原备份')
    console.log(`RESTORE_DRILL orders=1 images=1 comparedTables=12 backupMs=${Math.round(backupMs)} restoreMs=${Math.round(restoreMs)} oldToken=401 login=200 detail=200 image=200`)
  } finally { await f.close() }
})

test('无头像时上传目录可不存在，未引用的旧图片不进入快照', async () => {
  const f = await fixture()
  try {
    const first = await f.backup('empty-images')
    assert.equal(first.manifest.files.length, 1)
    const old = await f.avatar(), current = await f.avatar()
    const second = await f.backup('current-image')
    assert.deepEqual(second.manifest.files.map(file => file.path), ['mall.sqlite', `uploads/${current}`])
    await access(join(f.uploadsPath, old))
  } finally { await f.close() }
})

test('源路径拼错不创建数据库，头像和库存不一致仍生成快照并需显式允许恢复', async () => {
  const f = await fixture()
  try {
    await assert.rejects(createBackup({ databasePath: join(f.data, 'missing.sqlite'), uploadsPath: f.uploadsPath,
      destination: join(f.root, 'missing-source') }), /ENOENT/)
    await assert.rejects(access(join(f.data, 'missing.sqlite')))
    const name = await f.avatar()
    await rm(join(f.uploadsPath, name))
    const missing = await f.backup('missing-image')
    assert.deepEqual(missing.manifest.issues, [{ type: 'missing-avatar', userId: f.user.id }])
    f.accounts.updateProfile(f.authenticated, { avatar: 'https://example.invalid/external.png' })
    const external = await f.backup('external-image')
    assert.deepEqual(external.manifest.issues, [{ type: 'unsupported-avatar', userId: f.user.id }])
    f.db.run('UPDATE skus SET stock=19 WHERE id=?', 'hdm-1-a')
    const inventory = await f.backup('inventory-mismatch')
    assert.deepEqual(inventory.manifest.issues, [
      { type: 'inventory-mismatch', skuId: 'hdm-1-a' }, { type: 'unsupported-avatar', userId: f.user.id },
    ])
    for (const [index, backup] of [missing, external, inventory].entries()) {
      await access(join(backup.root, 'mall.sqlite'))
      assert.deepEqual((await verifyBackup(backup.root)).manifest.issues, backup.manifest.issues)
      const destination = join(f.root, `restore-${index}`)
      await assert.rejects(restoreBackup({ backupPath: backup.root, destination }), /快照含不一致数据/)
      await assert.rejects(access(destination))
      const restored = await restoreBackup({ backupPath: backup.root, destination, allowInconsistent: true })
      assert.deepEqual(restored.report.issues, backup.manifest.issues)
      const db = new DatabaseSync(join(restored.root, 'mall.sqlite'))
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get()!.count, 1)
        assert.equal(db.prepare('SELECT stock FROM skus WHERE id=?').get('hdm-1-a')!.stock, index === 2 ? 19 : 20)
        const profile = JSON.parse(String(db.prepare('SELECT profile FROM users WHERE id=?').get(f.user.id)!.profile))
        assert.equal(profile.avatar, index === 0 ? `/uploads/${name}` : 'https://example.invalid/external.png')
      } finally { db.close() }
    }
  } finally { await f.close() }
})

test('已有目标、源目录内目标均被拒绝，不覆盖现有文件', async () => {
  const f = await fixture()
  try {
    const backup = await f.backup()
    const before = await readFile(join(backup.root, 'manifest.json'))
    await assert.rejects(f.backup(), /EEXIST/)
    await assert.rejects(createBackup({ databasePath: f.databasePath, uploadsPath: f.uploadsPath, destination: join(f.data, 'nested') }), /源数据/)
    await assert.rejects(restoreBackup({ backupPath: backup.root, destination: f.data }), /EEXIST/)
    await assert.rejects(restoreBackup({ backupPath: backup.root, destination: join(backup.root, 'nested') }), /源数据/)
    assert.deepEqual(await readFile(join(backup.root, 'manifest.json')), before)
    assert.equal(f.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM users')!.count, 1)
  } finally { await f.close() }
})

test('哈希损坏、漏图、路径穿越和额外 WAL 均阻止恢复', async () => {
  const f = await fixture()
  try {
    await f.avatar()
    const backup = await f.backup()
    const manifestPath = join(backup.root, 'manifest.json')
    const original = await readFile(manifestPath, 'utf8')
    for (const change of ['traversal', 'missing', 'duplicate', 'hash'] as const) {
      const manifest = JSON.parse(original)
      if (change === 'traversal') manifest.files[1].path = '../outside.jpg'
      if (change === 'missing') manifest.files.pop()
      if (change === 'duplicate') manifest.files.push(manifest.files[0])
      if (change === 'hash') manifest.files[0].sha256 = '0'.repeat(64)
      await writeFile(manifestPath, JSON.stringify(manifest))
      await assert.rejects(restoreBackup({ backupPath: backup.root, destination: join(f.root, change) }))
      await assert.rejects(access(join(f.root, change)))
    }
    await writeFile(manifestPath, original)
    await writeFile(join(backup.root, 'mall.sqlite-wal'), 'unexpected log')
    await assert.rejects(verifyBackup(backup.root), /日志/)
    await rm(join(backup.root, 'mall.sqlite-wal'))
    const image = backup.manifest.files[1]!.path
    await writeFile(join(backup.root, image), 'broken image')
    await assert.rejects(verifyBackup(backup.root), /校验失败/)
  } finally { await f.close() }
})

test('清单哈希匹配仍检查数据库版本、外键和头像引用，链接不能作为上传目录', async () => {
  const f = await fixture()
  try {
    const backup = await f.backup()
    const path = join(backup.root, 'mall.sqlite')
    const db = new DatabaseSync(path)
    try { db.exec('PRAGMA foreign_keys=OFF'); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('invalid', 'missing-user', Date.now()) }
    finally { db.close() }
    const data = await readFile(path)
    backup.manifest.files[0] = { path: 'mall.sqlite', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }
    await writeFile(join(backup.root, 'manifest.json'), JSON.stringify(backup.manifest))
    await assert.rejects(verifyBackup(backup.root), /外键/)
    for (const [name, sql, message] of [
      ['version', 'PRAGMA user_version=99', /版本/],
      ['reference', `UPDATE users SET profile='{"avatar":"http://127.0.0.1:3000/uploads/00000000-0000-4000-8000-000000000001.jpg"}'`, /头像引用/]
    ] as const) {
      const altered = await f.backup(name)
      const file = join(altered.root, 'mall.sqlite')
      const connection = new DatabaseSync(file)
      try { connection.exec(sql) } finally { connection.close() }
      const bytes = await readFile(file)
      altered.manifest.files[0] = { path: 'mall.sqlite', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      await writeFile(join(altered.root, 'manifest.json'), JSON.stringify(altered.manifest))
      await assert.rejects(verifyBackup(altered.root), message)
    }
    const valid = await f.backup('link-check')
    await rm(join(valid.root, 'uploads'), { recursive: true })
    const outside = join(f.root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(valid.root, 'uploads'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(verifyBackup(valid.root), /符号链接/)
  } finally { await f.close() }
})

test('命令行完成创建、校验和恢复；失败退出非零且不回显凭证', async () => {
  const f = await fixture()
  try {
    await f.avatar()
    const cli = fileURLToPath(new URL('../src/backup-cli.ts', import.meta.url))
    const destination = join(f.root, 'cli-backup'), restored = join(f.root, 'cli-restored')
    const commands = [
      ['create', '--database', f.databasePath, '--uploads', f.uploadsPath, '--out', destination],
      ['verify', '--from', destination], ['restore', '--from', destination, '--out', restored]
    ]
    for (const args of commands) {
      const { stdout } = await run(process.execPath, [cli, ...args])
      assert.equal(stdout.includes(password), false)
      assert.equal(stdout.includes(f.user.token), false)
      assert.ok(JSON.parse(stdout).status)
    }
    assert.equal(JSON.parse(await readFile(join(restored, 'restore-report.json'), 'utf8')).counts.sessions, 0)
    await assert.rejects(run(process.execPath, [cli, 'restore', '--from', destination, '--out', f.data]), (error: unknown) =>
      (error as { code: number }).code === 1)
    await assert.rejects(run(process.execPath, [cli, 'create', '--unknown']), (error: unknown) => (error as { code: number }).code === 1)
  } finally { await f.close() }
})

test('命令行保存不一致快照后非零退出，显式参数允许恢复且不能绕过哈希校验', async () => {
  const f = await fixture()
  try {
    f.db.run('UPDATE skus SET stock=19 WHERE id=?', 'hdm-1-a')
    const cli = fileURLToPath(new URL('../src/backup-cli.ts', import.meta.url))
    const destination = join(f.root, 'inconsistent-cli'), restored = join(f.root, 'restored-cli')
    await assert.rejects(run(process.execPath, [cli, 'create', '--database', f.databasePath, '--uploads', f.uploadsPath, '--out', destination]),
      (error: unknown) => {
        const result = error as { code: number; stderr: string; stdout: string }
        assert.equal(result.code, 1); assert.match(result.stderr, /快照含不一致数据/)
        assert.deepEqual(JSON.parse(result.stdout).issues, [{ type: 'inventory-mismatch', skuId: 'hdm-1-a' }])
        return true
      })
    await assert.rejects(run(process.execPath, [cli, 'restore', '--from', destination, '--out', restored]), /allow-inconsistent/)
    const result = await run(process.execPath, [cli, 'restore', '--from', destination, '--out', restored, '--allow-inconsistent'])
    assert.equal(JSON.parse(result.stdout).issues.length, 1)
    await writeFile(join(destination, 'mall.sqlite'), 'corrupt')
    await assert.rejects(restoreBackup({ backupPath: destination, destination: join(f.root, 'corrupt'), allowInconsistent: true }), /校验失败/)
  } finally { await f.close() }
})
