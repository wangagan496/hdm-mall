import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import type { ChannelPayment, ChannelResult, PaymentChannel, RefundResult } from './payment-channel.ts'
import { AppError } from './errors.ts'
import { beijingTime, channelCents, channelPost, channelTime, type ChannelFetch } from './channel-http.ts'

export const ALIPAY_SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do'
interface AlipayOptions { appId: string; sellerId: string; privateKey: string; publicKey: string; returnUrl: string; notifyUrl?: string }
type Payload = Record<string, unknown>
export function canonicalParameters(fields: Record<string, string>): string {
  return Object.keys(fields).filter(key => fields[key] !== '').sort().map(key => `${key}=${fields[key]}`).join('&')
}

/** Read top-level JSON values without reserializing the signed response object. */
export function parseAlipayResponse(raw: string, method: string, publicKey: string): Payload {
  try {
    const root = JSON.parse(raw) as Record<string, unknown>
    const wanted = method.replaceAll('.', '_') + '_response'
    let index = raw.indexOf('{') + 1, signed: string | undefined
    const seen = new Set<string>()
    const whitespace = () => { while (/\s/.test(raw[index] ?? '') && index < raw.length) index++ }
    const stringEnd = (start: number) => {
      let at = start + 1
      while (at < raw.length) { if (raw[at] === '\\') at += 2; else if (raw[at++] === '"') return at }
      throw new Error()
    }
    while (index < raw.length) {
      whitespace()
      if (raw[index] === '}') break
      if (raw[index] !== '"') throw new Error()
      const end = stringEnd(index), name = JSON.parse(raw.slice(index, end)) as string
      if (seen.has(name)) throw new Error()
      seen.add(name); index = end; whitespace()
      if (raw[index++] !== ':') throw new Error()
      whitespace()
      const start = index
      let depth = 0
      while (index < raw.length) {
        const char = raw[index]
        if (char === '"') { index = stringEnd(index); continue }
        if (char === '{' || char === '[') depth++
        if (depth === 0 && (char === ',' || char === '}')) break
        if (char === '}' || char === ']') depth--
        index++
      }
      if (name === wanted) signed = raw.slice(start, index).trim()
      if (raw[index] === ',') index++; else break
    }
    if (!signed || typeof root.sign !== 'string' || !verify('RSA-SHA256', Buffer.from(signed), publicKey, Buffer.from(root.sign, 'base64'))) throw new Error()
    const payload = JSON.parse(signed) as Payload
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error()
    return payload
  } catch { throw new AppError(502, '支付渠道响应验签失败') }
}

