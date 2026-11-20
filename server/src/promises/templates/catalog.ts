// 生成文件勿手改；来源 contract-kit/v1/promises/catalog.ts
export const PROMISE_TEMPLATE_VERSION = "promises-20261120-3"
export const promiseCatalog = [
  {
    "id": "return-window",
    "label": "退换期限",
    "units": [
      "小时",
      "天",
      "周",
      "个月",
      "月",
      "年"
    ],
    "valueType": "number",
    "categories": [
      "*"
    ],
    "cues": [
      "退换",
      "退货",
      "换货",
      "无理由"
    ],
    "suggestedAfterSaleKind": null
  },
  {
    "id": "dispatch-window",
    "label": "发货时效",
    "units": [
      "小时",
      "天",
      "工作日",
      "周"
    ],
    "valueType": "number",
    "categories": [
      "*"
    ],
    "cues": [
      "发货",
      "寄出",
      "出库"
    ],
    "suggestedAfterSaleKind": null
  },
  {
    "id": "shipping-cost",
    "label": "包邮或运费承担",
    "units": [],
    "valueType": "text",
    "categories": [
      "*"
    ],
    "cues": [
      "运费",
      "快递费",
      "包邮",
      "免邮",
      "邮费",
      "邮资"
    ],
    "suggestedAfterSaleKind": null
  },
  {
    "id": "warranty-window",
    "label": "保修期",
    "units": [
      "天",
      "周",
      "个月",
      "月",
      "年"
    ],
    "valueType": "number",
    "categories": [
      "*"
    ],
    "cues": [
      "保修",
      "质保",
      "维修期"
    ],
    "suggestedAfterSaleKind": null
  },
  {
    "id": "gift",
    "label": "赠品",
    "units": [],
    "valueType": "text",
    "categories": [
      "*"
    ],
    "cues": [
      "赠品",
      "赠送",
      "附送",
      "附赠",
      "买一送",
      "随单送"
    ],
    "suggestedAfterSaleKind": null
  },
  {
    "id": "material",
    "label": "材质成分",
    "units": [],
    "valueType": "text",
    "categories": [
      "*"
    ],
    "cues": [
      "材质",
      "成分",
      "面料",
      "用料",
      "尼龙",
      "帆布",
      "真皮",
      "纯棉",
      "全棉",
      "皮革",
      "聚酯",
      "涤纶",
      "羊毛",
      "绒"
    ],
    "suggestedAfterSaleKind": "return-quality"
  },
  {
    "id": "origin",
    "label": "产地",
    "units": [],
    "valueType": "text",
    "categories": [
      "*"
    ],
    "cues": [
      "产地",
      "生产地",
      "制造地",
      "制造",
      "出品"
    ],
    "suggestedAfterSaleKind": "return-quality"
  },
  {
    "id": "specification",
    "label": "规格参数",
    "units": [],
    "valueType": "text",
    "categories": [
      "*"
    ],
    "cues": [
      "规格",
      "尺寸",
      "重量",
      "容量",
      "长宽高",
      "净重",
      "参数"
    ],
    "suggestedAfterSaleKind": "return-quality"
  },
  {
    "id": "shelf-life",
    "label": "保质期或有效期",
    "units": [
      "小时",
      "天",
      "周",
      "个月",
      "月",
      "年"
    ],
    "valueType": "number",
    "categories": [
      "*"
    ],
    "cues": [
      "保质期",
      "有效期",
      "使用期限"
    ],
    "suggestedAfterSaleKind": null
  },
  {
    "id": "garment-care",
    "label": "洗涤护理",
    "units": [],
    "valueType": "text",
    "categories": [
      "服饰"
    ],
    "cues": [
      "洗涤",
      "护理",
      "机洗",
      "手洗",
      "水洗",
      "干洗",
      "漂白"
    ],
    "suggestedAfterSaleKind": null
  },
  {
    "id": "size-chart",
    "label": "尺码表",
    "units": [],
    "valueType": "text",
    "categories": [
      "服饰",
      "鞋靴"
    ],
    "cues": [
      "尺码",
      "尺码表",
      "尺码对照",
      "脚长",
      "胸围",
      "腰围",
      "臀围",
      "衣长",
      "肩宽"
    ],
    "suggestedAfterSaleKind": null
  },
  {
    "id": "fit",
    "label": "版型",
    "units": [],
    "valueType": "text",
    "categories": [
      "服饰",
      "鞋靴"
    ],
    "cues": [
      "偏大",
      "偏小",
      "标准",
      "正常尺码",
      "版型"
    ],
    "suggestedAfterSaleKind": null
  },
  {
    "id": "bag-lining",
    "label": "箱包里料",
    "units": [],
    "valueType": "text",
    "categories": [
      "箱包"
    ],
    "cues": [
      "里料",
      "衬里",
      "内衬",
      "内里"
    ],
    "suggestedAfterSaleKind": "return-quality"
  },
  {
    "id": "shoe-sole",
    "label": "鞋底材质",
    "units": [],
    "valueType": "text",
    "categories": [
      "鞋靴"
    ],
    "cues": [
      "鞋底",
      "大底",
      "外底",
      "中底",
      "底材"
    ],
    "suggestedAfterSaleKind": "return-quality"
  }
] as const
