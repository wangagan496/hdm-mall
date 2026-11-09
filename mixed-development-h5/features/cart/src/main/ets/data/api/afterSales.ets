import { RequestAxios } from 'network'
import { OrderItem } from 'models'
export function getAfterSaleOrderAPI(id: string,token: string): Promise<OrderItem> { return RequestAxios.getForSession<OrderItem>('/member/order/'+encodeURIComponent(id),token) }
