import { HDMGoodsItem } from 'models'
import { Goods, GoodsDetail, GoodsProperty } from '../../domain/models'

const FALLBACK_IMAGE: string = 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=600&q=80'
const FALLBACK_SKU_MARKER: string = '_fallback_'

export function isFallbackSkuId(skuId: string): boolean {
  return skuId.includes(FALLBACK_SKU_MARKER)
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * 详情接口不可用时，基于列表页商品补齐详情结构。
 * 图片、标题、价格和商品 ID 始终来自同一个列表商品。
 */
export function generateFallbackGoods(source: HDMGoodsItem): Goods {
  // 详情接口失败时必须保留列表页的商品身份，不能重新随机拼接图片、标题和价格。
  const picture: string = typeof source.picture === 'string' ? source.picture : FALLBACK_IMAGE
  const price: string = source.price.toString()
  const oldPrice: string = (source.originalPrice || source.price).toString()
  const colorA: string = '默认款'
  const colorB: string = '经典款'

  // ── 构建商品属性（GoodsProperty[]）───────────────────────────────────────
  const prop1: GoodsProperty = { name: '品牌', value: '精选优品' }
  const prop2: GoodsProperty = { name: '材质', value: '高品质工艺材料' }
  const prop3: GoodsProperty = { name: '产地', value: '中国大陆' }
  const prop4: GoodsProperty = { name: '保修', value: '12 个月官方联保' }
  const prop5: GoodsProperty = { name: '适用人群', value: '男女通用' }

  // ── 构建详情（GoodsDetail）───────────────────────────────────────────────
  const detail: GoodsDetail = {
    pictures: [picture],
    properties: [prop1, prop2, prop3, prop4, prop5]
  }

  // ── 组装完整 Goods 对象 ───────────────────────────────────────────────────
  // 所有嵌套 specs / skus 使用对象字面量内联，由 Goods 接口上下文约束，零 as / 零 any
  const goods: Goods = {
    // ── HDMGoodsItem 基础字段 ─────────────────────────────────────────────
    id: source.id,
    name: source.name,
    desc: source.desc,
    price: price,
    picture: picture,
    orderNum: source.orderNum,
    // ── Goods 扩展字段 ────────────────────────────────────────────────────
    inventory: randInt(100, 9999),
    mainPictures: [picture],
    details: detail,
    // ── 规格（两维：颜色 × 尺码）─────────────────────────────────────────
    specs: [
      {
        name: '颜色分类',
        values: [
          { name: colorA, picture: picture, selected: true,  disabled: false },
          { name: colorB, picture: picture, selected: false, disabled: false }
        ]
      },
      {
        name: '尺码',
        values: [
          { name: 'M',  picture: null, selected: true,  disabled: false },
          { name: 'L',  picture: null, selected: false, disabled: false }
        ]
      }
    ],
    // ── SKU 组合（4个：2色 × 2码，覆盖选规格不崩溃）─────────────────────
    skus: [
      {
        id: `${source.id}_fallback_c1m`,
        skuCode: `MOCK-C1-M`,
        price: price,
        oldPrice: oldPrice,
        inventory: randInt(50, 300),
        specs: [
          { name: '颜色分类', valueName: colorA },
          { name: '尺码',     valueName: 'M' }
        ],
        specsText: `${colorA} / M`,
        picture: picture
      },
      {
        id: `${source.id}_fallback_c1l`,
        skuCode: `MOCK-C1-L`,
        price: price,
        oldPrice: oldPrice,
        inventory: randInt(50, 300),
        specs: [
          { name: '颜色分类', valueName: colorA },
          { name: '尺码',     valueName: 'L' }
        ],
        specsText: `${colorA} / L`,
        picture: picture
      },
      {
        id: `${source.id}_fallback_c2m`,
        skuCode: `MOCK-C2-M`,
        price: price,
        oldPrice: oldPrice,
        inventory: randInt(50, 300),
        specs: [
          { name: '颜色分类', valueName: colorB },
          { name: '尺码',     valueName: 'M' }
        ],
        specsText: `${colorB} / M`,
        picture: picture
      },
      {
        id: `${source.id}_fallback_c2l`,
        skuCode: `MOCK-C2-L`,
        price: price,
        oldPrice: oldPrice,
        inventory: randInt(50, 300),
        specs: [
          { name: '颜色分类', valueName: colorB },
          { name: '尺码',     valueName: 'L' }
        ],
        specsText: `${colorB} / L`,
        picture: picture
      }
    ]
  }

  return goods
}
