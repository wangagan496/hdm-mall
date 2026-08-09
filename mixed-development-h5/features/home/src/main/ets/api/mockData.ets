import { Goods, GoodsDetail, GoodsProperty } from '../viewmodel'

// ─── 图片原料池（30张真实电商商品图，覆盖数码/服装/家居/配饰四大品类）──────────────
// 全部来自 Unsplash 公开 CDN，无防盗链限制，适用于真实设备测试
const IMAGE_POOL: string[] = [
  // ── 数码 / 电子（10张）───────────────────────────────────────────────────────
  'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1587829741301-dc798b83add3?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1527443224154-c4a573d5e214?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1546868871-7041f2a55e12?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1585386959984-a4155224a1ad?auto=format&fit=crop&w=600&q=80',
  // ── 服装 / 时尚（10张）───────────────────────────────────────────────────────
  'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1541099649105-f69ad21f3246?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1551028719-00167b16eac5?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1511499767150-a48a237f0083?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1560769629-975ec94e6a86?auto=format&fit=crop&w=600&q=80',
  // ── 家居 / 生活（6张）────────────────────────────────────────────────────────
  'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1570197571499-166b36435e9f?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=600&q=80',
  // ── 珠宝 / 配饰（4张）────────────────────────────────────────────────────────
  'https://images.unsplash.com/photo-1605100804763-247f67b3557e?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1611085583191-a3b181a88401?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1491553895911-0055eca6402d?auto=format&fit=crop&w=600&q=80',
]

// ─── 商品标题原料池（30个极真实的电商长标题，覆盖四大品类）───────────────────────
const TITLE_POOL: string[] = [
  // 数码类
  '苹果 iPhone 15 Pro Max 256GB 深空黑色 钛金属边框 A17 Pro芯片 全网通5G智能手机',
  '华为 Mate 60 Pro 512GB 雅川青 卫星通话 麒麟9000S 全新架构 旗舰智能手机',
  '小米 14 Ultra 5G手机 骁龙8 Gen3 徕卡光学 1英寸主摄 16GB+1TB 澎湃版',
  'Sony WH-1000XM5 主动降噪蓝牙头戴耳机 30小时续航 LDAC高音质 黑色',
  'Apple AirPods Pro 第二代 H2芯片 主动降噪 自适应音频 USB-C 真无线耳机',
  'MacBook Pro 14英寸 M3 Pro芯片 18GB统一内存 512GB固态 深空黑色',
  'iPad Pro 13英寸 M4芯片 超薄 Tandem OLED 128GB WiFi版 标准玻璃',
  'DJI 大疆 Air 3S 双主摄 无人机 4/3英寸CMOS 6K视频 畅飞套装',
  'Sony α7R V 全画幅微单相机 6100万像素 AI对焦追踪 8K延时摄影',
  '戴森 V15 Detect Absolute 激光除尘 真正高效过滤 无线吸尘器套装',
  // 服装类
  '耐克 Air Jordan 1 Retro High OG 芝加哥配色 男款篮球鞋 限量复刻',
  'Levi\'s 501 Original Fit 男款直筒牛仔裤 美国制造 经典复古水洗蓝',
  '优衣库 Premium Linen 亚麻混纺衬衫 男女同款 轻盈透气 夏季必备',
  '北面 The North Face Summit Series 冲锋衣 GTX防水 男款 登山旗舰款',
  'Adidas Ultraboost 24 跑步鞋 男款 LEP2.0中底 BOOST缓震 全掌碳板',
  '波司登 极寒2.0 鹅绒羽绒服 男款 零下40°C战略级保暖 防钻绒技术',
  '始祖鸟 Beta LT 硬壳冲锋衣 GORE-TEX 男款 轻量单层 攀岩登山专用',
  '耐克 Pro Dri-FIT 运动紧身裤 男款 高弹力 透气速干 训练竞技款',
  'New Balance 9060 复古运动鞋 男女款 麂皮拼接网眼 厚底增高休闲鞋',
  '安踏 KT9 篮球鞋 汤普森同款 氮科技中底 竞技版 男款专业球鞋',
  // 家居家电类
  '戴森 Airwrap 多功能美发造型器 大卷 烘干 飞翔 全套装备 限定礼盒',
  '飞利浦 Sonicare DiamondClean 9000 钻石系列声波电动牙刷 净白套装',
  '小米 智能空气净化器 4 Max 超大面积 HEPA H13 甲醛传感器 App联动',
  '松下 NR-W582MPP 变温多门冰箱 572升 纳诺怡X 玻璃面板 银河灰',
  '海尔 滚筒洗衣机 10KG 变频直驱 超薄嵌入 蒸汽除菌烘干洗烘一体',
  '格力 空调挂机 1.5匹 三级能效 自清洁 云锦III 智能变频 金色旗舰',
  '九阳 破壁料理机 L18-P691 低音破壁 免手洗 预约加热 豆浆机多功能',
  '海信 激光投影仪 100英寸 4K超高清 三色激光 超短焦 客厅旗舰影院',
  '宜家 BEKANT 升降电动工作台 160×80 白色桦木 坐站两用人体工学',
  '西门子 HB537A0S0W 嵌入式烤箱 71升 热风+上下加热 4D热风 自清洁',
]

// ─── 颜色 / 规格原料池 ────────────────────────────────────────────────────────
const COLOR_POOL: string[] = [
  '曜石黑', '珍珠白', '星辰蓝', '玫瑰金', '薄荷绿',
  '暮光紫', '琥珀棕', '钛金银', '烟灰色', '珊瑚红',
]

