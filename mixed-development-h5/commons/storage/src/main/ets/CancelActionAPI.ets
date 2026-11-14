import { RequestAxios } from 'network'
import { CancelActionReceipt } from 'models'

interface CancelRequestBody { requestKey: string }
interface CancelResolveBody { requestKey: string; decision: string; reason?: string; carrier?: string; trackingNo?: string }

export function requestOrderCancelAPI(orderId: string, requestKey: string, token: string): Promise<CancelActionReceipt> {
  const data: CancelRequestBody = { requestKey }
  return RequestAxios.postWithSession<CancelActionReceipt>('/member/order/' + encodeURIComponent(orderId) + '/cancel-requests', data, token)
}

export function withdrawOrderCancelAPI(orderId: string, cancelRequestId: string, requestKey: string, token: string): Promise<CancelActionReceipt> {
  const data: CancelRequestBody = { requestKey }
  return RequestAxios.postWithSession<CancelActionReceipt>('/member/order/' + encodeURIComponent(orderId) + '/cancel-requests/' + encodeURIComponent(cancelRequestId) + '/withdraw', data, token)
}

export function resolveOrderCancelAPI(orderId: string, cancelRequestId: string, requestKey: string, decision: string, reason: string, token: string, carrier: string = '', trackingNo: string = ''): Promise<CancelActionReceipt> {
  const data: CancelResolveBody = { requestKey, decision }
  if (decision === 'reject-and-ship') { data.reason = reason; data.carrier = carrier; data.trackingNo = trackingNo }
  return RequestAxios.postWithSession<CancelActionReceipt>('/merchant/orders/' + encodeURIComponent(orderId) + '/cancel-requests/' + encodeURIComponent(cancelRequestId) + '/resolve', data, token)
}

export function getCancelActionReceiptAPI(requestKey: string, token: string): Promise<CancelActionReceipt> {
  return RequestAxios.getForSession<CancelActionReceipt>('/order-cancel-actions/by-request/' + encodeURIComponent(requestKey), token)
}
