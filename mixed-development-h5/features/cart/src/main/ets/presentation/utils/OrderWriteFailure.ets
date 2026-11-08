import { BusinessError } from 'network'

interface WriteFailureResponse {
  status: number
}

interface WriteRequestError extends Error {
  code?: string | number
  isAxiosError?: boolean
  response?: WriteFailureResponse
}

export interface OrderWriteFailure {
  unknownResult: boolean
  message: string
}

function friendlyBusinessMessage(message: string, status: number): string {
  if (status === 401) return '登录已过期，登录后继续'
  if (status === 403) return '当前账号无法执行此操作'
  if (message === 'PRICE_CHANGED' || message.includes('价格')) return '价格已更新，请核对后提交'
  const readable: string[] = ['订单不能收货', '该订单不能评价', '评价内容不符合要求', '订单已取消',
    '付款已确认，请重新申请取消', '取消结果待确认，请稍后查询']
  if (readable.includes(message)) return message
  return '当前操作无法完成，请刷新订单后重试'
}

export function orderWriteFailure(error: Error): OrderWriteFailure {
  const requestError = error as WriteRequestError
  const status: number | undefined = error instanceof BusinessError ? error.httpStatus : requestError.response?.status
  if (status !== undefined) {
    const unknownResult: boolean = status === 408 || status === 429 || status >= 500
    return { unknownResult, message: !unknownResult && error instanceof BusinessError ? friendlyBusinessMessage(error.message, status) : '' }
  }
  const code: string = String(requestError.code || '')
  const message: string = error.message || ''
  const unknownResult: boolean = requestError.isAxiosError === true ||
    /^(2300007|ERR_NETWORK|ECONNABORTED|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND)$/.test(code) ||
    /Failed to connect|Network Error|network connection|timeout|timed out|offline|"code"\s*:\s*2300007/i.test(message)
  return { unknownResult, message: '' }
}
