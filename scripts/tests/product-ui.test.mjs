import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageMethods, sourceOf } from './native-harness.mjs'

const mine = 'mixed-development-h5/features/mine/src/main/ets/presentation/views/'
const infoPath = 'mixed-development-h5/features/home/src/main/ets/presentation/components/GoodsInfo.ets'
const cartPath = 'mixed-development-h5/features/cart/src/main/ets/presentation/components/CartItem.ets'
function management() {
  const api = { getForSession: async () => ({ items: [], page: 1, pages: 1 }) }
  const flow = { pending: () => null, start: async () => ({ id: 'p', status: 'off' }) }
  const Page = pageMethods(mine + 'ProductManageView.ets', 'ProductManageView', {}, {
    GlobalVariable: {}, RequestAxios: api, productSave: flow, $r: value => value,
  })
  const page = new Page(); page.active = true
  page.user = { id: 'merchant', token: 'token', role: 'merchant' }
  return { page, api, flow }
}

test('相同价格只显示单价，不同启用规格保留区间，停用规格不参与', () => {
  const { page } = management()
  assert.equal(page.price({ skus: [{ enabled: true, priceCents: 2900 }] }), '¥29.00')
  assert.equal(page.price({ skus: [{ enabled: true, priceCents: 2900 }, { enabled: true, priceCents: 2900 }] }), '¥29.00')
  assert.equal(page.price({ skus: [{ enabled: true, priceCents: 1900 }, { enabled: true, priceCents: 2900 }] }), '¥19.00 ～ ¥29.00')
  assert.equal(page.price({ skus: [{ enabled: false, priceCents: 1900 }, { enabled: true, priceCents: 2900 }] }), '¥29.00')
})

test('商品两页使用深浅色资源且滚动内容紧接标题栏', () => {
  for (const name of ['ProductManageView', 'ProductEditView']) {
    const source = sourceOf(mine + name + '.ets')
    assert.doesNotMatch(source, /#[0-9A-Fa-f]{6}|Color\.White/)
    assert.match(source, /\}\s*\.align\(Alignment\.Top\)\.layoutWeight\(1\)/)
    assert.match(source, /backgroundColor\(\$r\('\[ui_components\]\.color\.(white|under)'\)\)/)
  }
})

test('列表保存与上下架成功用正常色，读取失败和版本冲突用警示色', async () => {
  const f = management(); await f.page.load(1, '商品已保存')
  assert.equal(f.page.messageKind, 'normal'); assert.equal(f.page.messageColor(), '[ui_components].color.text')
  await f.page.toggle({ id: 'p', status: 'on' })
  assert.equal(f.page.message, '已下架，买家暂时看不到'); assert.equal(f.page.messageKind, 'normal')
  f.flow.start = async () => { throw { response: { data: { reason: 'PRODUCT_REVISION_CHANGED' } } } }
  await f.page.toggle({ id: 'p', status: 'on' })
  assert.equal(f.page.messageKind, 'warning'); assert.equal(f.page.messageColor(), '[ui_components].color.red')
  f.api.getForSession = async () => { throw Error('offline') }
  await f.page.load(1, '商品已保存')
  assert.equal(f.page.messageKind, 'warning'); assert.match(f.page.message, /暂未刷新/)
  // Identical wording must not decide the severity.
  f.page.setMessage('相同文字', 'normal'); assert.equal(f.page.messageColor(), '[ui_components].color.text')
  f.page.setMessage('相同文字', 'warning'); assert.equal(f.page.messageColor(), '[ui_components].color.red')
})

test('下架及全部规格停用不能打开详情规格，单规格停用仍可选其他规格', () => {
  const Info = pageMethods(infoPath, 'GoodsInfo')
  const info = new Info()
  for (const goods of [{ status: 'off', available: true }, { status: 'on', available: false }]) {
    info.goods = goods; info.showSheet = false
    assert.equal(info.canSelectSpecification(), false)
    assert.equal(info.specificationLabel(), '暂不可选')
    info.openSpecifications(); assert.equal(info.showSheet, false)
  }
  info.goods = { status: 'on', available: true, skus: [{ enabled: true }, { enabled: false }] }
  assert.equal(info.canSelectSpecification(), true)
  assert.equal(info.specificationLabel(), '请选择')
  info.openSpecifications(); assert.equal(info.showSheet, true)
  const source = sourceOf(infoPath)
  assert.match(source, /if \(this.canSelectSpecification\(\)\)\s*\{\s*Image/)
  assert.match(source, /\.enabled\(this.canSelectSpecification\(\)\)/)
  assert.match(source, /\.onClick\(\(\) => this.openSpecifications\(\)\)/)
})

test('失效购物车规格无箭头且加减无效，删除保持可用', () => {
  const Item = pageMethods(cartPath, 'CartItem')
  const item = new Item(), counts = []
  item.cart = { available: false, count: 3 }
  item.onChangeCount = count => counts.push(count)
  item.changeCount(1); item.changeCount(-1)
  assert.deepEqual(counts, [])
  item.cart.available = true; item.changeCount(1); item.changeCount(-1)
  assert.deepEqual(counts, [4, 2])
  const source = sourceOf(cartPath)
  assert.match(source, /if \(this.cart.available\)\s*\{\s*Image\(\$r\('sys.media.ohos_ic_public_arrow_down'\)/)
  assert.match(source, /\.enableDec\(this.cart.available && this.cart.count > 1\)/)
  assert.match(source, /\.enableInc\(this.cart.available\)/)
  assert.match(source, /\.onClick\(\(\) => \{\s*this.onDelete\(\)/)
})
