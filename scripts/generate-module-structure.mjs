import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from '../server/node_modules/typescript/lib/typescript.js'
const root = resolve(import.meta.dirname, '..')
const native = resolve(root, 'mixed-development-h5')
const parse = path => {
  const result = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'))
  // TS 的 JSON 读取器能够读取 JSON5 单引号，但会额外报1327；工程合法JSON5保留原样。
  if (result.error && result.error.code !== 1327) throw new Error('Invalid project configuration: ' + path)
  return result.config
}
const copy = {
  'products/phone': ['应用入口（phone）', '把首页、分类、购物袋和我的放在一起，负责应用入口与导航。', '交易入口必须保留，不能拆掉钱、库存和订单核心。'],
  'features/home': ['首页与搜索（home）', '展示商品、搜索商品，选择具体规格后加入购物袋。', ''],
  'features/category': ['商品分类（category）', '按真实分类找商品，打开对应的商品列表。', ''],
  'features/cart': ['购物车与结算（cart）', '选商品、看报价、确认订单，并查看付款与售后进度。', '钱、库存、订单的最终计算与状态由服务端同一事务保护，不可拆。'],
  'features/mine': ['我的与服务（mine）', '管理个人资料、地址与服务入口，也承载商家的商品和规则维护。', '商家改价和库存操作仍须服务端校验，不能绕过交易核心。'],
  'commons/constants': ['公共常量（constants）', '统一页面名称、界面尺寸和应用配置。', ''],
  'commons/device': ['设备适配（device）', '读取设备能力与屏幕信息，让界面适应不同尺寸。', ''],
  'commons/models': ['业务数据格式（models）', '说明商品、整数分金额、库存与订单数据的格式，并校验报价。', '金额、库存和订单的契约必须保持一致，不可拆。'],
  'commons/network': ['服务端请求（network）', '带当前会话访问服务端，把成功、失败和网络异常交回页面。', '交易鉴权与核心请求不可拆。'],
  'commons/storage': ['本地数据保存（storage）', '保存本机设置和未确认请求，帮助离页后找回处理进度。', '订单未知结果恢复记录不能因页面调整被抹掉。'],
  'commons/ui-components': ['通用界面组件（ui_components）', '提供商品卡片、导航栏、确认弹窗等共同界面。', ''],
  'commons/utils': ['通用工具（utils）', '集中放格式转换、校验等各页面共用的小工具。', '']
}
const order = ['products/phone', 'features/home', 'features/category', 'features/cart', 'features/mine',
  'commons/constants', 'commons/device', 'commons/models', 'commons/network', 'commons/storage', 'commons/ui-components', 'commons/utils']
const modules = parse(resolve(native, 'build-profile.json5')).modules.map(item => {
  const path = item.srcPath.replace(/^\.\//, '')
  const config = parse(resolve(native, path, 'src/main/module.json5')).module
  if (!copy[path]) throw new Error('请给真实模块补充职责说明: ' + path)
  const [title, responsibility, core] = copy[path]
  return { name: config.name, path, type: config.type, group: path.startsWith('products/') ? 'shell' : path.startsWith('features/') ? 'feature' : 'common', title, responsibility, core }
}).sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path))
if (modules.length !== Object.keys(copy).length) throw new Error('工程模块清单发生变化，请核对真实结构')
const source = '// 生成文件勿手改；来源 build-profile.json5 和各模块 module.json5\n' +
  'export interface ModuleStructureEntry { name: string; path: string; type: string; group: string; title: string; responsibility: string; core: string }\n' +
  'export const MODULE_STRUCTURE: ModuleStructureEntry[] = ' + JSON.stringify(modules, null, 2) + '\n'
const target = resolve(native, 'features/mine/src/main/ets/presentation/views/ModuleStructure.ets')
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== source) throw new Error('模块结构生成文件已漂移')
} else writeFileSync(target, source)
console.log('module-structure: 1 shell, 4 shared features, 7 commons; ' + (process.argv.includes('--check') ? 'verified' : 'generated'))
