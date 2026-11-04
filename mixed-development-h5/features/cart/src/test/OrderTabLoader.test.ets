import { describe, expect, it } from '@ohos/hypium'
import { OrderItem, OrderListParams, OrderPage } from 'models'
import { loadOrderTabPage, mergeOrdersForTab, OrderTabAPI, OrderTabRequest } from '../main/ets/presentation/utils/OrderTabLoader'

function order(id: string, state: 1 | 2 | 3 | 4 | 5 | 6, date: string = '2026-09-12 12:00:00'): OrderItem {
  return {
    id, orderState: state, createTime: date, countdown: 100, payChannel: 1,
    payLatestTime: '', payMoney: 10, payType: 1, postFee: 0, skus: [], totalMoney: 10, totalNum: 1
  }
}

function page(items: OrderItem[], pageNumber: number = 1, pages: number = 1): OrderPage {
  return { items, page: pageNumber, pages, counts: items.length, pageSize: 10 }
}

function request(state: number): OrderTabRequest {
  return { page: 1, pageSize: 10, state }
}

class TestOrderAPI implements OrderTabAPI {
  pages: OrderPage[] = []
  requestedPages: number[] = []
  current: boolean = true
  failPage: boolean = false
  cancelAfterPage: boolean = false

  getPage(params: OrderListParams): Promise<OrderPage> {
    this.requestedPages.push(params.page)
    if (this.failPage) {
      return Promise.reject(new Error('page unavailable'))
    }
    if (this.cancelAfterPage) {
      this.current = false
    }
    return Promise.resolve(this.pages[params.page - 1] || page([]))
  }

  isCurrent(): boolean {
    return this.current
  }
}

