import { OrderItem, OrderListParams, OrderPage } from 'models'
import { isOrderStateInTab } from './OrderPresentation'

/**
 * 订单列表分页流程：向服务端取一页 → 合并去重 → 去掉不属于当前栏目的订单 → 按下单时间排序。
 * 已取消的订单会被筛掉，一页可能剩不下几笔，所以不满一屏时会接着取下一页，直到凑满或服务端没有更多。
 */

export interface OrderTabRequest {
  /** 从第几页开始取 */
  page: number
  /** 一屏要显示几笔订单 */
  pageSize: number
  /** 当前栏目，对应 OrderState，0 表示“全部” */
  state: number
}

export interface OrderTabAPI {
  getPage: (params: OrderListParams) => Promise<OrderPage>
  /** 用户还停在发起这次加载的栏目和账号上吗；切走后返回 false，结果作废 */
  isCurrent: () => boolean
}

export interface OrderTabResult {
  /** 筛选后可以显示的订单 */
  items: OrderItem[]
  /** 下次“加载更多”从第几页开始 */
  nextPage: number
  /** 服务端是否已经没有更多订单 */
  finished: boolean
}

/** 合并已有订单和新取回的订单，同一订单号只留最新那份，再筛选当前栏目并排序。 */
export function mergeOrdersForTab(
  existing: OrderItem[], incoming: OrderItem[], request: OrderTabRequest
): OrderItem[] {
  const latestById: Record<string, OrderItem> = {}
  // 先放已有的，再放新取回的：同一订单号后放的会盖掉先放的，留下服务端最新状态。
  existing.concat(incoming).forEach((order: OrderItem) => {
    latestById[order.id] = order
  })
  return Object.values(latestById)
    .filter((order: OrderItem) => isOrderStateInTab(order.orderState, request.state))
    .sort(newestFirst)
}

/** 下单时间晚的排前面；时间相同再比订单号，保证每次刷新顺序都一样，列表不会上下跳。 */
function newestFirst(left: OrderItem, right: OrderItem): number {
  if (left.createTime !== right.createTime) {
    return left.createTime > right.createTime ? -1 : 1
  }
  if (left.id === right.id) {
    return 0
  }
  return left.id > right.id ? -1 : 1
}

/** 取够一屏订单；用户中途切走栏目或账号时返回 null，调用方不要使用结果。 */
export async function loadOrderTabPage(request: OrderTabRequest, api: OrderTabAPI): Promise<OrderTabResult | null> {
  let visibleOrders: OrderItem[] = []
  let page: number = request.page
  let finished: boolean = false
  do {
    if (!api.isCurrent()) {
      return null
    }
    const serverPage: OrderPage = await api.getPage({ page, pageSize: request.pageSize, orderState: request.state })
    if (!api.isCurrent()) {
      return null
    }
    const serverOrders: OrderItem[] = serverPage.items || []
    visibleOrders = mergeOrdersForTab(visibleOrders, serverOrders, request)
    page++
    // 是否取完只看服务端：这页是空的，或页码已超过总页数。
    // 不能看筛选后的数量，一页全是已取消订单不代表后面没有订单。
    finished = serverOrders.length === 0 || page > serverPage.pages
  } while (!finished && visibleOrders.length < request.pageSize)
  return { items: visibleOrders, nextPage: page, finished }
}
