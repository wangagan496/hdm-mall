export interface AfterSaleAddress { receiver: string; contact: string; address: string; fullLocation?: string }
export interface AfterSaleLine { skuId: string; name: string; spec: string; priceCents: number; count: number; remaining?: number; restockCount?: number }
export interface AfterSaleImage { imageId: string; path: string }
export interface AfterSale {
  id: string; orderId: string; sequence: number; kind: string; state: string; amountCents: number; payerAccount: string
  createdAt: number; reviewDeadline: number; returnDeadline: number | null; inspectDeadline: number | null
  refundId: string | null; refundState: string; refundReview: boolean
  description?: string; returnAddress?: AfterSaleAddress | null; carrier?: string; trackingNo?: string; rejectReason?: string
  items?: AfterSaleLine[]; images?: AfterSaleImage[]; needsReturnAddress?: boolean; buyerAccount?: string; serverNow?: number
}
export interface AfterSaleQuantity { skuId: string; count: number }
export interface AfterSaleRestock { skuId: string; restockCount: number }
export interface AfterSaleBody {
  requestKey?: string; kind?: string; description?: string; items?: AfterSaleQuantity[] | AfterSaleRestock[]; imageIds?: string[]
  returnAddress?: AfterSaleAddress; reason?: string; carrier?: string; trackingNo?: string
}
export interface AfterSalePhoto { bytes: string; requestKey: string }
export interface AfterSalePending { orderId: string; url: string; body: AfterSaleBody; photos: AfterSalePhoto[] }
export interface AfterSaleReceipt { id: string; orderId: string; afterSaleId: string; action: string; appliedState: string; appliedAt: number; refundId: string | null }
export interface AfterSaleCounts { pending: number; returned: number; all: number }
export interface AfterSalePage { items: AfterSale[]; counts: number; page: number; pageSize: number; pages: number; stateCounts: AfterSaleCounts }
export function afterSaleAmount(items: AfterSaleLine[]): number { return items.reduce((sum: number,item: AfterSaleLine): number => sum + item.priceCents * item.count,0) }
export function afterSaleInputError(items: AfterSaleLine[], kind: string, description: string): string {
  if (!items.some((item: AfterSaleLine): boolean => item.count > 0) || items.some((item: AfterSaleLine): boolean => !Number.isInteger(item.count) || item.count < 0 || item.count > (item.remaining ?? 0))) return '请核对申请数量'
  if (description.trim().length > 200 || (kind !== 'return-no-reason' && description.trim().length < 5)) return '请填写5到200字的问题说明'
  return ''
}
export function afterSaleStatus(sale: AfterSale): string {
  if (sale.state === 'pending') return '待商家处理'
  if (sale.state === 'awaiting-return') return '请寄回'
  if (sale.state === 'returned') return '等待商家验收'
  if (sale.state === 'refunding') return sale.refundReview ? '退款遇到问题，正在人工处理' : sale.refundState === 'failed' ? '退款失败，正在重试' : '退款中'
  if (sale.state === 'refunded') return '已退款'
  if (sale.state === 'rejected') return '已拒绝'
  if (sale.state === 'withdrawn') return '已撤回'
  if (sale.state === 'closed') return '已关闭'
  if (sale.state === 'refund-rejected') return '商家拒绝退款'
  return '售后处理中'
}
export function afterSaleKind(kind: string): string { return kind === 'return-no-reason' ? '七日无理由退货' : kind === 'return-quality' ? '质量问题退货' : '少件漏发仅退款' }