export default function orderTabLoaderTest(): void {
  describe('orderTabLoader', () => {
    it('hidesCancelledOrdersFromAllTabAndPreservesOtherStates', 0, () => {
      const result = mergeOrdersForTab([], [
        order('unpaid', 1), order('paid', 2), order('shipped', 3),
        order('pending', 4), order('completed', 5), order('cancelled', 6)
      ], request(0))
      expect(result.length).assertEqual(5)
      expect(result.some((item: OrderItem) => item.id === 'cancelled')).assertFalse()
      expect(result.some((item: OrderItem) => item.id === 'completed')).assertTrue()
      expect(result.some((item: OrderItem) => item.id === 'unpaid')).assertTrue()
    })

    it('hidesCancelledOrdersFromUnpaidTab', 0, () => {
      const result = mergeOrdersForTab([], [
        order('unpaid', 1), order('cancelled', 6), order('paid', 2)
      ], request(1))
      expect(result.length).assertEqual(1)
      expect(result[0].id).assertEqual('unpaid')
    })

    it('removesExistingRowWhenLatestResponseIsCancelled', 0, () => {
      const result = mergeOrdersForTab([order('cancelled', 1), order('kept', 2)],
        [order('cancelled', 6)], request(0))
      expect(result.length).assertEqual(1)
      expect(result[0].id).assertEqual('kept')
    })

    it('movesOrderOutOfTabWhenLatestResponseChangesState', 0, () => {
      const result = mergeOrdersForTab([order('paid', 1), order('unpaid', 1)],
        [order('paid', 2)], request(1))
      expect(result.length).assertEqual(1)
      expect(result[0].id).assertEqual('unpaid')
    })

    it('dropsStaleCancelledRowDuringLoadMoreMerge', 0, () => {
      const result = mergeOrdersForTab(
        [order('cancelled', 6), order('kept', 2)],
        [order('newer', 3, '2026-09-13 00:00:00')],
        request(0)
      )
      expect(result.length).assertEqual(2)
      expect(result.some((item: OrderItem) => item.id === 'cancelled')).assertFalse()
      expect(result[0].id).assertEqual('newer')
      expect(result[1].id).assertEqual('kept')
    })

    it('mergesAcrossPagesWithoutDuplicateRows', 0, () => {
      const result = mergeOrdersForTab([order('same', 1)], [order('same', 2), order('other', 3)], request(0))
      expect(result.length).assertEqual(2)
      expect(result.find((item: OrderItem) => item.id === 'same')?.orderState).assertEqual(2)
    })

    it('keepsSameOrderEveryTimeWhenCreationTimeIsEqual', 0, () => {
      const first = mergeOrdersForTab([], [order('a', 1), order('b', 1)], request(0))
      const second = mergeOrdersForTab([], [order('b', 1), order('a', 1)], request(0))
      expect(first.map((item: OrderItem) => item.id).join(',')).assertEqual('b,a')
      expect(second.map((item: OrderItem) => item.id).join(',')).assertEqual('b,a')
    })

    it('continuesAllTabPaginationPastCancelledOnlyPages', 0, async (done: Function) => {
      const query = request(0)
      query.pageSize = 1
      const api = new TestOrderAPI()
      api.pages = [page([order('cancelled', 6)], 1, 2), page([order('kept', 2)], 2, 2)]
      const result = await loadOrderTabPage(query, api)
      expect(api.requestedPages.length).assertEqual(2)
      expect(result?.items.length).assertEqual(1)
      expect(result?.items[0].id).assertEqual('kept')
      expect(result?.nextPage).assertEqual(3)
      expect(result?.finished).assertTrue()
      done()
    })

    it('continuesUnpaidTabPaginationPastFilteredPages', 0, async (done: Function) => {
      const query = request(1)
      query.pageSize = 1
      const api = new TestOrderAPI()
      api.pages = [page([order('paid', 2)], 1, 2), page([order('unpaid', 1)], 2, 2)]
      const result = await loadOrderTabPage(query, api)
      expect(api.requestedPages.length).assertEqual(2)
      expect(result?.items.length).assertEqual(1)
      expect(result?.items[0].id).assertEqual('unpaid')
      expect(result?.finished).assertTrue()
      done()
    })

    it('finishesWithEmptyListWhenAllPagesAreCancelled', 0, async (done: Function) => {
      const query = request(0)
      query.pageSize = 1
      const api = new TestOrderAPI()
      api.pages = [page([order('c1', 6)], 1, 3), page([order('c2', 6)], 2, 3), page([order('c3', 6)], 3, 3)]
      const result = await loadOrderTabPage(query, api)
      expect(api.requestedPages.join(',')).assertEqual('1,2,3')
      expect(result?.items.length).assertEqual(0)
      expect(result?.nextPage).assertEqual(4)
      expect(result?.finished).assertTrue()
      done()
    })

    it('stopsOnceScreenIsFullAndKeepsNextPage', 0, async (done: Function) => {
      const query = request(0)
      query.pageSize = 1
      const api = new TestOrderAPI()
      api.pages = [page([order('first', 1)], 1, 2), page([order('second', 1)], 2, 2)]
      const result = await loadOrderTabPage(query, api)
      expect(api.requestedPages.length).assertEqual(1)
      expect(result?.nextPage).assertEqual(2)
      expect(result?.finished).assertFalse()
      done()
    })

    it('propagatesFailureAndRetriesSamePage', 0, async (done: Function) => {
      const query = request(1)
      const api = new TestOrderAPI()
      api.pages = [page([order('unpaid', 1)])]
      api.failPage = true
      let failed: boolean = false
      try {
        await loadOrderTabPage(query, api)
      } catch {
        failed = true
      }
      expect(failed).assertTrue()
      expect(query.page).assertEqual(1)
      api.failPage = false
      const result = await loadOrderTabPage(query, api)
      expect(result?.items[0].id).assertEqual('unpaid')
      expect(api.requestedPages.join(',')).assertEqual('1,1')
      done()
    })

    it('dropsLateResponseAfterTabOrAccountChange', 0, async (done: Function) => {
      const api = new TestOrderAPI()
      api.pages = [page([order('old', 1)], 1, 2)]
      api.cancelAfterPage = true
      const result = await loadOrderTabPage(request(1), api)
      expect(result).assertNull()
      expect(api.requestedPages.length).assertEqual(1)
      done()
    })
  })
}
