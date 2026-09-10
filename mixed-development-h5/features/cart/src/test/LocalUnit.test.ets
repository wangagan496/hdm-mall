import { describe, beforeAll, beforeEach, afterEach, afterAll, it, expect } from '@ohos/hypium';
import { AddressItem, CartGoodsModel } from 'models';
import { excludeCartItems, normalizeCheckoutAddress } from '../main/ets/presentation/utils/CartPresentation';
import { createDemoPaymentOrderId, isDemoPaymentOrder, parsePaymentResultValue } from '../main/ets/presentation/utils/PaymentPresentation';

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
    it('createsOnlyRecognizableDemoPaymentOrders', 0, () => {
      const orderId = createDemoPaymentOrderId();
      expect(isDemoPaymentOrder(orderId)).assertTrue();
      expect(isDemoPaymentOrder('server-order-123')).assertFalse();
    });
  });
}
