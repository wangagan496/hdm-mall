import { PAGE_PATH } from 'constants'

export interface EvaluationNavigationActions {
  pathNames: string[]
  popToIndex: (index: number) => void
  removeByIndexes: (indexes: number[]) => void
  replaceWithOrderList: () => void
}

/** 提交完成后回到最近的订单列表，保留其标签状态，不再停留在订单详情。 */
export function returnEvaluationToOrders(actions: EvaluationNavigationActions): void {
  const names: string[] = actions.pathNames
  const listIndex: number = names.lastIndexOf(PAGE_PATH.ORDER_PAGE)
  if (listIndex >= 0) {
    actions.popToIndex(listIndex)
    return
  }
  // 直接进入详情/评价时保留非订单来源页，仅移除评价页下面连续的订单中间页。
  const indexes: number[] = []
  for (let index: number = names.length - 2; index >= 0; index--) {
    if (names[index] !== PAGE_PATH.ORDER_DETAIL_PAGE && names[index] !== PAGE_PATH.EVALUATION_PAGE) {
      break
    }
    indexes.push(index)
  }
  if (indexes.length > 0) {
    actions.removeByIndexes(indexes)
  }
  actions.replaceWithOrderList()
}
