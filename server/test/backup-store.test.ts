import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as Stores from '../src/backup-store.ts'
import { buildApp } from '../src/app.ts'
import { restoreBackup } from '../src/backup.ts'

test('B4 LocalDirectoryStore可写列读删、拒绝路径穿越，下载最新快照并隔离恢复', async () => {
  assert.equal(typeof Stores.LocalDirectoryStore, 'function')
  const root = await mkdtemp(join(tmpdir(), 'hdm-object-store-'))
  const store = new Stores.LocalDirectoryStore(join(root, 'objects'))
  let context: Awaited<ReturnType<typeof buildApp>> | undefined
  try {
    await store.put('probe/hello.txt', Buffer.from('hello'))
    assert.equal(Buffer.from(await store.get('probe/hello.txt')).toString(), 'hello')
    assert.deepEqual(await store.list('probe/'), [{ key: 'probe/hello.txt', size: 5 }])
    await store.delete('probe/hello.txt')
    assert.equal((await store.list('probe/')).length, 0)
    await assert.rejects(store.put('../escape', Buffer.from('no')))
    await assert.rejects(store.put('.. /escape', Buffer.from('no')))
    await assert.rejects(store.get('/absolute'))
    let now = Date.UTC(2026, 10, 11)
    context = await buildApp({ databasePath: join(root, 'data', 'mall.sqlite'), uploadsPath: join(root, 'uploads'), publicUrl: 'http://localhost', mockPayments: true,
      clock: { now: () => now }, backup: { store, stagingPath: join(root, 'staging') } })
    now += 3600_000
    await context.backups!.tick()
    const downloaded = await Stores.downloadLatestBackup(store, join(root, 'downloaded'))
    assert.ok(downloaded.key.includes(String(now)))
    const restored = await restoreBackup({ backupPath: downloaded.root, destination: join(root, 'restored') })
    assert.equal(restored.report.sessionPolicy, 'all-sessions-revoked')
    assert.equal(restored.report.issues.length, 0)
    assert.ok((restored.report.counts.products ?? 0) > 0)
    assert.equal(JSON.parse(await readFile(join(restored.root, 'restore-report.json'), 'utf8')).counts.invoices, 0)
  } finally { await context?.app.close(); await rm(root, { recursive: true, force: true }) }
})

test('B4 SigV4与AWS官方公开固定向量一致（仅假凭据），不依赖本实现算期望值', () => {
  assert.equal(typeof Stores.signAwsV4, 'function')
  const headers = Stores.signAwsV4({ method: 'POST', url: new URL('https://localhost/'), region: 'region', service: 'dynamodb',
    now: new Date(1935346573456), body: Buffer.from(JSON.stringify({ ExclusiveStartTableName: 'bår' })),
    headers: { 'X-Amz-Target': 'DynamoDB_20111205.ListTables', 'X-Amz-User-Agent': 'aws-sdk-js/0.1' },
    credentials: { accessKeyId: 'akid', secretAccessKey: 'secret', sessionToken: 'session' } })
  assert.equal(headers.authorization?.split('Signature=')[1], '31fac5ed29db737fbcafac527470ca6d9283283197c5e6e94ea40ddcec14a9c1')
  assert.equal(headers['x-amz-content-sha256'], '3128b8d4f3108b3e1677a38eb468d1c6dec926a58eaea235d034b9c71c3864d4')
})

test('B4 环境变量选择本地或S3备份，未配置不启用，错误配置不回显原值', () => {
  assert.equal(typeof Stores.backupOptionsFromEnvironment, 'function')
  assert.equal(Stores.backupOptionsFromEnvironment({}), undefined)
  const local = Stores.backupOptionsFromEnvironment({ BACKUP_STORE: 'local', BACKUP_LOCAL_DIRECTORY: './objects', BACKUP_STAGING_PATH: './staging' })
  assert.ok(local?.store instanceof Stores.LocalDirectoryStore)
  assert.throws(() => Stores.backupOptionsFromEnvironment({ BACKUP_STORE: 's3', BACKUP_STAGING_PATH: './staging' }), error => error instanceof Error && error.message === 'Backup configuration is invalid')
  assert.throws(() => Stores.backupOptionsFromEnvironment({ BACKUP_STORE: 'unknown' }), /Backup configuration is invalid/)
})

test('B4 S3适配器签名PUT/GET/DELETE与分页LIST，编码路径、拒绝重定向并隐藏错误详情', async () => {
  assert.equal(typeof Stores.S3CompatibleStore, 'function')
  const calls: { method: string; url: string }[] = []
  let fail = false
  const store = new Stores.S3CompatibleStore({ endpoint: 'https://storage.example.test', bucket: 'backups', region: 'us-east-1',
    env: { BACKUP_ACCESS_KEY_ID: 'public-test-id', BACKUP_SECRET_ACCESS_KEY: 'public-test-secret' },
    fetch: (async (input, options) => {
      const url = new URL(String(input)), method = options?.method ?? 'GET'
      calls.push({ method, url: url.toString() })
      assert.equal(options?.redirect, 'error')
      const signed = new Headers(options?.headers)
      assert.ok(signed.get('authorization')?.startsWith('AWS4-HMAC-SHA256 '))
      if (fail) throw new Error('unsafe upstream details')
      if (url.searchParams.has('list-type')) return new Response(url.searchParams.has('continuation-token')
        ? '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>hourly/b.txt</Key><Size>2</Size></Contents></ListBucketResult>'
        : '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next&amp;+</NextContinuationToken><Contents><Key>hourly/a.txt</Key><Size>1</Size></Contents></ListBucketResult>')
      return new Response(method === 'GET' ? 'backup bytes' : '', { status: 200 })
    }) as typeof fetch })
  await store.put('hourly/空 格+.txt', Buffer.from('x'))
  assert.match(calls[0]!.url, /%E7%A9%BA%20%E6%A0%BC%2B\.txt$/)
  assert.deepEqual(await store.list('hourly/'), [{ key: 'hourly/a.txt', size: 1 }, { key: 'hourly/b.txt', size: 2 }])
  assert.equal(Buffer.from(await store.get('hourly/a.txt')).toString(), 'backup bytes')
  await store.delete('hourly/a.txt')
  assert.equal(calls.at(-1)!.method, 'DELETE')
  fail = true
  await assert.rejects(store.put('hourly/fail.txt', Buffer.from('x')), error => error instanceof Error && error.message === 'Object storage request failed')
})
