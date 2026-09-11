import { describe, beforeAll, beforeEach, afterEach, afterAll, it, expect } from '@ohos/hypium';
import { AddressItem, CartGoodsModel, OrderItem } from 'models';
import { excludeCartItems, normalizeCheckoutAddress } from '../main/ets/presentation/utils/CartPresentation';
import { parsePaymentResultValue } from '../main/ets/presentation/utils/PaymentPresentation';
import {
  formatOrderCountdown,
  getOrderStateText,
  isDemoOverlayApplied,
  isPaidOrderState,
  mergeOrderState
} from '../main/ets/presentation/utils/OrderPresentation';

export default function localUnitTest() {
  describe('localUnitTest', () => {
    // Defines a test suite. Two parameters are supported: test suite name and test suite function.
    beforeAll(() => {
      // Presets an action, which is performed only once before all test cases of the test suite start.
      // This API supports only one parameter: preset action function.
    });
    beforeEach(() => {
      // Presets an action, which is performed before each unit test case starts.
      // The number of execution times is the same as the number of test cases defined by **it**.
      // This API supports only one parameter: preset action function.
    });
    afterEach(() => {
      // Presets a clear action, which is performed after each unit test case ends.
      // The number of execution times is the same as the number of test cases defined by **it**.
      // This API supports only one parameter: clear action function.
    });
    afterAll(() => {
      // Presets a clear action, which is performed after all test cases of the test suite end.
      // This API supports only one parameter: clear action function.
    });
    it('assertContain', 0, () => {
      // Defines a test case. This API supports three parameters: test case name, filter parameter, and test case function.
      let a = 'abc';
      let b = 'b';
      // Defines a variety of assertion methods, which are used to declare expected boolean conditions.
      expect(a).assertContain(b);
      expect(a).assertEqual(a);
    });
    it('preservesAddressReturnedByAPI', 0, () => {
      const address: AddressItem = {
        address: 'Hello恭喜发财',
        contact: 'Hello恭喜发财',
        fullLocation: '',
        id: 'address-id',
        isDefault: 0,
        receiver: 'Hello恭喜发财',
        provinceCode: 310000,
        cityCode: 310100,
        countyCode: 310115
      };

      expect(normalizeCheckoutAddress(address)).assertEqual(address);
    });
    it('keepsValidCheckoutAddress', 0, () => {
      const address: AddressItem = {
        address: '科苑路15号',
        contact: '139****1234',
        fullLocation: '北京市 海淀区',
        id: 'valid-address-id',
        isDefault: 1,
        receiver: '王芳',
        provinceCode: 110000,
        cityCode: 110100,
        countyCode: 110108
      };

      expect(normalizeCheckoutAddress(address)).assertEqual(address);
    });
    it('removesDeletedCartItemsFromVisibleList', 0, () => {
      const first = new CartGoodsModel({
        count: 1,
        id: 'goods-1',
        name: '商品1',
        picture: '',
        price: 10,
        selected: true,
        skuId: 'sku-1',
        stock: 10,
        attrsText: ''
      });
      const second = new CartGoodsModel({
        count: 1,
        id: 'goods-2',
        name: '商品2',
        picture: '',
        price: 20,
        selected: true,
        skuId: 'sku-2',
        stock: 10,
        attrsText: ''
      });

      const remaining = excludeCartItems([first, second], ['sku-1']);

      expect(remaining.length).assertEqual(1);
      expect(remaining[0].skuId).assertEqual('sku-2');
      expect(excludeCartItems([first, second], ['sku-1', 'sku-2']).length).assertEqual(0);
    });
    it('parsesNamedPaymentResultBeforeOtherQueryValues', 0, () => {
      expect(parsePaymentResultValue('/pay/redirect?orderId=123&success=true')).assertEqual(true);
      expect(parsePaymentResultValue('/pay/redirect?result=false&orderId=123')).assertEqual(false);
    });
    it('rejectsMalformedOrNonBooleanPaymentResult', 0, () => {
      expect(parsePaymentResultValue('/pay/redirect?success=%')).assertUndefined();
      expect(parsePaymentResultValue('/pay/redirect?orderId=123')).assertUndefined();
    });
    it('mapsOrderStateToSameTextAcrossPages', 0, () => {
      expect(getOrderStateText(1)).assertEqual('待付款');
      expect(getOrderStateText(2)).assertEqual('待发货');
      expect(getOrderStateText(3)).assertEqual('待收货');
      expect(getOrderStateText(4)).assertEqual('待评价');
      expect(getOrderStateText(5)).assertEqual('已完成');
      expect(getOrderStateText(6)).assertEqual('已取消');
      expect(getOrderStateText(0)).assertEqual('订单处理中');
    });
    it('treatsOnlyStateTwoToFourAsPaid', 0, () => {
      expect(isPaidOrderState(1)).assertFalse();
      expect(isPaidOrderState(2)).assertTrue();
      expect(isPaidOrderState(4)).assertTrue();
      expect(isPaidOrderState(5)).assertFalse();
      expect(isPaidOrderState(6)).assertFalse();
    });
    it('formatsOrderCountdownWithPaddedFields', 0, () => {
      expect(formatOrderCountdown(0)).assertEqual('已超时，等待系统取消');
      expect(formatOrderCountdown(-5)).assertEqual('已超时，等待系统取消');
      expect(formatOrderCountdown(59)).assertEqual('剩 00:59 自动取消');
      expect(formatOrderCountdown(330)).assertEqual('剩 05:30 自动取消');
      expect(formatOrderCountdown(3600)).assertEqual('剩 60:00 自动取消');
    });
    it('advancesStateViaOverlayUntilEvaluationLands', 0, () => {
      const order: OrderItem = {
        countdown: 100,
        createTime: '2024-01-01',
        id: 'order-1',
        orderState: 1,
        payChannel: 1,
        payLatestTime: '2024-01-02',
        payMoney: 10,
        payType: 1,
        postFee: 0,
        skus: [],
        totalMoney: 10,
        totalNum: 1
      };
      expect(mergeOrderState(order, null, null)).assertEqual(1);
      expect(mergeOrderState(order, { orderId: 'order-1', advancedState: 2, updatedAt: 0 }, null)).assertEqual(2);
      const cancelled: OrderItem = { ...order, orderState: 6 };
      expect(mergeOrderState(cancelled, { orderId: 'order-1', advancedState: 4, updatedAt: 0 }, null)).assertEqual(6);
      expect(mergeOrderState({ ...order, orderState: 3 }, { orderId: 'order-1', advancedState: 2, updatedAt: 0 }, null))
        .assertEqual(3);
      expect(mergeOrderState(order,
        { orderId: 'order-1', advancedState: 4, updatedAt: 0 },
        { orderId: 'order-1', score: 5, content: 'good', createdAt: 0 }
      )).assertEqual(5);
      expect(isDemoOverlayApplied(order,
        { orderId: 'order-1', advancedState: 2, updatedAt: 0 },
        null
      )).assertTrue();
      expect(isDemoOverlayApplied(order, null, null)).assertFalse();
    });
  });
}
