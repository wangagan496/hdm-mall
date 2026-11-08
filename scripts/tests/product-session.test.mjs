import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageMethods, deferred, tick, sourceOf } from './native-harness.mjs'

function fixture() {
  const disk = new Map(), paths = [], calls = []
  const store = { getSync: (key, fallback) => disk.get(key) ?? fallback, putSync: (key, value) => disk.set(key, value), flush: async () => {} }
  const api = { getForSession: async url => url.endsWith('/categories') ? [{ id: 'cat', name: '分类' }] : product() }
  const flow = { pending: () => null, start: async (...args) => { calls.push(args); disk.set('product-draft:merchant:' + (args[0] || 'new'), ''); return product() }, resume: async () => product() }
  const Page = pageMethods('mixed-development-h5/features/mine/src/main/ets/presentation/views/ProductEditView.ets', 'ProductEditView', {}, {
    RequestAxios: api, productSave: flow, storeManager: { getStore: () => store },
    pickProductImage: async () => '', GlobalVariable: {}, setTimeout, clearTimeout,
    Scroller: class { scrollTo() {} currentOffset() { return { yOffset: 0 } } }
  })
  const page = new Page(); page.user = { id: 'merchant', token: 'token', role: 'merchant' }
  page.stackPath = { pop: result => paths.push(result) }; page.active = true
  return { page, disk, paths, calls, api, flow }
}

test('空表单不显示错误，编辑字段才显示，保存显示全部并定位首个错误', async () => {
  const f = fixture(); f.api.getForSession = async () => [{ id: 'a' }, { id: 'b' }]
  await f.page.load()
  assert.equal(f.page.fieldError('name'), ''); assert.equal(f.page.fieldError('category'), '')
  assert.equal(f.page.fieldError('price-0'), '')
  f.page.touch('name'); assert.match(f.page.fieldError('name'), /名称/)
  assert.equal(f.page.fieldError('price-0'), '')
  const targets = []; f.page.scrollToError = id => targets.push(id)
  await f.page.save()
  assert.match(f.page.fieldError('category'), /分类/); assert.match(f.page.fieldError('price-0'), /价格/)
  assert.deepEqual(targets, ['name']); assert.equal(f.calls.length, 0)
  f.page.draft.name = '商品'; await f.page.save(); assert.equal(targets.at(-1), 'category')
  f.page.draft.categoryId = 'a'; await f.page.save(); assert.equal(targets.at(-1), 'price-0')
})

test('恢复草稿只校验有内容字段，现有商品首次打开不显示错误', async () => {
  const f = fixture(); await f.page.load()
  f.page.draft.skus[0].price = '1.999'; f.page.changed(); await tick(); await f.page.load()
  assert.equal(f.page.fieldError('name'), ''); assert.match(f.page.fieldError('price-0'), /价格/)
  const edit = fixture(); edit.page.productId = 'p'; await edit.page.load()
  edit.page.draft.name = ''; assert.equal(edit.page.fieldError('name'), '')
  edit.page.touch('name'); assert.match(edit.page.fieldError('name'), /名称/)
})

test('所有输入有标签，零库存标签有买家不可见提示', () => {
  const source = sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/views/ProductEditView.ets')
  for (const label of ['商品名称','分类','商品说明（选填）','商品图片','规格名称','价格（元）','库存']) {
    assert.ok(source.includes("this.FieldLabel('" + label + "'"), label)
  }
  assert.match(source, /为 0 时买家看不到/)
})

test('库存提示跟随当前输入，不能读取 ForEach 捕获的旧规格对象', async () => {
  const f = fixture(); await f.page.load()
  assert.equal(f.page.stockHint(0), '为 0 时买家看不到')
  f.page.draft.skus[0].stock = '20'; f.page.changed()
  assert.equal(f.page.stockHint(0), '')
  const source = sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/views/ProductEditView.ets')
  assert.match(source, /Text\(this.stockHint\(index\)\)/)
})

test('清空必须确认且取消不改草稿，已有商品不能清空，保存固定为唯一主按钮', async () => {
  const f = fixture(); await f.page.load(); f.page.draft.name = '保留草稿'; f.page.changed(); await tick()
  let dialog; f.page.getUIContext = () => ({ showAlertDialog: options => { dialog = options } })
  f.page.requestClear(); assert.equal(f.page.draft.name, '保留草稿')
  assert.equal(dialog.message, '清空后已填写的内容不会保留')
  dialog.primaryButton.action(); assert.equal(f.page.draft.name, '保留草稿')
  await dialog.secondaryButton.action(); assert.equal(f.page.draft.name, '')
  f.page.productId = 'p'; dialog = undefined; f.page.requestClear(); assert.equal(dialog, undefined)
  const source = sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/views/ProductEditView.ets')
  assert.match(source, /\.id\('product-save'\)\.width\('100%'\)/)
  assert.match(source, /if \(!this.productId\)/)
  assert.match(source, /\.onClick\(\(\) => this.requestClear\(\)\)/)
  assert.ok(source.indexOf(".id('product-save')") > source.indexOf('}.align(Alignment.Top).layoutWeight(1)'))
})

