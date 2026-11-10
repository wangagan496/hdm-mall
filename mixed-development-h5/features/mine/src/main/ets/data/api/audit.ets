export interface AuditLine { skuId: string; spec: string; restockCount: number }
export interface AuditSummary {
  before?: string | number | boolean
  after?: string | number | boolean
  spec?: string
  name?: string
  reason?: string
  descriptionChanged?: boolean
  pictureChanged?: boolean
  amountCents?: number
  payerAccount?: string
  outcome?: string
  items?: AuditLine[]
  backfilled?: boolean
  note?: string
}
export interface AuditItem {
  id: number
  created: number
  actorAccount: string
  action: string
  orderId?: string
  productId?: string
  objectName: string
  orderCreated?: number
  summary: AuditSummary
  result: string
}
export interface AuditPage { items: AuditItem[]; page: number; pages: number; counts: number }
export interface AuditFilter { orderId?: string; productId?: string }
