import { AuditItem, AuditLine } from '../../data/api/audit'
import { formatBeijingTime, returnPolicyLabel, PromotionRule } from 'models'

interface AuditReturnPolicy { policy: string; reason: string; note: string }
function policyLabel(value: string | number | boolean | undefined): string {
  try {
    const parsed = JSON.parse(String(value)) as AuditReturnPolicy
    if (!parsed || !parsed.policy) return '退货规则'
    return returnPolicyLabel({ returnPolicy: parsed.policy, returnPolicyReason: parsed.reason, returnPolicyNote: parsed.note })
  } catch { return '退货规则' }
}

export function auditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    'invoice.request': '登记开票信息', 'invoice.issued': '标记已开票', 'review.hide': '隐藏评价',
    'review.republish': '修改后重新发布评价', 'avatar.reset': '重置违规头像',
    'promotion.edit': '修改满减规则', 'aftersale.shipping_comp': '补偿退货运费',
    'product.create': '新建商品', 'product.edit': '修改商品', 'product.status': '上架或下架',
    'product.return_policy': '修改退货规则',
    'sku.price': '改价', 'sku.enable': '启用或停用规格', 'sku.stock': '编辑商品库存', 'stock.adjust': '调整库存',
    'order.ship': '发货', 'order.reject_and_ship': '拒绝取消并发货', 'cancel.approve': '同意取消', 'cancel.auto_approve': '自动同意取消',
    'aftersale.approve': '同意售后', 'aftersale.reject': '拒绝售后', 'aftersale.inspect': '售后验收并退款',
    'aftersale.refund_reject': '拒绝退款', 'aftersale.auto_approve': '自动同意售后', 'aftersale.auto_close': '自动关闭售后', 'aftersale.auto_refund': '自动退款',
    'refund.create': '发起退款', 'refund.result': '退款结果', 'refund.retry': '重试退款', 'payment.review': '核实付款',
    'settings.return_address': '修改退货地址', 'access.denied': '访问被拒绝'
  }
  return labels[action] || '操作记录'
}
export function auditFilterLabel(group: string): string {
  const labels: Record<string, string> = { 'all': '全部', 'products': '商品与价格', 'inventory': '库存', 'shipping': '发货', 'aftersales': '售后与退款', 'denied': '访问拒绝' }
  return labels[group] || '全部'
}
function money(value: number): string { return '¥' + (value / 100).toFixed(2) }
function promotionLabel(value: string | number | boolean | undefined): string {
  try { const rule = JSON.parse(String(value)) as PromotionRule; return rule.enabled ? '满 ' + money(rule.thresholdCents) + ' 减 ' + money(rule.discountCents) : '已停用' }
  catch { return '满减规则' }
}
export function auditChange(item: AuditItem): string {
  const s = item.summary
  const reason = s.reason ? '，原因：' + s.reason : ''
  if (item.action === 'promotion.edit') return promotionLabel(s.before) + ' → ' + promotionLabel(s.after)
  if (item.action === 'aftersale.shipping_comp') return '实付运费 ' + money(Number(s.before)) + '，补偿 ' + money(Number(s.after)) + reason
  if (item.action === 'product.return_policy') return policyLabel(s.before) + ' → ' + policyLabel(s.after)
  if (item.action === 'sku.price') return (s.spec || '规格') + ' ' + money(Number(s.before)) + ' → ' + money(Number(s.after))
  if (item.action === 'sku.stock' || item.action === 'stock.adjust') return '库存 ' + s.before + ' → ' + s.after + reason
  if (item.action === 'sku.enable') return (s.spec || '规格') + '：' + (s.before ? '启用' : '停用') + ' → ' + (s.after ? '启用' : '停用')
  if (item.action === 'product.status') return (s.before === 'on' ? '上架' : '下架') + ' → ' + (s.after === 'on' ? '上架' : '下架')
  if (item.action === 'product.create') return s.name || '已创建'
  if (item.action === 'product.edit') {
    const changes: string[] = []
    if (s.before !== undefined) changes.push(String(s.before) + ' → ' + String(s.after))
    if (s.descriptionChanged) changes.push('说明已修改')
    if (s.pictureChanged) changes.push('图片已修改')
    return changes.join('；') || s.note || '已修改'
  }
  if (item.action === 'refund.create') {
    const reasons: Record<string, string> = { 'late': '迟到付款退回', 'duplicate': '重复付款退回', 'cancelled': '订单取消', 'after-sale': '售后退款', 'shipping': '退货运费补偿' }
    return '退款 ' + money(s.amountCents || 0) + ' 退回 ' + (s.payerAccount || '原付款账号') + '（' + (reasons[s.reason || ''] || '原路退回') + '）'
  }
  if (item.action === 'refund.result') return money(s.amountCents || 0) + ' · ' + (s.outcome === 'success' ? '退款成功' : s.outcome === 'review' ? '已转人工核实' : '退款失败，等待重试')
  if (item.action === 'payment.review') return (s.outcome === 'paid' ? '确认已扣款' : '确认未扣款') + reason
  if (item.action === 'aftersale.inspect') return (s.items || []).map((line: AuditLine): string => line.spec + ' 合格入库 ' + line.restockCount + ' 件').join('；')
  if (item.action === 'settings.return_address') return '已修改'
  if (item.action === 'access.denied') return '非商家账号尝试访问商家功能，已拒绝'
  return s.reason || s.note || '已完成'
}
export function auditObject(item: AuditItem): string {
  return item.objectName + (item.orderCreated ? ' · ' + formatBeijingTime(item.orderCreated) + '下单' : '')
}
