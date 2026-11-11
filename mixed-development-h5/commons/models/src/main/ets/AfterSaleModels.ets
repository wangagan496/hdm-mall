import { ReturnPolicyFields, returnConditionError } from './ReturnPolicy'
export interface AfterSaleAddress { receiver: string; contact: string; address: string; fullLocation?: string }
export interface AfterSaleLine extends ReturnPolicyFields { skuId: string; name: string; spec: string; priceCents: number; count: number; remaining?: number; restockCount?: number; afterSaleKinds?: string[]; conditionDeclared?: string; discountShareCents?: number; boughtCount?: number }
export interface AfterSaleImage { imageId: string; path: string }
export interface AfterSale {
  id: string; orderId: string; sequence: number; kind: string; state: string; amountCents: number; payerAccount: string
  amountMessage?: string; shippingAmountCents?: number | null; shippingCompensationCents?: number | null; shippingAdjustmentReason?: string
  shippingRefundId?: string | null; shippingRefundState?: string; shippingImage?: AfterSaleImage | null
  createdAt: number; reviewDeadline: number; returnDeadline: number | null; inspectDeadline: number | null
  refundId: string | null; refundState: string; refundReview: boolean
  description?: string; returnAddress?: AfterSaleAddress | null; carrier?: string; trackingNo?: string; rejectReason?: string
  items?: AfterSaleLine[]; images?: AfterSaleImage[]; needsReturnAddress?: boolean; buyerAccount?: string; serverNow?: number
}
export interface AfterSaleQuantity { skuId: string; count: number; conditionDeclared?: string }
export interface AfterSaleRestock { skuId: string; restockCount: number }
export interface AfterSaleBody {
  requestKey?: string; kind?: string; description?: string; items?: AfterSaleQuantity[] | AfterSaleRestock[]; imageIds?: string[]
  returnAddress?: AfterSaleAddress; reason?: string; carrier?: string; trackingNo?: string; shippingAmountCents?: number
  shippingImageId?: string; shippingCompensationCents?: number; shippingAdjustmentReason?: string
}
export interface AfterSalePhoto { bytes: string; requestKey: string }
export interface AfterSalePending { orderId: string; url: string; body: AfterSaleBody; photos: AfterSalePhoto[] }
export interface AfterSaleReceipt { id: string; orderId: string; afterSaleId: string; action: string; appliedState: string; appliedAt: number; refundId: string | null }
export interface AfterSaleCounts { pending: number; returned: number; all: number }
export interface AfterSalePage { items: AfterSale[]; counts: number; page: number; pageSize: number; pages: number; stateCounts: AfterSaleCounts }
export function amountInputCents(text: string): number {
  if (!/^[0-9]+([.][0-9]{1,2})?$/.test(text.trim())) return -1
  const cents = Math.round(Number(text.trim()) * 100)
  return Number.isSafeInteger(cents) ? cents : -1
}
export function returnShippingError(text: string, photoCount: number): string {
  const cents = amountInputCents(text)
  if (cents < 1 || cents > 10000) return '请填写0.01–100元实付运费，最多两位小数'
  return photoCount === 1 ? '' : '请上传1张JPEG运单截图，不超过512KB'
}
export function shippingAdjustmentError(text: string, paid: number, reason: string): string {
  const cents = amountInputCents(text)
  if (cents < 0 || cents > paid) return '运费补偿不能超过买家填写的金额，最多两位小数'
  if (cents < paid && (reason.trim().length < 5 || reason.trim().length > 200)) return '下调运费请填写5到200字的原因'
  return ''
}
export function shippingCompensationText(sale: AfterSale): string {
  if (sale.shippingCompensationCents === null || sale.shippingCompensationCents === undefined) return ''
  const progress = sale.shippingCompensationCents === 0 ? '无需运费退款' : sale.shippingRefundState === 'succeeded' ? '已退回' : sale.shippingRefundState === 'failed' ? '退款失败，正在重试' : '退款处理中'
  return '运费补偿 ¥' + (sale.shippingCompensationCents / 100).toFixed(2) + (sale.shippingAdjustmentReason ? '（商家调整：' + sale.shippingAdjustmentReason + '）' : '') + ' · ' + progress
}
export function afterSaleDiscount(item: AfterSaleLine): number {
  const bought = item.boughtCount || item.remaining || item.count
  if (!bought) return 0
  const consumed = bought - (item.remaining ?? bought)
  return Math.floor((item.discountShareCents || 0) * (consumed + item.count) / bought) - Math.floor((item.discountShareCents || 0) * consumed / bought)
}
export function afterSaleAmount(items: AfterSaleLine[]): number { return items.reduce((sum: number,item: AfterSaleLine): number => sum + item.priceCents * item.count - afterSaleDiscount(item),0) }
export function afterSaleInputError(items: AfterSaleLine[], kind: string, description: string): string {
  if (!items.some((item: AfterSaleLine): boolean => item.count > 0) || items.some((item: AfterSaleLine): boolean => !Number.isInteger(item.count) || item.count < 0 || item.count > (item.remaining ?? 0))) return '请核对申请数量'
  for (const item of items) {
    if (item.count <= 0) continue
    if (kind === 'return-no-reason') {
      const error = returnConditionError(item, item.conditionDeclared)
      if (error) return item.name + '：' + error
    }
    if (item.afterSaleKinds && !item.afterSaleKinds.includes(kind)) return item.name + '暂不能申请该售后类型，请调整数量或类型'
  }
  if (description.trim().length > 200 || (kind !== 'return-no-reason' && description.trim().length < 5)) return '请填写5到200字的问题说明'
  return ''
}
export function afterSaleStatus(sale: AfterSale): string {
  if (sale.state === 'pending') return '待商家处理'
  if (sale.state === 'awaiting-return') return '请寄回'
  if (sale.state === 'returned') return '等待商家验收'
  if (sale.state === 'refunding') return sale.refundReview ? '退款遇到问题，正在人工处理' : sale.refundState === 'failed' ? '退款失败，正在重试' : '退款中'
  if (sale.state === 'refunded') return '已退款'
  if (sale.state === 'completed') return '已完成'
  if (sale.state === 'rejected') return '已拒绝'
  if (sale.state === 'withdrawn') return '已撤回'
  if (sale.state === 'closed') return '已关闭'
  if (sale.state === 'refund-rejected') return '商家拒绝退款'
  return '售后处理中'
}
export function afterSaleKind(kind: string): string { return kind === 'return-no-reason' ? '七日无理由退货' : kind === 'return-quality' ? '质量问题退货' : '少件漏发仅退款' }
