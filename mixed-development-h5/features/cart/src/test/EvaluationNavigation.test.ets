import { describe, expect, it } from '@ohos/hypium'
import { PAGE_PATH } from 'constants'
import { EvaluationNavigationActions, returnEvaluationToOrders } from '../main/ets/presentation/utils/EvaluationNavigation'

class TestEvaluationNavigation implements EvaluationNavigationActions {
  pathNames: string[] = []
  poppedIndex: number = -1
  replaced: boolean = false

  popToIndex(index: number): void {
    this.poppedIndex = index
    this.pathNames = this.pathNames.slice(0, index + 1)
  }

  removeByIndexes(indexes: number[]): void {
    this.pathNames = this.pathNames.filter((_name: string, index: number) => !indexes.includes(index))
  }

  replaceWithOrderList(): void {
    this.replaced = true
    this.pathNames.splice(Math.max(0, this.pathNames.length - 1), 1, PAGE_PATH.ORDER_PAGE)
  }
}

export default function evaluationNavigationTest(): void {
  describe('evaluationNavigation', () => {
    it('returnsDirectEvaluationToExistingList', 0, () => {
      const nav = new TestEvaluationNavigation()
      nav.pathNames = ['home', PAGE_PATH.ORDER_PAGE, PAGE_PATH.EVALUATION_PAGE]
      returnEvaluationToOrders(nav)
      expect(nav.pathNames.join(',')).assertEqual('home,' + PAGE_PATH.ORDER_PAGE)
      expect(nav.replaced).assertFalse()
    })

    it('skipsDetailWhenEvaluationStartedFromDetail', 0, () => {
      const nav = new TestEvaluationNavigation()
      nav.pathNames = ['home', PAGE_PATH.ORDER_PAGE, PAGE_PATH.ORDER_DETAIL_PAGE, PAGE_PATH.EVALUATION_PAGE]
      returnEvaluationToOrders(nav)
      expect(nav.pathNames.join(',')).assertEqual('home,' + PAGE_PATH.ORDER_PAGE)
      expect(nav.poppedIndex).assertEqual(1)
      expect(nav.replaced).assertFalse()
    })

    it('returnsToNearestListWithoutRecreatingIt', 0, () => {
      const nav = new TestEvaluationNavigation()
      nav.pathNames = [PAGE_PATH.ORDER_PAGE, PAGE_PATH.ORDER_DETAIL_PAGE, PAGE_PATH.ORDER_PAGE,
        PAGE_PATH.ORDER_DETAIL_PAGE, PAGE_PATH.EVALUATION_PAGE]
      returnEvaluationToOrders(nav)
      expect(nav.poppedIndex).assertEqual(2)
      expect(nav.pathNames.length).assertEqual(3)
      expect(nav.replaced).assertFalse()
    })

    it('replacesDirectDetailFlowWithList', 0, () => {
      const nav = new TestEvaluationNavigation()
      nav.pathNames = ['goods', PAGE_PATH.ORDER_DETAIL_PAGE, PAGE_PATH.EVALUATION_PAGE]
      returnEvaluationToOrders(nav)
      expect(nav.pathNames.join(',')).assertEqual('goods,' + PAGE_PATH.ORDER_PAGE)
      expect(nav.replaced).assertTrue()
    })

    it('opensListWhenEvaluationIsTheOnlyPage', 0, () => {
      const nav = new TestEvaluationNavigation()
      nav.pathNames = [PAGE_PATH.EVALUATION_PAGE]
      returnEvaluationToOrders(nav)
      expect(nav.pathNames.join(',')).assertEqual(PAGE_PATH.ORDER_PAGE)
    })
  })
}