// ─── 内部工具方法（模块私有，不对外暴露）─────────────────────────────────────
function pickStr(pool: string[]): string {
  const idx: number = Math.floor(Math.random() * pool.length)
  return pool[idx] ?? pool[0] ?? ''
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// ─── 动态随机假数据工厂（对外唯一导出）───────────────────────────────────────────

/**
 * 根据传入的商品 id，动态生成一个字段极其完整的 Goods 对象，用于接口报错时的本地降级兜底。
 *
 * - 图片从 IMAGE_POOL（30张）随机抽取，同一次生成内三张图保持风格一致但来源随机
 * - 标题从 TITLE_POOL（30个）随机抽取
 * - 价格随机生成于 49.00 ~ 4999.00 之间
 * - mainPictures / details.pictures 均填充 3 张，彻底防止轮播图崩溃
 * - specs 含颜色+尺码两组规格，skus 含 4 个完整 SKU 组合
 *
 * @param id 商品 ID（直接透传，保证路由层 id 不丢失）
 * @returns 字段完整的 Goods 对象
 */
export function generateRandomMockGoods(id: string): Goods {
  // ── 随机抽取三张商品图（分别用于主图/轮播/详情）──────────────────────────
  const img1: string = pickStr(IMAGE_POOL)
  const img2: string = pickStr(IMAGE_POOL)
  const img3: string = pickStr(IMAGE_POOL)

  // ── 随机抽取标题 ──────────────────────────────────────────────────────────
  const title: string = pickStr(TITLE_POOL)

  // ── 随机抽取两种颜色 ──────────────────────────────────────────────────────
  const colorA: string = pickStr(COLOR_POOL)
  const colorB: string = pickStr(COLOR_POOL)

  // ── 随机生成价格 ──────────────────────────────────────────────────────────
  const priceNum: number = randInt(49, 4999)
  const oldPriceNum: number = priceNum + randInt(50, 500)
  const price: string = priceNum.toFixed(2)
  const oldPrice: string = oldPriceNum.toFixed(2)

  // ── 构建商品属性（GoodsProperty[]）───────────────────────────────────────
  const prop1: GoodsProperty = { name: '品牌', value: '精选优品' }
  const prop2: GoodsProperty = { name: '材质', value: '高品质工艺材料' }
  const prop3: GoodsProperty = { name: '产地', value: '中国大陆' }
  const prop4: GoodsProperty = { name: '保修', value: '12 个月官方联保' }
  const prop5: GoodsProperty = { name: '适用人群', value: '男女通用' }

  // ── 构建详情（GoodsDetail）───────────────────────────────────────────────
  const detail: GoodsDetail = {
    pictures: [img1, img2, img3],
    properties: [prop1, prop2, prop3, prop4, prop5]
  }

  // ── 组装完整 Goods 对象 ───────────────────────────────────────────────────
  // 所有嵌套 specs / skus 使用对象字面量内联，由 Goods 接口上下文约束，零 as / 零 any
  const goods: Goods = {
    // ── HDMGoodsItem 基础字段 ─────────────────────────────────────────────
    id: id,
    name: title,
    desc: '臻选品质，精心呈现，让每一次选购都物超所值 🎉',
    price: price,
    picture: img1,
    orderNum: randInt(1000, 99999),
    // ── Goods 扩展字段 ────────────────────────────────────────────────────
    inventory: randInt(100, 9999),
    mainPictures: [img1, img2, img3],
    details: detail,
    // ── 规格（两维：颜色 × 尺码）─────────────────────────────────────────
    specs: [
      {
        name: '颜色分类',
        values: [
          { name: colorA, picture: img1, selected: true,  disabled: false },
          { name: colorB, picture: img2, selected: false, disabled: false }
        ]
      },
      {
        name: '尺码',
        values: [
          { name: 'S',  picture: null, selected: false, disabled: false },
          { name: 'M',  picture: null, selected: true,  disabled: false },
          { name: 'L',  picture: null, selected: false, disabled: false },
          { name: 'XL', picture: null, selected: false, disabled: false }
        ]
      }
    ],
    // ── SKU 组合（4个：2色 × 2码，覆盖选规格不崩溃）─────────────────────
    skus: [
      {
        id: `${id}_mock_c1m`,
        skuCode: `MOCK-C1-M`,
        price: price,
        oldPrice: oldPrice,
        inventory: randInt(50, 300),
        specs: [
          { name: '颜色分类', valueName: colorA },
          { name: '尺码',     valueName: 'M' }
        ],
        specsText: `${colorA} / M`,
        picture: img1
      },
      {
        id: `${id}_mock_c1l`,
        skuCode: `MOCK-C1-L`,
        price: price,
        oldPrice: oldPrice,
        inventory: randInt(50, 300),
        specs: [
          { name: '颜色分类', valueName: colorA },
          { name: '尺码',     valueName: 'L' }
        ],
        specsText: `${colorA} / L`,
        picture: img1
      },
      {
        id: `${id}_mock_c2m`,
        skuCode: `MOCK-C2-M`,
        price: price,
        oldPrice: oldPrice,
        inventory: randInt(50, 300),
        specs: [
          { name: '颜色分类', valueName: colorB },
          { name: '尺码',     valueName: 'M' }
        ],
        specsText: `${colorB} / M`,
        picture: img2
      },
      {
        id: `${id}_mock_c2l`,
        skuCode: `MOCK-C2-L`,
        price: price,
        oldPrice: oldPrice,
        inventory: randInt(50, 300),
        specs: [
          { name: '颜色分类', valueName: colorB },
          { name: '尺码',     valueName: 'L' }
        ],
        specsText: `${colorB} / L`,
        picture: img2
      }
    ]
  }

  return goods
}
