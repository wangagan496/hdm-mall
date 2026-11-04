import { describe, it, expect } from '@ohos/hypium';
import { HDMSkuType } from 'ui_components';
import { normalizeSkuSelection } from '../main/ets/data/api/goodsPresentation';
import { Goods } from '../main/ets/domain/models';
import { canPreserveLoginSelection, PendingLoginSelection, restoreLoginSelection } from '../main/ets/data/api/loginSkuSelection';

export default function skuSelectionTest() {
  describe('skuSelectionTest', () => {
    it('preservesSelectionOnlyWhenAnonymousUserLogsIn', 0, () => {
      expect(canPreserveLoginSelection('', 'new')).assertTrue();
      expect(canPreserveLoginSelection('old', 'new')).assertFalse();
      expect(canPreserveLoginSelection('', '')).assertFalse();
      expect(canPreserveLoginSelection('old', '')).assertFalse();
    });

    it('restoresSelectedSpecAndCountUsingFreshPriceAndStock', 0, () => {
      const selected: HDMSkuType = normalizeSkuSelection();
      selected.id = 'real-sku'; selected.inventory = 5; selected.price = '10';
      selected.specs = [{ name: '颜色', valueName: '红色' }];
      const pending: PendingLoginSelection = { goodsId: 'goods', sku: selected, count: 2, token: 'login' };
      const latest: HDMSkuType = normalizeSkuSelection(selected);
      latest.price = '20'; latest.inventory = 3;
      const goods: Goods = { id: 'goods', skus: [latest],
        specs: [{ name: '颜色', values: [{ name: '红色' }, { name: '蓝色' }] }] } as Goods;
      const restored = restoreLoginSelection(pending, goods);
      expect(restored.invalid).assertFalse();
      expect(restored.count).assertEqual(2);
      expect(restored.sku.price).assertEqual('20');
      expect(restored.sku.inventory).assertEqual(3);
      expect(restored.specs[0].values[0].selected).assertTrue();
      expect(goods.specs[0].values[0].selected === true).assertFalse();
    });

    it('clearsRemovedChangedOrSoldOutSelectionAndInvalidQuantity', 0, () => {
      const selected: HDMSkuType = normalizeSkuSelection();
      selected.id = 'real-sku'; selected.inventory = 5;
      selected.specs = [{ name: '颜色', valueName: '红色' }];
      const pending: PendingLoginSelection = { goodsId: 'goods', sku: selected, count: 2, token: 'login' };
      const latest: HDMSkuType = normalizeSkuSelection(selected);
      const goods: Goods = { id: 'goods', skus: [latest], specs: [{ name: '颜色', values: [{ name: '红色' }] }] } as Goods;
      for (const count of [0, -1, 1.5, 6, 1000]) {
        pending.count = count;
        expect(restoreLoginSelection(pending, goods).invalid).assertTrue();
      }
      pending.count = 2; latest.inventory = 1;
      expect(restoreLoginSelection(pending, goods).sku.id).assertEqual('');
      expect(restoreLoginSelection(pending, goods).count).assertEqual(1);
      latest.inventory = 5; latest.specs = [{ name: '颜色', valueName: '蓝色' }];
      expect(restoreLoginSelection(pending, goods).invalid).assertTrue();
      goods.skus = [];
      expect(restoreLoginSelection(pending, goods).invalid).assertTrue();
    });
    it('initializesAnUnselectedSkuWithSafeFields', 0, () => {
      const sku: HDMSkuType = normalizeSkuSelection();

      expect(sku.id.length).assertEqual(0);
      expect(sku.inventory).assertEqual(0);
      expect(sku.specs.length).assertEqual(0);
      expect(sku.price).assertEqual('');
    });

    it('acceptsTheEmptyObjectUsedByAnUnselectedSku', 0, () => {
      const empty: HDMSkuType = {} as HDMSkuType;
      const sku: HDMSkuType = normalizeSkuSelection(empty);

      expect(sku.id.length).assertEqual(0);
      expect(sku.inventory).assertEqual(0);
      expect(sku.specs.length).assertEqual(0);
    });

    it('keepsPartialSelectionPreviewWithoutInventingASkuId', 0, () => {
      // @ohmos/sku also emits this shape after a specification is deselected.
      const partial: HDMSkuType = {
        picture: 'red.png',
        specsText: '红色'
      } as HDMSkuType;
      const sku: HDMSkuType = normalizeSkuSelection(partial);

      expect(sku.id.length).assertEqual(0);
      expect(sku.inventory).assertEqual(0);
      expect(sku.picture).assertEqual('red.png');
      expect(sku.specsText).assertEqual('红色');
    });

    it('preservesTheSelectedSkuAndItsInventory', 0, () => {
      const selected: HDMSkuType = {
        id: 'sku-real',
        skuCode: 'red-large',
        price: '10.00',
        oldPrice: '12.00',
        inventory: 3,
        specs: [{ name: '颜色', valueName: '红色' }],
        specsText: '红色',
        picture: 'red.png'
      };
      const sku: HDMSkuType = normalizeSkuSelection(selected);

      expect(sku.id).assertEqual(selected.id);
      expect(sku.inventory).assertEqual(3);
      expect(sku.price).assertEqual(selected.price);
      expect(sku.oldPrice).assertEqual(selected.oldPrice);
      expect(sku.skuCode).assertEqual(selected.skuCode);
      expect(sku.specs[0].valueName).assertEqual('红色');
    });

    it('preservesZeroInventoryForAnOutOfStockSku', 0, () => {
      const selected: HDMSkuType = {
        id: 'sku-sold-out',
        skuCode: '',
        price: '10.00',
        oldPrice: '',
        inventory: 0,
        specs: [],
        specsText: null,
        picture: null
      };
      const sku: HDMSkuType = normalizeSkuSelection(selected);

      expect(sku.id).assertEqual('sku-sold-out');
      expect(sku.inventory).assertEqual(0);
    });
  });
}