export class AlipayChannel implements PaymentChannel {
  readonly mode = 'alipay-sandbox'
  private readonly options: AlipayOptions
  private readonly transport: ChannelFetch
  private readonly refundReferences = new Map<string, string>()
  constructor(options: AlipayOptions, transport: ChannelFetch = fetch) {
    try {
      const key = createPrivateKey(options.privateKey), pub = createPublicKey(options.publicKey)
      if (key.asymmetricKeyType !== 'rsa' || pub.asymmetricKeyType !== 'rsa' ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || (pub.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error()
    } catch { throw new Error('ALIPAY_PRIVATE_KEY / ALIPAY_PUBLIC_KEY 必须为有效的 RSA2 PEM 密钥') }
    this.options = options; this.transport = transport
  }
  private parameters(method: string, biz: Payload, extras: Record<string, string> = {}) {
    const fields: Record<string, string> = { app_id: this.options.appId, method, charset: 'utf-8', format: 'JSON',
      sign_type: 'RSA2', timestamp: beijingTime(Date.now()), version: '1.0', biz_content: JSON.stringify(biz), ...extras }
    fields.sign = sign('RSA-SHA256', Buffer.from(canonicalParameters(fields)), this.options.privateKey).toString('base64')
    return fields
  }
  checkout(payment: ChannelPayment): string {
    if (!Number.isSafeInteger(payment.amount) || payment.amount <= 0) throw new AppError(400, '支付金额无效')
    const fields = this.parameters('alipay.trade.wap.pay', { out_trade_no: payment.id, total_amount: (payment.amount / 100).toFixed(2),
      subject: '惠多美沙箱测试订单', product_code: 'QUICK_WAP_WAY', seller_id: this.options.sellerId,
      time_expire: beijingTime(payment.graceDeadline), quit_url: this.options.returnUrl },
    { return_url: this.options.returnUrl, ...(this.options.notifyUrl ? { notify_url: this.options.notifyUrl } : {}) })
    return ALIPAY_SANDBOX_GATEWAY + '?' + new URLSearchParams(fields).toString()
  }
  create(payment: ChannelPayment) { return { accepted: true, checkoutUrl: this.checkout(payment) } }
  private async request(method: string, biz: Payload): Promise<Payload> {
    return parseAlipayResponse(await channelPost(ALIPAY_SANDBOX_GATEWAY, this.parameters(method, biz), this.transport), method, this.options.publicKey)
  }
  async query(paymentId: string): Promise<ChannelResult> {
    try {
      const data = await this.request('alipay.trade.query', { out_trade_no: paymentId })
      if (data.code !== '10000' || data.out_trade_no !== paymentId ||
        (data.seller_user_id !== undefined && data.seller_user_id !== this.options.sellerId)) return { state: 'unknown' }
      const amount = channelCents(data.total_amount)
      if (data.trade_status === 'TRADE_SUCCESS' || data.trade_status === 'TRADE_FINISHED') {
        if (typeof data.trade_no !== 'string' || !data.trade_no) return { state: 'unknown' }
        return { state: 'success', amount, paidAt: channelTime(data.send_pay_date), channelTransactionId: data.trade_no }
      }
      if (data.trade_status === 'TRADE_CLOSED') return { state: 'closed', amount }
      return { state: 'unknown' }
    } catch { return { state: 'unknown' } }
  }
  async close(paymentId: string): Promise<ChannelResult> {
    const before = await this.query(paymentId)
    if (before.state === 'success' || before.state === 'closed') return before
    try {
      const data = await this.request('alipay.trade.close', { out_trade_no: paymentId })
      if (data.code === '10000' && data.out_trade_no === paymentId) return { state: 'closed' }
      return await this.query(paymentId)
    } catch { return { state: 'unknown' } }
  }
  async refundQuery(refundId: string, paymentId: string, amount: number): Promise<RefundResult> {
    try {
      const data = await this.request('alipay.trade.fastpay.refund.query', { out_trade_no: paymentId, out_request_no: refundId })
      if (data.code !== '10000' || data.out_trade_no !== paymentId || data.out_request_no !== refundId ||
        data.refund_status !== 'REFUND_SUCCESS' || channelCents(data.refund_amount) !== amount) return 'fail'
      if (typeof data.refund_settlement_id === 'string' && data.refund_settlement_id) this.refundReferences.set(refundId, data.refund_settlement_id)
      return 'success'
    } catch { return 'fail' }
  }
  async refund(refundId: string, paymentId: string, amount: number): Promise<RefundResult> {
    if (!Number.isSafeInteger(amount) || amount <= 0) return 'fail'
    if (await this.refundQuery(refundId, paymentId, amount) === 'success') return 'success'
    try {
      const data = await this.request('alipay.trade.refund', { out_trade_no: paymentId, out_request_no: refundId, refund_amount: (amount / 100).toFixed(2) })
      if (data.code === '10000' && data.out_trade_no === paymentId && data.fund_change === 'Y' && channelCents(data.refund_fee) === amount) return 'success'
      // 未确认保持待重试，由既有调度在后续查询确认，不能把10000直接标成功。
      return 'fail'
    } catch { return 'fail' }
  }
  refundReference(refundId: string) { return this.refundReferences.get(refundId) }
  verifyNotification(body: string): { paymentId: string; amount: number; state: 'success' | 'fail'; paidAt?: number } {
    try {
      const fields: Record<string, string> = {}, seen = new Set<string>()
      for (const [key, value] of new URLSearchParams(body)) { if (seen.has(key)) throw new Error(); seen.add(key); fields[key] = value }
      const signature = fields.sign
      if (fields.sign_type !== 'RSA2' || !signature) throw new Error()
      delete fields.sign; delete fields.sign_type
      if (!verify('RSA-SHA256', Buffer.from(canonicalParameters(fields)), this.options.publicKey, Buffer.from(signature, 'base64')) ||
        fields.app_id !== this.options.appId || fields.seller_id !== this.options.sellerId || !fields.out_trade_no || !fields.trade_no) throw new Error()
      const amount = channelCents(fields.total_amount)
      if (fields.trade_status === 'TRADE_SUCCESS' || fields.trade_status === 'TRADE_FINISHED') {
        return { paymentId: fields.out_trade_no, amount, state: 'success', paidAt: channelTime(fields.gmt_payment) }
      }
      if (fields.trade_status === 'TRADE_CLOSED') return { paymentId: fields.out_trade_no, amount, state: 'fail' }
      throw new Error()
    } catch { throw new AppError(400, '支付通知验证失败') }
  }
}