test('单分类默认选中，选择标记显式，多分类不擅自选择', async () => {
  const f = fixture(); await f.page.load()
  assert.equal(f.page.draft.categoryId, 'cat'); assert.equal(f.page.categoryLabel({ id: 'cat', name: '分类' }), '分类 ✓ 已选')
  assert.equal(f.page.categoryLabel({ id: 'other', name: '其他' }), '其他')
  const multi = fixture(); multi.api.getForSession = async () => [{ id: 'a' }, { id: 'b' }]; await multi.page.load()
  assert.equal(multi.page.draft.categoryId, '')
  const source = sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/views/ProductEditView.ets')
  assert.match(source, /分类创建后不可修改/); assert.match(source, /\.border\(/)
})
function product(revision = 1) { return { id: 'p', name: '商品', categoryId: 'cat', categoryName: '分类', description: '', picture: '', imageId: '', status: 'on', revision,
  skus: [{ id: 's', spec: '标准款', priceCents: 1900, stock: 10, enabled: true }] } }

test('编辑只提交改动字段，不把未改库存覆盖到下单后的商品', async () => {
  const f = fixture(); f.page.productId = 'p'; await f.page.load()
  f.page.draft.name = '仅改名称'; await f.page.save()
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0][1])), { expectedRevision: 1, name: '仅改名称' })
})

test('库存冲突保留填写值和其他改动，再保存使用最新库存作比较', async () => {
  const f = fixture(); f.page.productId = 'p'; await f.page.load()
  f.page.draft.name = '我的名称'; f.page.draft.skus[0].stock = '25'
  const latest = product(); latest.skus[0].stock = 8
  f.flow.start = async (...args) => { f.calls.push(args); throw { response: { status: 409, data: { reason: 'PRODUCT_STOCK_CHANGED', result: latest } } } }
  await f.page.save()
  assert.equal(f.calls[0][1].skus[0].expectedStock, 10)
  assert.equal(f.page.draft.skus[0].stock, '25'); assert.equal(f.page.draft.name, '我的名称')
  assert.equal(f.page.message, '库存刚有变化（可能有买家下单），当前为 8，你填写的 25 已保留，确认后再保存')
  f.flow.start = async (...args) => { f.calls.push(args); return latest }
  await f.page.save()
  assert.equal(f.calls[1][1].skus[0].expectedStock, 8)
  assert.equal(f.calls[1][1].skus[0].stock, 25)
})

test('商品表单自动恢复账号草稿，字段错误阻止提交，成功只回传一次', async () => {
  const f = fixture(); await f.page.load()
  f.page.draft.name = '新商品'; f.page.draft.categoryId = 'cat'; f.page.draft.skus[0].price = '1.999'
  f.page.changed(); await tick(); await f.page.save()
  assert.equal(f.calls.length, 0); assert.match(f.page.priceError(f.page.draft.skus[0]), /两位/)
  f.page.draft.skus[0].price = '19'; f.page.draft.skus[0].stock = '0'; f.page.changed(); await tick()
  assert.ok(f.disk.get('product-draft:merchant:new'))
  await f.page.save(); assert.equal(f.calls.length, 1); assert.equal(f.paths.length, 1)
  assert.equal(f.disk.get('product-draft:merchant:new'), '')
})

test('切换账号后迟到的商品读取与保存不能覆盖新表单或跳页面', async () => {
  const f = fixture(), gate = deferred()
  f.page.productId = 'p'; f.api.getForSession = () => gate.promise
  const load = f.page.load(); f.page.user = { id: 'other', token: 'other-token', role: 'merchant' }
  f.page.synchronizeSession(); f.page.draft.name = '新账号'
  gate.resolve(product()); await load
  assert.equal(f.page.draft.name, '新账号'); assert.equal(f.paths.length, 0)
})

test('版本冲突以最新数据为基准，只保留用户确实改过的字段与规格', async () => {
  const f = fixture(); f.page.productId = 'p'; await f.page.load()
  f.page.draft.name = '商家修改'; f.page.draft.skus[0].price = '22.00'
  const newest = product(4); newest.description = '另一端说明'; newest.skus[0].stock = 8
  f.flow.start = async () => { throw { response: { status: 409, data: { reason: 'PRODUCT_REVISION_CHANGED', result: newest } } } }
  await f.page.save()
  assert.equal(f.page.draft.name, '商家修改'); assert.equal(f.page.draft.description, '另一端说明')
  assert.equal(f.page.draft.skus[0].price, '22.00'); assert.equal(f.page.draft.skus[0].stock, '8')
  assert.equal(f.page.draft.revision, 4); assert.match(f.page.message, /你的修改已保留/)
  assert.equal(f.paths.length, 0)
})

test('表单恢复是普通消息，校验、图片及冲突错误显式标成警示', async () => {
  const f = fixture(); await f.page.load()
  f.page.draft.name = '草稿'; f.page.changed(); await tick(); await f.page.load()
  assert.equal(f.page.message, '已恢复上次输入'); assert.equal(f.page.messageKind, 'normal')
  await f.page.save(); assert.equal(f.page.messageKind, 'warning')
  f.page.imageFailed(); assert.equal(f.page.messageKind, 'warning')
  f.page.mergeConflict(product()); assert.equal(f.page.messageKind, 'warning')
})
