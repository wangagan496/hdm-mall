import { DemoOrderOverlay, LocalEvaluationItem, OrderItem, OrderListParams, OrderPage } from 'models'
import { mergeOrderState } from './OrderPresentation'

export interface OrderTabRequest {
  page: number
  pageSize: number
  state: number
  overlays: Record<string, DemoOrderOverlay>
  evaluations: Record<string, LocalEvaluationItem>
}

export interface OrderTabAPI {
  getPage: (params: OrderListParams) => Promise<OrderPage>
  getDetail: (orderId: string) => Promise<OrderItem>
  isCurrent: () => boolean
}

export interface OrderTabResult {
  items: OrderItem[]
  nextPage: number
  finished: boolean
}

/** 保留最新服务端对象，按合并后的状态筛选；补查与分页返回同一订单时只展示一次。 */
export function mergeOrdersForTab(
  existing: OrderItem[], incoming: OrderItem[], request: OrderTabRequest
): OrderItem[] {
  const byId: Record<string, OrderItem> = {}
  existing.concat(incoming).forEach((order: OrderItem) => {
    byId[order.id] = order
  })
  return Object.values(byId).filter((order: OrderItem) => {
    return request.state === 0 || mergeOrderState(
      order, request.overlays[order.id] ?? null, request.evaluations[order.id] ?? null
    ) === request.state
  }).sort((left: OrderItem, right: OrderItem) => {
    if (left.createTime === right.createTime) {
      return left.id === right.id ? 0 : left.id > right.id ? -1 : 1
    }
    return left.createTime > right.createTime ? -1 : 1
  })
}

export async function loadOrderTabPage(request: OrderTabRequest, api: OrderTabAPI): Promise<OrderTabResult | null> {
  let items: OrderItem[] = []
  let page: number = request.page
  let finished: boolean = false
  // 服务端筛选看不到本地推进的订单。首屏补查候选详情，仍让服务端取消等状态优先。
  if (page === 1 && request.state >= 2 && request.state <= 4) {
    const ids: string[] = Object.keys(request.overlays).filter((id: string) => {
      return request.overlays[id].advancedState === request.state
    })
    for (let index: number = 0; index < ids.length; index += 4) {
      if (!api.isCurrent()) {
        return null
      }
      const details: OrderItem[] = await Promise.all(ids.slice(index, index + 4).map((id: string) => api.getDetail(id)))
      if (!api.isCurrent()) {
        return null
      }
      items = mergeOrdersForTab(items, details, request)
    }
  }
  // 过滤后不足一屏时继续取下一页，不能用“不匹配”作为服务端分页结束条件。
  do {
    if (!api.isCurrent()) {
      return null
    }
    const result: OrderPage = await api.getPage({ page, pageSize: request.pageSize, orderState: request.state })
    if (!api.isCurrent()) {
      return null
    }
    const rawItems: OrderItem[] = result.items || []
    items = mergeOrdersForTab(items, rawItems, request)
    page++
    finished = rawItems.length === 0 || page > result.pages
  } while (!finished && items.length < request.pageSize)
  return { items, nextPage: page, finished }
}
