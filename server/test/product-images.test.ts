import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.ts'

export function imagePayload(requestKey: string, bytes: Buffer = Buffer.from([0xff, 0xd8, 0xff, 0xd9])) {
  const boundary = 'product-image-boundary'
  return { boundary, payload: Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="requestKey"\r\n\r\n${requestKey}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="product.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]) }
}

test('商品图片按账号与请求号登记，只接受JPEG且大小受限，头像文件大小限制仍生效', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdm-product-images-'))
  const f = await buildApp({ databasePath: ':memory:', uploadsPath: root, publicUrl: 'http://fixture', mockPayments: true })
  try {
    f.accounts.register('image_merchant', 'test-password-123', 'merchant')
    const merchant = f.accounts.login('image_merchant', 'test-password-123')
    const upload = (requestKey: string, bytes?: Buffer, path = '/merchant/products/images') => {
      const data = imagePayload(requestKey, bytes)
      return f.app.inject({ method: 'POST', url: path, headers: { authorization: 'Bearer ' + merchant.token,
        'content-type': 'multipart/form-data; boundary=' + data.boundary }, payload: data.payload })
    }
    const key = randomUUID(), first = await upload(key)
    assert.equal(first.statusCode, 200, first.body)
    assert.ok(first.json().result.imageId)
    assert.match(first.json().result.picture, /^http:\/\/fixture\/uploads\/[0-9a-f-]+\.jpg$/)
    assert.deepEqual((await upload(key)).json(), first.json())
    assert.equal((await upload(key, Buffer.from([0xff, 0xd8, 0xff, 0x01]))).statusCode, 409)
    assert.equal((await upload(randomUUID(), Buffer.from('not jpeg'))).statusCode, 400)
    const huge = Buffer.alloc(512 * 1024 + 1); huge.set([0xff, 0xd8, 0xff])
    assert.equal((await upload(randomUUID(), huge)).statusCode, 413)
    assert.equal((await upload(randomUUID(), huge, '/member/profile/avatar')).statusCode, 413)
  } finally { await f.app.close(); await rm(root, { recursive: true, force: true }) }
})
