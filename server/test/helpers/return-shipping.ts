import { after } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { buildTestApp } from './fixtures.ts'

export function withReturnShipping(ctx: Awaited<ReturnType<typeof buildTestApp>>, uploadsPath: string, url: string, payload: object | undefined, token: string) {
  const match = /^\/member\/after-sales\/([^/]+)\/ship-back$/.exec(url)
  if (!match || !payload) return payload
  const data = payload as { requestKey: string; shippingAmountCents?: number; carrier?: string; trackingNo?: string }
  if (data.shippingAmountCents !== undefined || !data.carrier || !data.trackingNo) return payload
  const user = ctx.accounts.authenticate('Bearer ' + token)
  const sale = ctx.db.one<{ order_id: string; requested_by: string; state: string }>('SELECT * FROM after_sales WHERE id=?', match[1]!)
  if (!sale || user.id !== sale.requested_by || sale.state !== 'awaiting-return') return payload
  let path = uploadsPath
  if (path === './unused') {
    path = mkdtempSync(join(tmpdir(), 'legacy-shipping-'))
    after(() => rm(path, { recursive: true, force: true }))
  }
  const image = ctx.afterSales.uploadImage(user, sale.order_id, data.requestKey, randomUUID(), Buffer.from([255, 216, 255, 224, 255, 217]), path)
  return { ...payload, shippingAmountCents: 1, shippingImageId: image.imageId }
}
