// 生成文件勿手改；来源 build-profile.json5 和各模块 module.json5
export interface ModuleStructureEntry { name: string; path: string; type: string; group: string; title: string; responsibility: string; core: string }
export const MODULE_STRUCTURE: ModuleStructureEntry[] = [
  {
    "name": "phone",
    "path": "products/phone",
    "type": "entry",
    "group": "shell",
    "title": "应用入口（phone）",
    "responsibility": "把首页、分类、购物袋和我的放在一起，负责应用入口与导航。",
    "core": "交易入口必须保留，不能拆掉钱、库存和订单核心。"
  },
  {
    "name": "home",
    "path": "features/home",
    "type": "shared",
    "group": "feature",
    "title": "首页与搜索（home）",
    "responsibility": "展示商品、搜索商品，选择具体规格后加入购物袋。",
    "core": ""
  },
  {
    "name": "category",
    "path": "features/category",
    "type": "shared",
    "group": "feature",
    "title": "商品分类（category）",
    "responsibility": "按真实分类找商品，打开对应的商品列表。",
    "core": ""
  },
  {
    "name": "cart",
    "path": "features/cart",
    "type": "shared",
    "group": "feature",
    "title": "购物车与结算（cart）",
    "responsibility": "选商品、看报价、确认订单，并查看付款与售后进度。",
    "core": "钱、库存、订单的最终计算与状态由服务端同一事务保护，不可拆。"
  },
  {
    "name": "mine",
    "path": "features/mine",
    "type": "shared",
    "group": "feature",
    "title": "我的与服务（mine）",
    "responsibility": "管理个人资料、地址与服务入口，也承载商家的商品和规则维护。",
    "core": "商家改价和库存操作仍须服务端校验，不能绕过交易核心。"
  },
  {
    "name": "constants",
    "path": "commons/constants",
    "type": "shared",
    "group": "common",
    "title": "公共常量（constants）",
    "responsibility": "统一页面名称、界面尺寸和应用配置。",
    "core": ""
  },
  {
    "name": "device",
    "path": "commons/device",
    "type": "shared",
    "group": "common",
    "title": "设备适配（device）",
    "responsibility": "读取设备能力与屏幕信息，让界面适应不同尺寸。",
    "core": ""
  },
  {
    "name": "models",
    "path": "commons/models",
    "type": "shared",
    "group": "common",
    "title": "业务数据格式（models）",
    "responsibility": "说明商品、整数分金额、库存与订单数据的格式，并校验报价。",
    "core": "金额、库存和订单的契约必须保持一致，不可拆。"
  },
  {
    "name": "network",
    "path": "commons/network",
    "type": "shared",
    "group": "common",
    "title": "服务端请求（network）",
    "responsibility": "带当前会话访问服务端，把成功、失败和网络异常交回页面。",
    "core": "交易鉴权与核心请求不可拆。"
  },
  {
    "name": "storage",
    "path": "commons/storage",
    "type": "shared",
    "group": "common",
    "title": "本地数据保存（storage）",
    "responsibility": "保存本机设置和未确认请求，帮助离页后找回处理进度。",
    "core": "订单未知结果恢复记录不能因页面调整被抹掉。"
  },
  {
    "name": "ui_components",
    "path": "commons/ui-components",
    "type": "shared",
    "group": "common",
    "title": "通用界面组件（ui_components）",
    "responsibility": "提供商品卡片、导航栏、确认弹窗等共同界面。",
    "core": ""
  },
  {
    "name": "utils",
    "path": "commons/utils",
    "type": "shared",
    "group": "common",
    "title": "通用工具（utils）",
    "responsibility": "集中放格式转换、校验等各页面共用的小工具。",
    "core": ""
  }
]
