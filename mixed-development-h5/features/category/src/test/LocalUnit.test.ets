import { describe, beforeAll, beforeEach, afterEach, afterAll, it, expect } from '@ohos/hypium';
import { CategoryItem, HDMGoodsItem } from 'models';
import { findStorageBagPicture } from '../main/ets/data/api';
import {
  addStorageBagCategory,
  findCategoryIndexById,
  isStorageBagKeywordCategory,
  renameSunHatCategory,
  STORAGE_BAG_KEYWORD_CATEGORY_ID,
  updateStorageBagCategoryPicture
} from '../main/ets/data/api/categoryPresentation';

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
    it('addsStorageBagNextToHandbagCategory', 0, () => {
      const categories: CategoryItem[] = [
        {
          id: 'bags',
          name: '箱包',
          picture: '',
          children: [
            { id: 'handbag', name: '手提包', picture: '' }
          ]
        }
      ];

      const result: CategoryItem[] = addStorageBagCategory(categories, 'storage-bag.svg');
      const children = result[0].children || [];

      expect(children.length).assertEqual(2);
      expect(children[1].name).assertEqual('收纳包');
      expect(children[1].id).assertEqual(STORAGE_BAG_KEYWORD_CATEGORY_ID);
      expect(isStorageBagKeywordCategory(children[1].id)).assertTrue();
    });
    it('findsHomeCategoryByStableIdInsteadOfListPosition', 0, () => {
      const categories: CategoryItem[] = [
        { id: 'bags', name: '箱包手袋', picture: '' },
        { id: 'women', name: '气质女装', picture: '' },
        { id: 'accessories', name: '时尚饰品', picture: '' }
      ];

      expect(findCategoryIndexById(categories, 'women')).assertEqual(1);
      expect(findCategoryIndexById(categories, 'accessories')).assertEqual(2);
      expect(findCategoryIndexById(categories, 'missing')).assertEqual(-1);
    });
    it('doesNotDuplicateBackendStorageBagCategory', 0, () => {
      const categories: CategoryItem[] = [
        {
          id: 'bags',
          name: '箱包',
          picture: '',
          children: [
            { id: 'storage-bag', name: '收纳包', picture: '' }
          ]
        }
      ];

      const result: CategoryItem[] = addStorageBagCategory(categories, 'storage-bag.svg');

      expect((result[0].children || []).length).assertEqual(1);
      expect(isStorageBagKeywordCategory('storage-bag')).assertFalse();
    });
    it('renamesStrawHatCategoryWithoutChangingItsId', 0, () => {
      const categories: CategoryItem[] = [
        {
          id: 'accessories',
          name: '配饰',
          picture: '',
          children: [
            { id: 'category-straw-hat', name: '草帽', picture: 'hat.png' }
          ]
        }
      ];

      const result: CategoryItem[] = renameSunHatCategory(categories);
      const children = result[0].children || [];

      expect(children[0].id).assertEqual('category-straw-hat');
      expect(children[0].name).assertEqual('遮阳帽');
      expect(children[0].picture).assertEqual('hat.png');
    });
    it('usesStorageBagProductPictureForCategoryCover', 0, () => {
      const handbag: HDMGoodsItem = createGoodsItem('handbag', 'Vasic 牛皮通勤手提包', 'handbag.png');
      const storageBag: HDMGoodsItem = createGoodsItem(
        'storage-bag',
        'FUJITAKA 简约便携小巧皮革收纳包 焦糖棕',
        'storage-bag.png'
      );

      const picture: ResourceStr = findStorageBagPicture([handbag, storageBag]);

      expect(picture).assertEqual('storage-bag.png');
    });
    it('updatesStorageBagCategoryCoverAfterVisibleRequest', 0, () => {
      const categories: CategoryItem[] = addStorageBagCategory([
        {
          id: 'bags',
          name: '箱包',
          picture: '',
          children: [
            { id: 'handbag', name: '手提包', picture: 'handbag.png' }
          ]
        }
      ], 'fallback.svg');

      const result: CategoryItem[] = updateStorageBagCategoryPicture(categories, 'storage-bag.png');
      const children = result[0].children || [];

      expect(children[0].picture).assertEqual('handbag.png');
      expect(children[1].picture).assertEqual('storage-bag.png');
    });
  });
}

function createGoodsItem(id: string, name: string, picture: string): HDMGoodsItem {
  return {
    id,
    name,
    desc: '',
    price: '100.00',
    picture,
    orderNum: 0
  };
}
