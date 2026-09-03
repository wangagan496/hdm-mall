import { describe, beforeAll, beforeEach, afterEach, afterAll, it, expect } from '@ohos/hypium';
import { isFallbackSkuId } from '../main/ets/data/api/mockData';
import {
  excludeFailedPicture,
  findProductPicture,
  fillPromotionGoods,
  normalizeGoodsPresentation,
  normalizeGoodsSummaryPicture
} from '../main/ets/data/api/goodsPresentation';
import {
  getBannerCategoryId,
  getBannerSearchParam,
  normalizeGoodsSummaryPictures
} from '../main/ets/data/api/home';
import { HDMGoodsItem } from 'models';
import { Banner, Goods, SearchRouterParam } from '../main/ets/domain/models';
import { filterSearchGoods } from '../main/ets/data/api/searchPresentation';

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
    it('recognizesFallbackSkuIds', 0, () => {
      expect(isFallbackSkuId('3388018_fallback_c2l')).assertTrue();
      expect(isFallbackSkuId('300081002')).assertFalse();
    });
    it('parsesBannerCategoryRoutes', 0, () => {
      expect(getBannerCategoryId('/category/1181622003')).assertEqual('1181622003');
      expect(getBannerCategoryId('/category/1181622006')).assertEqual('1181622006');
      expect(getBannerCategoryId('/goods/123')).assertEqual('');
    });
    it('routesWarmWinterBannerToSocksInsteadOfShoes', 0, () => {
      const banner: Banner = {
        id: '42',
        imgUrl: 'winter.png',
        hrefUrl: '/category/1181622006',
        type: '1'
      };

      const routeParam: SearchRouterParam | undefined = getBannerSearchParam(banner);

      expect(routeParam?.keyword).assertEqual('短袜');
      expect(routeParam?.categoryId).assertEqual('1191110004');
    });
    it('keepsClickedCardIdentityWhenOpeningDetail', 0, () => {
      const source: HDMGoodsItem = {
        id: '1750713979337965572',
        name: 'CA4LA CHELSEA BLACK ONESIZE 货号:SHK01052',
        desc: '经典不对称，柔软羊毛魅力。',
        price: '1705.00',
        picture: 'https://example.com/254385/p1.png',
        orderNum: 9
      };
      const detail: Goods = {
        id: source.id,
        name: source.name,
        desc: source.desc,
        price: '2130.08',
        picture: source.picture,
        orderNum: source.orderNum,
        inventory: 10,
        mainPictures: ['https://example.com/254385/p1.png'],
        details: { pictures: [], properties: [] },
        specs: [],
        skus: []
      };

      const normalized: Goods = normalizeGoodsPresentation(source, detail);

      expect(normalized.id).assertEqual(source.id);
      expect(normalized.name).assertEqual(source.name);
      expect(normalized.desc).assertEqual(source.desc);
      expect(normalized.price).assertEqual(source.price);
      expect(normalized.picture).assertEqual(source.picture);
      expect(normalized.mainPictures[0]).assertEqual(source.picture as string);
      expect(normalized.inventory).assertEqual(detail.inventory);
      expect(normalized.specs).assertEqual(detail.specs);
      expect(normalized.skus).assertEqual(detail.skus);
    });
    it('usesSearchCoverAsTheOnlyDetailPicture', 0, () => {
      const source: HDMGoodsItem = {
        id: '1750713979514126340',
        name: '十方未来 十方未来强化系列内衣 I TYPE 米色',
        desc: '舒适透气轻便自由',
        price: '411.00',
        picture: 'https://example.com/94076/p5.png',
        orderNum: 23
      };
      const detail: Goods = {
        id: source.id,
        name: source.name,
        desc: source.desc,
        price: '416.17',
        picture: '',
        orderNum: source.orderNum,
        inventory: 451021,
        mainPictures: [
          'https://example.com/94076/p5.png',
          'https://example.com/94113/p2.png',
          'https://example.com/94100/p1.png',
          'https://example.com/94106/p1.png',
          'https://example.com/94103/p2.png'
        ],
        details: { pictures: [], properties: [] },
        specs: [],
        skus: []
      };

      const normalizedDetail: Goods = normalizeGoodsPresentation(source, detail);

      expect(normalizedDetail.mainPictures.length).assertEqual(1);
      expect(normalizedDetail.mainPictures[0]).assertEqual('https://example.com/94076/p5.png');
      expect(normalizedDetail.picture).assertEqual('https://example.com/94076/p5.png');
    });
    it('removesFailedSlidesAndKeepsAvailablePicture', 0, () => {
      const available: string = 'https://example.com/94076/p5.png';
      const failed: string[] = [
        'https://example.com/94113/p2.png',
        'https://example.com/94100/p1.png',
        'https://example.com/94106/p1.png',
        'https://example.com/94103/p2.png'
      ];
      let pictures: string[] = [available, ...failed];

      failed.forEach((picture: string): void => {
        pictures = excludeFailedPicture(pictures, picture);
      });

      expect(pictures.length).assertEqual(1);
      expect(pictures[0]).assertEqual(available);
    });
    it('usesRepeatedDetailPictureWhenSearchCoverBelongsToAnotherProduct', 0, () => {
      const source: HDMGoodsItem = createGoodsItem(
        'wells',
        'Vasic Wells Mini Mini 牛皮抽绳单肩手提包 奶油白色'
      );
      source.picture = 'cardigan.png';
      const detail: Goods = createGoodsDetail(source, [
        'cardigan.png',
        'cream-drawstring-bag.png',
        'cream-drawstring-bag.png',
        'cream-drawstring-bag.png'
      ]);

      const picture: string = findProductPicture(source, detail);
      const normalized: HDMGoodsItem = normalizeGoodsSummaryPicture(source, detail);

      expect(picture).assertEqual('cream-drawstring-bag.png');
      expect(normalized.picture).assertEqual('cream-drawstring-bag.png');
      expect(normalized.id).assertEqual(source.id);
      expect(normalized.name).assertEqual(source.name);
    });
    it('replacesWrongOneStopCoverWithoutChangingProductIdentity', 0, () => {
      const oneStopItem: HDMGoodsItem = createGoodsItem(
        'coat-1437',
        'gym master 时尚多口袋长款保暖大衣 拼色'
      );
      oneStopItem.price = '1437';
      oneStopItem.picture = 'glasses.png';
      const coatDetail: Goods = createGoodsDetail(oneStopItem, [
        'glasses.png',
        'coat.png',
        'coat.png'
      ]);

      const normalized: HDMGoodsItem[] = normalizeGoodsSummaryPictures(
        [oneStopItem],
        [coatDetail]
      );

      expect(normalized.length).assertEqual(1);
      expect(normalized[0].id).assertEqual(oneStopItem.id);
      expect(normalized[0].name).assertEqual(oneStopItem.name);
      expect(normalized[0].price).assertEqual(oneStopItem.price);
      expect(normalized[0].picture).assertEqual('coat.png');
    });
    it('keepsPromotionCardWhenItsDetailRequestFails', 0, () => {
      const oneStopItem: HDMGoodsItem = createGoodsItem('one-stop', '一站买全商品');

      const normalized: HDMGoodsItem[] = normalizeGoodsSummaryPictures(
        [oneStopItem],
        [undefined]
      );

      expect(normalized.length).assertEqual(1);
      expect(normalized[0]).assertEqual(oneStopItem);
    });
    it('fillsOneStopPromotionToTheSameCountAsHotPromotion', 0, () => {
      const distinctOneStopGoods: HDMGoodsItem[] = [
        createGoodsItem('one-1', '一站独有商品1'),
        createGoodsItem('one-2', '一站独有商品2')
      ];
      const oneStopSectionGoods: HDMGoodsItem[] = [
        ...distinctOneStopGoods,
        createGoodsItem('shared-1', '与其他推荐区重叠商品1'),
        createGoodsItem('shared-2', '与其他推荐区重叠商品2')
      ];

      const filled: HDMGoodsItem[] = fillPromotionGoods(
        distinctOneStopGoods,
        oneStopSectionGoods,
        4
      );

      expect(filled.length).assertEqual(4);
      expect(filled[0].id).assertEqual('one-1');
      expect(filled[1].id).assertEqual('one-2');
      expect(filled[2].id).assertEqual('shared-1');
      expect(filled[3].id).assertEqual('shared-2');
    });
    it('excludesStoragePouchFromHandbagSearch', 0, () => {
      const handbag: HDMGoodsItem = createGoodsItem('handbag-1', 'Vasic 牛皮通勤手提包 灰色');
      const tote: HDMGoodsItem = createGoodsItem('tote-1', '史努比联名大容量托特包 棕色');
      const storagePouch: HDMGoodsItem = createGoodsItem(
        'pouch-1',
        'FUJITAKA 简约便携小巧皮革收纳包 焦糖棕'
      );

      const filtered: HDMGoodsItem[] = filterSearchGoods(
        [handbag, tote, storagePouch],
        '手提包'
      );

      expect(filtered.length).assertEqual(2);
      expect(filtered[0].id).assertEqual('handbag-1');
      expect(filtered[1].id).assertEqual('tote-1');
    });
    it('keepsOnlyStoragePouchForStorageBagSearch', 0, () => {
      const storagePouch: HDMGoodsItem = createGoodsItem(
        'pouch-1',
        'FUJITAKA 简约便携小巧皮革收纳包 焦糖棕'
      );
      const handbag: HDMGoodsItem = createGoodsItem('handbag-1', 'Vasic 牛皮通勤手提包 灰色');

      const filtered: HDMGoodsItem[] = filterSearchGoods([storagePouch, handbag], '收纳包');

      expect(filtered.length).assertEqual(1);
      expect(filtered[0].id).assertEqual('pouch-1');
    });
    it('keepsBackpackAliasForBackpackCategory', 0, () => {
      const backpack: HDMGoodsItem = createGoodsItem('backpack', 'CU2 舒适减负背包 紫色');
      const handbag: HDMGoodsItem = createGoodsItem('handbag', 'Vasic 牛皮手提包');

      const filtered: HDMGoodsItem[] = filterSearchGoods(
        [backpack, handbag],
        '双肩包',
        'category-backpack'
      );

      expect(filtered.length).assertEqual(1);
      expect(filtered[0].id).assertEqual('backpack');
    });
    it('acceptsSunProtectionHatForSunHatCategory', 0, () => {
      const bucketHat: HDMGoodsItem = createGoodsItem('bucket', 'COGIT UV 纯棉隔热遮光宽檐防晒帽');
      const strawHat: HDMGoodsItem = createGoodsItem('straw', '夏季透气编织草帽');

      const filtered: HDMGoodsItem[] = filterSearchGoods(
        [bucketHat, strawHat],
        '遮阳帽',
        'category-straw-hat'
      );

      expect(filtered.length).assertEqual(1);
      expect(filtered[0].id).assertEqual('bucket');
    });
    it('acceptsPrescriptionFrameForOpticalGlassesCategory', 0, () => {
      const frame: HDMGoodsItem = createGoodsItem('frame', 'NEOJIN 商务休闲近视眼镜框');
      const sunglasses: HDMGoodsItem = createGoodsItem('sunglasses', '偏光太阳镜');

      const filtered: HDMGoodsItem[] = filterSearchGoods(
        [frame, sunglasses],
        '光学眼镜',
        'category-optical-glasses'
      );

      expect(filtered.length).assertEqual(1);
      expect(filtered[0].id).assertEqual('frame');
    });
  });
}

function createGoodsItem(id: string, name: string): HDMGoodsItem {
  return {
    id,
    name,
    desc: '',
    price: '100.00',
    picture: `https://example.com/${id}.png`,
    orderNum: 0
  };
}

function createGoodsDetail(source: HDMGoodsItem, mainPictures: string[]): Goods {
  return {
    id: source.id,
    name: source.name,
    desc: source.desc,
    price: source.price,
    picture: source.picture,
    orderNum: source.orderNum,
    inventory: 10,
    mainPictures,
    details: { pictures: [], properties: [] },
    specs: [],
    skus: []
  };
}
