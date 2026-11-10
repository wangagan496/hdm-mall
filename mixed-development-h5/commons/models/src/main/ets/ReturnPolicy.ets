export interface ReturnPolicyFields {
  returnPolicy?: string
  returnPolicyReason?: string
  returnPolicyNote?: string
  returnPolicyConfirmed?: boolean
}
export interface ReturnPolicyGoods extends ReturnPolicyFields { skuId: string; name: string }
export interface ReturnPolicyOption { policy: string; reason: string; label: string }

export const RETURN_POLICY_OPTIONS: ReturnPolicyOption[] = [
  { policy: 'standard', reason: '', label: '支持七日无理由退货' },
  { policy: 'law-excluded', reason: 'custom', label: '定作商品' },
  { policy: 'law-excluded', reason: 'perishable', label: '鲜活易腐商品' },
  { policy: 'law-excluded', reason: 'digital', label: '在线下载或已拆封的数字化商品' },
  { policy: 'law-excluded', reason: 'periodical', label: '报纸期刊' },
  { policy: 'confirm-required', reason: 'unsealed', label: '拆封后影响安全健康或品质' },
  { policy: 'confirm-required', reason: 'activated', label: '激活或试用后价值贬损较大' },
  { policy: 'confirm-required', reason: 'near-expiry', label: '临近保质期' },
  { policy: 'confirm-required', reason: 'defect', label: '有瑕疵' }
]

export function returnPolicyError(value: ReturnPolicyFields): string {
  const policy = value.returnPolicy || 'standard', reason = value.returnPolicyReason || '', note = (value.returnPolicyNote || '').trim()
  if (!RETURN_POLICY_OPTIONS.some((option: ReturnPolicyOption): boolean => option.policy === policy && option.reason === reason)) return '请选择已有的退货规则'
  if (reason === 'defect') return note.length < 5 || note.length > 100 ? '瑕疵说明请填写5到100个字' : ''
  return note ? '仅有瑕疵的商品需要填写瑕疵说明' : ''
}

export function returnPolicyLabel(value: ReturnPolicyFields): string {
  if (!value.returnPolicy || value.returnPolicy === 'standard') return '支持七日无理由退货'
  const reason = value.returnPolicyReason || ''
  if (value.returnPolicy === 'law-excluded') {
    const option = RETURN_POLICY_OPTIONS.find((item: ReturnPolicyOption): boolean => item.reason === reason)
    return '不支持七日无理由退货（' + (option?.label || '请查看退货规则') + '）'
  }
  if (reason === 'unsealed') return '拆封后不支持七日无理由退货'
  if (reason === 'activated') return '激活或试用后不支持七日无理由退货'
  if (reason === 'near-expiry') return '临近保质期商品，不支持七日无理由退货'
  if (reason === 'defect') return '有瑕疵：' + (value.returnPolicyNote || '') + '，不支持七日无理由退货'
  return '请查看商品退货规则'
}

export class ReturnPolicyConfirmation {
  confirmed: boolean = false
  highlighted: boolean = false
  token: string = ''
  refresh(token: string): void {
    if (token !== this.token) { this.confirmed = false; this.highlighted = false }
    this.token = token
  }
  choose(confirmed: boolean): void { this.confirmed = confirmed; if (confirmed) this.highlighted = false }
  validate(goods: ReturnPolicyFields[]): boolean {
    this.highlighted = goods.some((item: ReturnPolicyFields): boolean => item.returnPolicy === 'confirm-required') && (!this.confirmed || !this.token)
    return !this.highlighted
  }
  reset(): void { this.confirmed = false; this.highlighted = false; this.token = '' }
  copy(): ReturnPolicyConfirmation {
    const result = new ReturnPolicyConfirmation()
    result.confirmed = this.confirmed; result.highlighted = this.highlighted; result.token = this.token
    return result
  }
}

export function returnPolicyAllowsNoReason(value: ReturnPolicyFields): boolean {
  if (value.returnPolicy === 'law-excluded') return false
  if (value.returnPolicy !== 'confirm-required' || !value.returnPolicyConfirmed) return true
  return value.returnPolicyReason === 'unsealed' || value.returnPolicyReason === 'activated'
}

export function returnConditionRequired(value: ReturnPolicyFields): boolean {
  return value.returnPolicy === 'confirm-required' && value.returnPolicyConfirmed === true &&
    (value.returnPolicyReason === 'unsealed' || value.returnPolicyReason === 'activated')
}

export function returnConditionError(value: ReturnPolicyFields, condition: string | undefined): string {
  if (!returnPolicyAllowsNoReason(value)) return returnPolicyAfterSaleHint(value)
  if (!returnConditionRequired(value)) return ''
  if (condition === 'sealed') return ''
  const activated = value.returnPolicyReason === 'activated'
  if (condition !== 'unsealed') return activated ? '请选择是否已激活或试用' : '请选择是否已拆封'
  return (activated ? '已激活或试用' : '已拆封') + '的该商品不支持七日无理由退货，如有质量问题可选择质量问题退货'
}

export function returnPolicyAfterSaleHint(value: ReturnPolicyFields): string {
  if (value.returnPolicy === 'confirm-required' && !value.returnPolicyConfirmed) return '下单时未确认退货限制，按支持七日无理由退货处理'
  if (returnConditionRequired(value)) return returnPolicyLabel(value) + '；请如实声明商品状态，未' + (value.returnPolicyReason === 'activated' ? '激活或试用' : '拆封') + '仍可申请'
  if (returnPolicyAllowsNoReason(value)) return ''
  return returnPolicyLabel(value) + (value.returnPolicyReason === 'defect' ? '；如问题与商家说明的瑕疵不同，请选择质量问题退货' : '；如有质量问题可选择质量问题退货')
}

export function returnConditionLabel(reason: string | undefined, condition: string | undefined): string {
  if (condition !== 'sealed' && condition !== 'unsealed') return ''
  return '买家声明：' + (condition === 'sealed' ? '未' : '已') + (reason === 'activated' ? '激活或试用' : '拆封')
}
