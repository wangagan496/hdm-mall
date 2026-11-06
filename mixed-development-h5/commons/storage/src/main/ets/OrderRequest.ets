import { RequestAxios } from 'network'
import { CheckoutDetail, CheckoutFailure, OrderRequestResult } from 'models'

interface OrderErrorBody {
  reason?: string
  result?: CheckoutDetail
}
interface OrderError extends Error {
  httpStatus?: number
  reason?: string
  result?: CheckoutDetail
  response?: OrderErrorResponse
}
interface OrderErrorResponse {
  status: number
  data?: OrderErrorBody
}
export function checkoutFailure(error: Error): CheckoutFailure {
  const failure = error as OrderError
  return { status: failure.httpStatus || failure.response?.status || 0,
    reason: failure.reason || failure.response?.data?.reason || '',
    result: failure.result || failure.response?.data?.result }
}
export function getOrderByRequestAPI(requestKey: string, token: string): Promise<OrderRequestResult> {
  return RequestAxios.getForSession<OrderRequestResult>('/member/order/by-request/' + encodeURIComponent(requestKey), token)
}

