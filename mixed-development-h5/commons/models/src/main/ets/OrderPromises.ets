import { PromiseEntry, PromiseSnapshot, parsePromiseSnapshot } from './Promises'

export interface PromiseMismatch {
  skuId: string
  fieldId: string
}

export interface OrderPromiseCheck {
  fieldId: string
  result: string
}

export interface PromiseAfterSaleRoute {
  orderId: string
  promiseMismatch: PromiseMismatch
}

export function frozenOrderPromise(snapshot: PromiseSnapshot | null | undefined, fieldId: string): PromiseEntry | undefined {
  const verified = snapshot ? parsePromiseSnapshot(JSON.stringify(snapshot)) : null
  return verified?.entries.find(entry => entry.fieldId === fieldId && entry.status === 'known')
}
