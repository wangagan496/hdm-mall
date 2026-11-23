import { QuoteItem, QuoteRequest, QuoteResponse, parseQuoteResponse } from 'models'
import { RequestAxios } from 'network'

interface QuoteFailureBody { msg?: string }
interface QuoteFailureResponse { data?: QuoteFailureBody }
interface QuoteFailure extends Error { response?: QuoteFailureResponse }

// 只保存在进程内，按账号和购买来源隔离；不保存登录凭证，不维护过期状态。
export class QuoteMemory {
  private static quotes: Map<string, QuoteResponse> = new Map()
  static get(accountId: string, source: string): QuoteResponse | undefined { return QuoteMemory.quotes.get(accountId + ':' + source) }
  static put(accountId: string, source: string, quote: QuoteResponse): void {
    if (QuoteMemory.quotes.size >= 16 && !QuoteMemory.quotes.has(accountId + ':' + source)) QuoteMemory.quotes.clear()
    QuoteMemory.quotes.set(accountId + ':' + source, quote)
  }
  static preserveChange(accountId: string, source: string, quote: QuoteResponse): QuoteResponse {
    const previous = QuoteMemory.get(accountId, source)
    const comparison = previous?.quoteId === quote.quoteId ? previous.comparison : null
    if (!comparison || (quote.comparison && (quote.comparison.deltaCents !== 0 || quote.comparison.reasons.length > 0))) return quote
    if (comparison.deltaCents === 0 && comparison.reasons.length === 0) return quote
    quote.comparison = comparison
    return quote
  }
}
export async function getQuotePreviewAPI(token: string, items: QuoteItem[] | undefined, previousReceipt?: string): Promise<QuoteResponse> {
  const body: QuoteRequest = {}
  if (items !== undefined) body.items = items
  if (previousReceipt) body.previousReceipt = previousReceipt
  const value = await RequestAxios.postWithSession<QuoteResponse>('/member/quote-preview', body, token)
  const quote = parseQuoteResponse(JSON.stringify(value))
  if (!quote) throw new Error('报价数据格式不正确，请重试')
  return quote
}
export function quoteFailureText(error: Error): string {
  const failure = error as QuoteFailure
  return failure.response?.data?.msg || error.message || '服务暂时不可用，请重试'
}
export function quoteComparisonText(quote: QuoteResponse): string {
  const before = quote.comparison
  if (!before) return '报价 ' + quote.quoteId
  if (before.deltaCents === 0 && before.reasons.length === 0) return '与报价 ' + before.previousQuoteId + ' 一致'
  const difference = before.deltaCents > 0 ? '实付多了 ¥' : '实付少了 ¥'
  const amountText = before.deltaCents === 0 ? '实付没变，优惠规则有更新' : difference + (Math.abs(before.deltaCents) / 100).toFixed(2)
  return '和刚才相比' + amountText + '（报价 ' + before.previousQuoteId + ' → ' + quote.quoteId + '）'
}
export function quoteRemovalText(quote: QuoteResponse | null, skuId: string): string {
  const removal = quote?.removals.find(item => item.skuId === skuId)
  if (!removal) return ''
  const amount = (Math.abs(removal.decreaseCents) / 100).toFixed(2)
  return '去掉它，实付' + (removal.decreaseCents >= 0 ? '少 ' : '多 ') + amount + ' 元' +
    (removal.losesPromotion ? '；去掉会失去满减' : '') + (removal.removedCount > 1 ? '（本项共' + removal.removedCount + '件）' : '')
}
export function hasMultipleQuoteItems(quote: QuoteResponse | null): boolean {
  return (quote?.lines.reduce((total: number, line: QuoteItem) => total + line.count, 0) || 0) > 1
}
