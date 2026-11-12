export interface InvoiceInput {
  titleType: 'individual' | 'company'
  title: string
  taxId?: string
  email: string
}

export interface InvoiceDetail extends InvoiceInput {
  status: 'requested' | 'issued'
  number: string
  requestedAt: number
  issuedAt?: number | null
}

export function normalizedInvoice(input: InvoiceInput): InvoiceInput {
  return { titleType: input.titleType, title: input.title.trim(), email: input.email.trim(),
    taxId: input.titleType === 'company' ? (input.taxId || '').trim().toUpperCase() : undefined }
}

export function invoiceInputError(input: InvoiceInput): string {
  const value = normalizedInvoice(input)
  if (!value.title || value.title.length > 100) return '请填写1至100字的发票抬头'
  if (value.titleType === 'company' && !/^[A-Z0-9]{15,20}$/.test(value.taxId || '')) return '单位抬头请填写15至20位税号'
  if (value.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) return '请填写有效的接收邮箱'
  return ''
}
