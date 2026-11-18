import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { execute, sourceOf, pageMethods, deferred } from './native-harness.mjs'

const models = execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/QuotePreview.ets'))
function quote(amountCents = 8900) {
  return { quoteId: 'NEW123', observedAt: 123, receipt: 'signed-fixture',
    lines: [{ skuId: 'a', productName: '报价商品', spec: '甲', count: 3, unitPriceCents: 3300, subtotalCents: 9900, productRevision: 2, observedAt: 123 }],
    promotion: { rule: { enabled: true, revision: 1, thresholdCents: 9900, discountCents: 1000 }, hit: true, appliedDiscountCents: 1000, remainingCents: 0 },
    subtotalCents: 9900, amountCents, details: [],
    removals: [{ skuId: 'a', removedCount: 3, amountWithoutCents: 0, decreaseCents: amountCents, losesPromotion: true, remainingCents: 9900 }], comparison: null }
}
const utilPath = 'mixed-development-h5/features/cart/src/main/ets/presentation/utils/QuotePreview.ets'
function utilities(transport = async () => quote()) {
  return execute(sourceOf(utilPath), { models, network: { RequestAxios: { postWithSession: transport } } })
}
test('报价适配只发送规格数量和签名凭据，拒绝不可消费响应', async () => {
  const calls = []
  let result = quote()
  const api = utilities(async (...args) => { calls.push(args); return result })
  assert.equal((await api.getQuotePreviewAPI('session', [{ skuId: 'a', count: 3 }], 'signed')).amountCents, 8900)
  assert.equal(calls[0][0], '/member/quote-preview')
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { items: [{ skuId: 'a', count: 3 }], previousReceipt: 'signed' })
  assert.equal(calls[0][2], 'session')
  result = { ...quote(), amountCents: 1.5 }
  await assert.rejects(api.getQuotePreviewAPI('session', undefined), /格式/)
})
test('报价凭据按账号和购买来源隔离，重新进入可以关联原报价', () => {
  const { QuoteMemory } = utilities()
  QuoteMemory.put('buyer-a', 'cart', quote())
  assert.equal(QuoteMemory.get('buyer-a', 'cart').receipt, 'signed-fixture')
  assert.equal(QuoteMemory.get('buyer-b', 'cart'), undefined)
  assert.equal(QuoteMemory.get('buyer-a', 'buy-now:a'), undefined)
})
test('同一新报价的重复刷新保留已检测到的价格或规则变化', () => {
  const { QuoteMemory } = utilities(), changed = quote(3900)
  changed.comparison = { previousQuoteId: 'OLD123', deltaCents: 500, reasons: [{ kind: 'promotion' }] }
  QuoteMemory.put('buyer-a', 'cart', changed)
  const repeated = { ...quote(3900), comparison: { previousQuoteId: 'NEW123', deltaCents: 0, reasons: [] } }
  const visible = QuoteMemory.preserveChange('buyer-a', 'cart', repeated)
  assert.equal(visible.comparison.previousQuoteId, 'OLD123')
  assert.equal(visible.comparison.deltaCents, 500)
  const next = QuoteMemory.preserveChange('buyer-a', 'cart', { ...repeated, quoteId: 'NEXT456', comparison: null })
  assert.equal(next.comparison, null)
})
test('整篮仅一件时隐藏单件反算，两件以上才显示', () => {
  const api = utilities()
  assert.equal(api.hasMultipleQuoteItems(null), false)
  assert.equal(api.hasMultipleQuoteItems({ lines: [{ count: 1 }] }), false)
  assert.equal(api.hasMultipleQuoteItems({ lines: [{ count: 2 }] }), true)
  assert.equal(api.hasMultipleQuoteItems({ lines: [{ count: 1 }, { count: 1 }] }), true)
})
test('无变化说明原编号，变化显示差额和前后编号，零差额规则变化也不藏原因', () => {
  const api = utilities(), current = quote()
  current.comparison = { previousQuoteId: 'OLD123', deltaCents: 0, reasons: [] }
  assert.equal(api.quoteComparisonText(current), '与报价 OLD123 一致')
  current.comparison.deltaCents = 200
  assert.equal(api.quoteComparisonText(current), '和刚才相比实付多了 ¥2.00（报价 OLD123 → NEW123）')
  current.comparison.deltaCents = -200
  assert.equal(api.quoteComparisonText(current), '和刚才相比实付少了 ¥2.00（报价 OLD123 → NEW123）')
  current.comparison.deltaCents = 0; current.comparison.reasons = [{ kind: 'promotion' }]
  assert.equal(api.quoteComparisonText(current), '和刚才相比实付没变，优惠规则有更新（报价 OLD123 → NEW123）')
})
test('移除整项说明所有数量和失去满减，负贡献不误报为少付', () => {
  const api = utilities(), current = quote()
  assert.equal(api.quoteRemovalText(current, 'a'), '去掉它，实付少 89.00 元；去掉会失去满减（本项共3件）')
  current.removals[0].decreaseCents = -500
  assert.match(api.quoteRemovalText(current, 'a'), /实付多 5.00 元/)
  assert.equal(api.quoteRemovalText(current, 'missing'), '')
})
test('报价失败显示服务端下架或库存原因，网络错误有重试文案', () => {
  const api = utilities()
  assert.equal(api.quoteFailureText({ response: { data: { msg: '库存不足，需要3件，可用2件' } } }), '库存不足，需要3件，可用2件')
  assert.equal(api.quoteFailureText(new Error('网络连接失败')), '网络连接失败')
})
function cartFixture() {
  const requests = [], cache = []
  const Cart = pageMethods('mixed-development-h5/features/cart/src/main/ets/presentation/views/CartView.ets', 'CartView', {}, {
    QuoteMemory: { get: () => ({ receipt: 'old-signed' }), put: (...args) => cache.push(args), preserveChange: (_account, _source, quote) => quote },
    getQuotePreviewAPI: (...args) => { const gate = deferred(); requests.push({ args, ...gate }); return gate.promise },
    quoteFailureText: error => error.message,
  })
  const page = new Cart()
  page.user = { id: 'buyer-a', token: 'token-a' }
  page.cartList = [{ skuId: 'a', count: 3, selected: true }]
  return { page, requests, cache }
}
test('购物车只接受最新选择的精确报价，离页的旧结果不能写入共享凭据', async () => {
  const f = cartFixture(), first = f.page.refreshExactQuote(), second = f.page.refreshExactQuote()
  f.requests[1].resolve(quote(9000)); await second
  f.requests[0].resolve(quote(8800)); await first
  assert.equal(f.page.exactQuote.amountCents, 9000)
  assert.equal(f.cache.length, 1)
  const last = f.page.refreshExactQuote(); f.page.isPageActive = false
  f.requests[2].resolve(quote()); await last
  assert.equal(f.cache.length, 1)
})
test('购物车换号时迟到失败不覆盖新账号，报价请求不修改购物车', async () => {
  const f = cartFixture(), original = JSON.stringify(f.page.cartList)
  const pending = f.page.refreshExactQuote()
  f.page.user = { id: 'buyer-b', token: 'token-b' }
  f.requests[0].reject(new Error('old failure')); await pending
  assert.equal(f.page.quoteError, '')
  assert.equal(JSON.stringify(f.page.cartList), original)
  assert.equal(f.cache.length, 0)
})
test('结算只把匹配规格和数量的服务端整数分报价用于实付与满减', () => {
  const Check = pageMethods('mixed-development-h5/features/cart/src/main/ets/presentation/views/CheckView.ets', 'CheckView', {}, {
    CheckoutSheet: { None: 0 }, util: { generateRandomUUID: () => 'request-key' },
  })
  const page = new Check()
  page.goodsList = [{ skuId: 'a', count: 3 }]; page.exactQuote = quote()
  page.applyExactQuoteSummary()
  assert.equal(page.summary.totalPayPrice, 89)
  assert.equal(page.promotion.amountCents, 8900)
  page.goodsList = [{ skuId: 'a', count: 1 }]; page.exactQuote = quote(9999)
  page.applyExactQuoteSummary()
  assert.equal(page.summary.totalPayPrice, 89)
})
test('构建生成的真实结构与工程配置一致，页面从我的进入且没有空位或虚构成果', () => {
  const checked = spawnSync(process.execPath, ['scripts/generate-module-structure.mjs', '--check'], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' })
  assert.equal(checked.status, 0, checked.stderr)
  const { MODULE_STRUCTURE: entries } = execute(sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/views/ModuleStructure.ets'))
  assert.equal(entries.filter(entry => entry.group === 'shell').length, 1)
  assert.equal(entries.filter(entry => entry.group === 'feature' && entry.type === 'shared').length, 4)
  assert.equal(entries.filter(entry => entry.group === 'common').length, 7)
  assert.deepEqual(JSON.parse(JSON.stringify(entries.map(entry => entry.group))), ['shell', 'feature', 'feature', 'feature', 'feature', 'common', 'common', 'common', 'common', 'common', 'common', 'common'])
  assert.deepEqual(JSON.parse(JSON.stringify(entries.map(entry => entry.name))), ['phone', 'home', 'category', 'cart', 'mine', 'constants', 'device', 'models', 'network', 'storage', 'ui_components', 'utils'])
  assert.deepEqual(JSON.parse(JSON.stringify(entries.map(entry => entry.title))), [
    '应用入口（phone）', '首页与搜索（home）', '商品分类（category）', '购物车与结算（cart）', '我的与服务（mine）',
    '公共常量（constants）', '设备适配（device）', '业务数据格式（models）', '服务端请求（network）',
    '本地数据保存（storage）', '通用界面组件（ui_components）', '通用工具（utils）',
  ])
  assert.ok(entries.find(entry => entry.name === 'cart').core.includes('钱、库存、订单'))
  const view = sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/views/ModuleBayView.ets')
  assert.doesNotMatch(view, /待接入|安装|卸载/)
  assert.match(view, /@ComponentV2/); assert.match(view, /@Local/); assert.match(view, /@Param/); assert.match(view, /@Event/); assert.match(view, /@Computed/)
  assert.match(sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets'), /pushPath\(\{ name: 'ModuleBayView'/)
  const routes = JSON.parse(sourceOf('mixed-development-h5/features/mine/src/main/resources/base/profile/router_map.json'))
  assert.ok(routes.routerMap.some(route => route.name === 'ModuleBayView'))
})
test('报价展示不出现催单或虚构费用，点击总价与逐项反算都保留可见入口', () => {
  const panel = sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/components/QuotePanel.ets')
  assert.doesNotMatch(panel, /运费|快凑单|仅剩|马上/)
  assert.doesNotMatch(panel, /服务端实付|商品 revision|满减 revision|detail\.rule|quote-v1|sku-price/)
  assert.match(panel, /line\.productName \+ ' ' \+ line\.spec/)
  assert.match(panel, /id\('quote-line-' \+ line\.skuId\)/)
  assert.match(panel, /价格依据：商品第 /)
  assert.match(panel, /满减（规则第 /)
  assert.match(panel, /quote-total/); assert.match(panel, /quote-retry/); assert.match(panel, /quote-remaining/)
  for (const page of ['CartView', 'CheckView']) {
    const source = sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/views/' + page + '.ets')
    assert.match(source, /quoteRemovalText/)
    assert.match(source, /hasMultipleQuoteItems\(this\.exactQuote\)/)
    assert.match(source, /Text\(quoteRemovalText/)
    assert.doesNotMatch(source, /label: '运费'/)
  }
  assert.match(sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/components/CartItem.ets'), /id\('cart-price-' \+ this\.cart\.skuId\)/)
  assert.match(sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/views/CheckView.ets'), /this\.promotion\.remainingCents > 0 \? \$r\('\[ui_components\]\.color\.gray'\)/)
  const checkout = sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/views/CheckView.ets')
  assert.doesNotMatch(checkout, /回首页继续选购/)
})
