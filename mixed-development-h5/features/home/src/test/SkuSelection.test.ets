import { describe, it, expect } from '@ohos/hypium';
import { HDMSkuType } from 'ui_components';
import { normalizeSkuSelection } from '../main/ets/data/api/goodsPresentation';

export default function skuSelectionTest() {
  describe('skuSelectionTest', () => {
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
