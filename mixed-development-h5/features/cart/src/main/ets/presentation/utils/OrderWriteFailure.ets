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

export function orderWriteFailure(error: Error): OrderWriteFailure {
  const requestError = error as WriteRequestError
  const status: number | undefined = error instanceof BusinessError ? error.httpStatus : requestError.response?.status
  if (status !== undefined) {
    const unknownResult: boolean = status === 408 || status === 429 || status >= 500
    return { unknownResult, message: !unknownResult && error instanceof BusinessError ? error.message : '' }
  }
  const code: string = String(requestError.code || '')
  const message: string = error.message || ''
  const unknownResult: boolean = requestError.isAxiosError === true ||
    /^(2300007|ERR_NETWORK|ECONNABORTED|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND)$/.test(code) ||
    /Failed to connect|Network Error|network connection|timeout|timed out|offline|"code"\s*:\s*2300007/i.test(message)
  return { unknownResult, message: '' }
}
