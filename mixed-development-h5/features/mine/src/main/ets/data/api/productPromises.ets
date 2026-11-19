import { RequestAxios } from 'network'
import { PromiseDraft, PromiseSnapshot, parsePromiseDraft, parsePromiseSnapshot } from 'models'

export interface ProductPromises {
  draft: PromiseDraft | null
  published: PromiseSnapshot | null
}

export interface PromiseDecision {
  fieldId: string
  decision: string
}

interface ConfirmPromises {
  draftId: string
  decisions: PromiseDecision[]
}

interface PromiseConfirmation {
  confirmationToken: string
  expiresAt: number
}

interface PublishPromises {
  confirmationToken: string
  requestKey: string
}

interface PromiseErrorBody { msg?: string }
interface PromiseErrorResponse { status?: number; data?: PromiseErrorBody }
interface PromiseRequestError extends Error { httpStatus?: number; response?: PromiseErrorResponse }
interface ExtractPromises {}

function productPath(id: string): string {
  return '/merchant/products/' + encodeURIComponent(id) + '/promises'
}

function snapshot(raw: Object): PromiseSnapshot {
  const parsed: PromiseSnapshot | null = parsePromiseSnapshot(JSON.stringify(raw))
  if (parsed === null) throw new Error('承诺版本读取失败')
  return parsed
}

function productPromises(raw: ProductPromises): ProductPromises {
  const draft: PromiseDraft | null = raw.draft ? parsePromiseDraft(JSON.stringify(raw.draft)) : null
  if (raw.draft && !draft) throw new Error('承诺草稿读取失败')
  return { draft, published: raw.published ? snapshot(raw.published) : null }
}

export async function getProductPromises(id: string, token: string): Promise<ProductPromises> {
  return productPromises(await RequestAxios.getForSession<ProductPromises>(productPath(id), token))
}

export async function extractProductPromises(id: string, token: string): Promise<ProductPromises> {
  const body: ExtractPromises = {}
  return productPromises(await RequestAxios.postWithSession<ProductPromises>(productPath(id) + '/extract', body, token, undefined, 35000))
}

export async function confirmProductPromises(id: string, draftId: string, decisions: PromiseDecision[],
  token: string): Promise<string> {
  const body: ConfirmPromises = { draftId, decisions }
  const result = await RequestAxios.postWithSession<PromiseConfirmation>(productPath(id) + '/confirmations', body, token)
  return result.confirmationToken
}

export async function publishProductPromises(id: string, confirmationToken: string, requestKey: string,
  token: string): Promise<PromiseSnapshot> {
  const body: PublishPromises = { confirmationToken, requestKey }
  return snapshot(await RequestAxios.postWithSession<Object>(productPath(id) + '/publish', body, token))
}

export async function findPromiseReceipt(id: string, requestKey: string, token: string): Promise<PromiseSnapshot | null> {
  try {
    return snapshot(await RequestAxios.getForSession<Object>(productPath(id) + '/receipts/' + encodeURIComponent(requestKey), token))
  } catch (error) {
    if (promiseRequestStatus(error as Error) === 404) return null
    throw error as Error
  }
}

export function promiseRequestStatus(error: Error): number {
  const failure = error as PromiseRequestError
  return failure.httpStatus || failure.response?.status || 0
}

export function promiseRequestMessage(error: Error, fallback: string): string {
  const failure = error as PromiseRequestError
  return failure.response?.data?.msg || fallback
}
