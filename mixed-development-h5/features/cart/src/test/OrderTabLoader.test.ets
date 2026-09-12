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
  return { page: 1, pageSize: 10, state, overlays: {}, evaluations: {} }
}

class TestOrderAPI implements OrderTabAPI {
  pages: OrderPage[] = []
  details: Record<string, OrderItem> = {}
  requestedPages: number[] = []
  requestedDetails: string[] = []
  current: boolean = true
  failDetail: boolean = false
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

  getDetail(id: string): Promise<OrderItem> {
    this.requestedDetails.push(id)
    if (this.failDetail || !this.details[id]) {
      return Promise.reject(new Error('detail unavailable'))
    }
    return Promise.resolve(this.details[id])
  }

  isCurrent(): boolean {
    return this.current
  }
}

export default function orderTabLoaderTest(): void {
  describe('orderTabLoader', () => {
    it('addsLocallyPaidOrderMissingFromServerShippingTab', 0, async (done: Function) => {
      const query = request(2)
      query.overlays['local'] = { orderId: 'local', advancedState: 2, updatedAt: 1 }
      const api = new TestOrderAPI()
      api.details['local'] = order('local', 1)
      const result = await loadOrderTabPage(query, api)
      expect(result?.items.length).assertEqual(1)
      expect(result?.items[0].id).assertEqual('local')
      expect(result?.finished).assertTrue()
      done()
    })

    it('supportsLocalReceiptAndEvaluationTabs', 0, async (done: Function) => {
      for (let state: number = 3; state <= 4; state++) {
        const query = request(state)
        query.overlays['local'] = { orderId: 'local', advancedState: state, updatedAt: 1 }
        const api = new TestOrderAPI()
        api.details['local'] = order('local', 1)
        const result = await loadOrderTabPage(query, api)
        expect(result?.items[0].id).assertEqual('local')
      }
      done()
    })

    it('doesNotReviveServerCancelledOrAlreadyAdvancedOrders', 0, async (done: Function) => {
      const query = request(2)
      query.overlays['cancelled'] = { orderId: 'cancelled', advancedState: 2, updatedAt: 1 }
      query.overlays['shipped'] = { orderId: 'shipped', advancedState: 2, updatedAt: 1 }
      const api = new TestOrderAPI()
      api.details['cancelled'] = order('cancelled', 6)
      api.details['shipped'] = order('shipped', 3)
      const result = await loadOrderTabPage(query, api)
      expect(result?.items.length).assertEqual(0)
      done()
    })

    it('deduplicatesSupplementAndPagesAndSortsByCreationTime', 0, async (done: Function) => {
      const query = request(2)
      query.overlays['local'] = { orderId: 'local', advancedState: 2, updatedAt: 1 }
      const api = new TestOrderAPI()
      api.details['local'] = order('local', 1)
      api.pages = [page([order('older', 2, '2026-01-01 00:00:00'), order('local', 2)])]
      const result = await loadOrderTabPage(query, api)
      expect(result?.items.length).assertEqual(2)
      expect(result?.items[0].id).assertEqual('local')
      expect(result?.items[0].orderState).assertEqual(2)
      done()
    })

    it('continuesAfterFilteredPageInsteadOfEndingPagination', 0, async (done: Function) => {
      const query = request(1)
      query.overlays['paid'] = { orderId: 'paid', advancedState: 2, updatedAt: 1 }
      const api = new TestOrderAPI()
      api.pages = [page([order('paid', 1)], 1, 2), page([order('unpaid', 1)], 2, 2)]
      const result = await loadOrderTabPage(query, api)
      expect(api.requestedPages.length).assertEqual(2)
      expect(result?.items.length).assertEqual(1)
      expect(result?.items[0].id).assertEqual('unpaid')
      expect(result?.nextPage).assertEqual(3)
      expect(result?.finished).assertTrue()
      done()
    })

    it('removesLocalEvaluationFromPendingTab', 0, async (done: Function) => {
      const query = request(4)
      query.overlays['reviewed'] = { orderId: 'reviewed', advancedState: 4, updatedAt: 1 }
      query.evaluations['reviewed'] = { orderId: 'reviewed', score: 5, content: 'local review', createdAt: 1 }
      const api = new TestOrderAPI()
      api.details['reviewed'] = order('reviewed', 1)
      api.pages = [page([order('reviewed', 4), order('pending', 4)])]
      const result = await loadOrderTabPage(query, api)
      expect(api.requestedDetails.length).assertEqual(0)
      expect(result?.items.length).assertEqual(1)
      expect(result?.items[0].id).assertEqual('pending')
      done()
    })

    it('keepsAllTabServerPaginationWithoutDetailFanout', 0, async (done: Function) => {
      const query = request(0)
      query.pageSize = 1
      query.overlays['local'] = { orderId: 'local', advancedState: 2, updatedAt: 1 }
      const api = new TestOrderAPI()
      api.pages = [page([order('local', 1)], 1, 2)]
      const result = await loadOrderTabPage(query, api)
      expect(api.requestedDetails.length).assertEqual(0)
      expect(api.requestedPages.length).assertEqual(1)
      expect(result?.nextPage).assertEqual(2)
      expect(result?.finished).assertFalse()
      done()
    })

    it('propagatesFailureAndRetriesSamePage', 0, async (done: Function) => {
      const query = request(2)
      query.overlays['local'] = { orderId: 'local', advancedState: 2, updatedAt: 1 }
      const api = new TestOrderAPI()
      api.details['local'] = order('local', 1)
      api.failDetail = true
      let failed: boolean = false
      try {
        await loadOrderTabPage(query, api)
      } catch {
        failed = true
      }
      expect(failed).assertTrue()
      expect(query.page).assertEqual(1)
      expect(api.requestedPages.length).assertEqual(0)
      api.failDetail = false
      const result = await loadOrderTabPage(query, api)
      expect(result?.items[0].id).assertEqual('local')
      expect(api.requestedPages[0]).assertEqual(1)
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

    it('mergesAcrossPagesWithoutDuplicateRows', 0, () => {
      const query = request(0)
      const result = mergeOrdersForTab([order('same', 1)], [order('same', 2), order('other', 3)], query)
      expect(result.length).assertEqual(2)
      expect(result.find((item: OrderItem) => item.id === 'same')?.orderState).assertEqual(2)
    })
  })
}
