import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf, pageMethods, deferred } from './native-harness.mjs'

const root = 'mixed-development-h5/'

function loadProtectionHelpers() {
  const afterSales = execute(sourceOf(root + 'commons/models/src/main/ets/AfterSaleModels.ets'))
  const timeFormat = execute(sourceOf(root + 'commons/models/src/main/ets/TimeFormat.ets'))
  const presentation = execute(
    sourceOf(root + 'features/mine/src/main/ets/presentation/utils/ProtectionPresentation.ets'),
    { models: { ...afterSales, ...timeFormat } }
  )
  return { afterSales, timeFormat, presentation }
}

test('三端身份入口契约包含 merchant-protection 且与 mine/phone 路由注册一致', () => {
  const contract = sourceOf('contract-kit/v1/identity-context/entries.ts')
  const arktsEntries = sourceOf(root + 'commons/models/src/main/ets/IdentityEntries.ets')
  const serverEntries = sourceOf('server/src/identity-context/entries.ts')
  for (const content of [contract, arktsEntries, serverEntries]) {
    assert.match(content, /['"]merchant-protection['"]/)
    assert.match(content, /['"]价格保护['"]/)
  }

  const mineView = sourceOf(root + 'features/mine/src/main/ets/presentation/views/MineView.ets')
  const mineIndex = sourceOf(root + 'features/mine/src/main/ets/presentation/views/index.ets')
  const phoneIndex = sourceOf(root + 'products/phone/src/main/ets/pages/Index.ets')

  assert.match(mineView, /entryVisible\(this\.user,\s*this\.identityLayout,\s*'merchant-protection'\)/)
  assert.match(mineView, /Button\('价格保护'\)/)
  assert.match(mineView, /name:\s*'ProtectionSettingView'/)
  assert.match(mineIndex, /export \{ ProtectionSettingView \} from '\.\/ProtectionSettingView'/)
  assert.match(phoneIndex, /ProtectionSettingView/)
  assert.match(phoneIndex, /else if \(name === 'ProtectionSettingView'\) \{ ProtectionSettingView\(\) \}/)
})

test('ProtectionSettingView 使用 postWithSession、$$this 双向 bindSheet、主题配色及只读弹层', () => {
  const source = sourceOf(root + 'features/mine/src/main/ets/presentation/views/ProtectionSettingView.ets')
  assert.doesNotMatch(source, /postForSession/)
  const postCalls = [...source.matchAll(/RequestAxios\.postWithSession<[^>]+>\(([^\n]*(?:\n[^\n]*?)?,\s*token)\)/g)]
  assert.equal(postCalls.length, 3, 'draft、confirm、publish 三步均应使用 postWithSession(url, data, token)')
  assert.match(source, /RequestAxios\.postWithSession<PriceProtectionDraftResult>\('\/merchant\/settings\/protection\/draft',\s*input,\s*token\)/)
  assert.match(source, /const confirmInput:\s*PriceProtectionConfirmInput\s*=\s*\{\s*policyId:\s*draft\.policyId,\s*policyHash:\s*draft\.policyHash\s*\}/)
  assert.match(source, /RequestAxios\.postWithSession<PriceProtectionConfirmResult>\('\/merchant\/settings\/protection\/confirm',\s*confirmInput,\s*token\)/)
  assert.match(source, /const publishInput:\s*PriceProtectionPublishInput\s*=\s*\{\s*token:\s*this\.pendingToken,\s*policyId:\s*this\.pendingPolicyId,\s*requestKey:\s*util\.generateRandomUUID\(\)\s*\}/)
  assert.match(source, /RequestAxios\.postWithSession<PriceProtectionPublishResult>\('\/merchant\/settings\/protection\/publish',\s*publishInput,\s*token\)/)

  assert.match(source, /\.bindSheet\(\$\$this\.confirmVisible,\s*this\.confirmSheet\(\)/)
  assert.match(source, /onDisappear:\s*\(\)\s*=>/)
  assert.match(source, /\$r\('\[ui_components\]\.color\.white'\)/)
  assert.match(source, /\$r\('\[ui_components\]\.color\.text'\)/)
  assert.match(source, /\$r\('\[ui_components\]\.color\.gray'\)/)
  assert.match(source, /\$r\('\[ui_components\]\.color\.red'\)/)
  assert.match(source, /\$r\('\[ui_components\]\.color\.under'\)/)

  const sheet = source.slice(source.indexOf('confirmSheet()'), source.indexOf('  build()'))
  assert.match(sheet, /buildProtectionConfirmSummary\(/)
  assert.match(sheet, /已下的订单继续按原版本保护/)
})

test('ProtectionSettingView 表单校验、draft→confirm→publish 三步流转、403/409 中文提示与重试、账号切换隔离', async () => {
  const { timeFormat, presentation } = loadProtectionHelpers()
  const postCalls = []
  const getCalls = []
  const gate = deferred()
  let nextUuid = 0
  let mockPolicies = []
  let confirmImpl = async () => ({ token: 'confirm-token-1' })
  let publishImpl = async () => ({ receiptId: 'receipt-1', policyId: 'policy-1', publishedAt: 1700000000000 })

  const Page = pageMethods(
    root + 'features/mine/src/main/ets/presentation/views/ProtectionSettingView.ets',
    'ProtectionSettingView',
    {
      models: { ...timeFormat },
      '../utils/ProtectionPresentation': presentation,
    },
    {
      ...timeFormat,
      ...presentation,
      util: { generateRandomUUID: () => 'uuid-' + (++nextUuid) },
      RequestAxios: {
        getForSession: async (url, token) => {
          getCalls.push({ url, token })
          if (getCalls.length === 99) return gate.promise
          return mockPolicies
        },
        postWithSession: async (url, data, token) => {
          postCalls.push({ url, data: structuredClone(data), token })
          if (url.endsWith('/draft')) return { policyId: 'policy-1', policyHash: 'h'.repeat(64) }
          if (url.endsWith('/confirm')) return confirmImpl(data, token)
          if (url.endsWith('/publish')) return publishImpl(data, token)
          throw new Error('unexpected url ' + url)
        }
      }
    }
  )

  const page = new Page()
  page.active = true
  page.user = { id: 'm1', token: 'tok-m1', identity: 'merchant' }

  // 1) 参数边界拦截，不发起请求
  page.windowDays = '0'; page.budgetPerOrder = '10.00'; page.totalBudget = '500.00'; page.effectiveDays = '1'
  await page.prepare(); assert.equal(postCalls.length, 0); assert.match(page.message, /1 到 90/)

  page.windowDays = '7'; page.budgetPerOrder = '10.00'; page.totalBudget = '5.00'
  await page.prepare(); assert.equal(postCalls.length, 0); assert.match(page.message, /总预算/)

  page.totalBudget = '500.00'; page.effectiveDays = '31'
  await page.prepare(); assert.equal(postCalls.length, 0); assert.match(page.message, /1 到 30/)

  // 2) 正常 draft -> confirm 弹层，再 publish -> 重拉列表且保留成功提示
  page.effectiveDays = '2'
  await page.prepare()
  assert.equal(page.confirmVisible, true)
  assert.equal(postCalls.length, 2)
  assert.equal(postCalls[0].url, '/merchant/settings/protection/draft')
  assert.equal(postCalls[0].token, 'tok-m1')
  assert.equal(postCalls[0].data.effectiveAtOffset, 2 * 86400)
  assert.equal(postCalls[1].url, '/merchant/settings/protection/confirm')
  assert.equal(postCalls[1].token, 'tok-m1')
  assert.deepEqual(postCalls[1].data, { policyId: 'policy-1', policyHash: 'h'.repeat(64) })

  mockPolicies = [{
    policyId: 'policy-1', version: 1, windowDays: 7, budgetPerOrderCents: 1000,
    totalBudgetCents: 50000, announcedAt: 1000, effectiveAt: 1000, published: true, receiptId: 'receipt-1'
  }]
  await page.publish()
  assert.equal(postCalls.length, 3)
  assert.equal(postCalls[2].url, '/merchant/settings/protection/publish')
  assert.equal(postCalls[2].token, 'tok-m1')
  assert.equal(postCalls[2].data.token, 'confirm-token-1')
  assert.equal(page.confirmVisible, false)
  assert.match(page.message, /旧订单继续按原版本保护/)
  assert.equal(page.policies.length, 1)

  // 3) 403 凭据过期中文提示并清空状态，允许重新发起
  await page.prepare()
  assert.equal(page.confirmVisible, true)
  publishImpl = async () => { const err = new Error('expired'); err.httpStatus = 403; throw err }
  await page.publish()
  assert.equal(page.confirmVisible, false)
  assert.match(page.message, /过期/)

  // 重新发起应能顺利重开 confirm 弹层并发布成功
  publishImpl = async () => ({ receiptId: 'receipt-2', policyId: 'policy-1', publishedAt: 1700000001000 })
  await page.prepare()
  assert.equal(page.confirmVisible, true)

  // 4) 409 已发布/凭据已用中文提示并关闭弹层，之后仍可再发起
  publishImpl = async () => { const err = new Error('used'); err.httpStatus = 409; throw err }
  await page.publish()
  assert.equal(page.confirmVisible, false)
  assert.match(page.message, /已发布|已用/)

  // 5) 迟到响应隔离：账号切换后旧请求返回不得污染新账号
  const gateLoad = deferred()
  const IsolatedPage = pageMethods(
    root + 'features/mine/src/main/ets/presentation/views/ProtectionSettingView.ets',
    'ProtectionSettingView',
    { models: { ...timeFormat }, '../utils/ProtectionPresentation': presentation },
    {
      ...timeFormat,
      ...presentation,
      util: { generateRandomUUID: () => 'u1' },
      RequestAxios: {
        getForSession: () => gateLoad.promise,
        postWithSession: async () => { throw new Error('unused') }
      }
    }
  )
  const isolated = new IsolatedPage()
  isolated.active = true
  isolated.user = { id: 'm1', token: 'tok-m1', identity: 'merchant' }
  const loading = isolated.load()
  isolated.user = { id: 'm2', token: 'tok-m2', identity: 'merchant' }
  isolated.query++
  gateLoad.resolve([{ policyId: 'stale', version: 9, windowDays: 30, budgetPerOrderCents: 9900, totalBudgetCents: 99000, announcedAt: 1, effectiveAt: 1, published: true, receiptId: 'r9' }])
  await loading
  assert.equal(isolated.policies.length, 0)
})

test('OrderDetailView 买家价保区块仅在 protectionBrief 非空时渲染，只读无按钮，null 时零渲染', () => {
  const source = sourceOf(root + 'features/cart/src/main/ets/presentation/views/OrderDetailView.ets')
  const start = source.indexOf('if (this.order.protectionBrief)')
  assert.ok(start > 0, 'OrderDetailView 应使用 if (this.order.protectionBrief) 控制价保区块')
  const end = source.indexOf('if(this.order.canApplyAfterSale)', start)
  assert.ok(end > start)
  const block = source.slice(start, end)

  assert.doesNotMatch(block, /Button\(/)
  assert.doesNotMatch(block, /\.onClick\(/)
  assert.match(block, /价格保护/)
  assert.match(block, /formatOrderProtectionBudget\(this\.order\.protectionBrief\)/)
  assert.match(block, /formatOrderProtectionEffective\(this\.order\.protectionBrief\)/)
  assert.match(block, /保价不保库存；降价后由你本人确认补差，不会自动退款。/)
  assert.match(block, /\$r\('\[ui_components\]\.color\.white'\)/)
  assert.match(block, /\$r\('\[ui_components\]\.color\.text'\)/)
  assert.match(block, /\$r\('\[ui_components\]\.color\.gray'\)/)

  // 运行 OrderPresentation 验证 null 与非空语义
  const timeFormat = execute(sourceOf(root + 'commons/models/src/main/ets/TimeFormat.ets'))
  const orderPres = execute(
    sourceOf(root + 'features/cart/src/main/ets/presentation/utils/OrderPresentation.ets'),
    {
      models: { OrderState: {}, ...timeFormat },
      '@kit.BasicServicesKit': { systemDateTime: { getUptime: () => 0, TimeType: { STARTUP: 0 } } }
    }
  )
  assert.equal(orderPres.hasOrderProtection(null), false)
  assert.equal(orderPres.hasOrderProtection({ id: 'o1', protectionBrief: null }), false)
  assert.equal(orderPres.hasOrderProtection({ id: 'o2', protectionBrief: undefined }), false)

  const brief = {
    policyId: 'p1', windowDays: 7, budgetPerOrderCents: 1250,
    effectiveAt: Date.UTC(2026, 10, 20, 4, 30, 0), announcedAt: Date.UTC(2026, 10, 19, 4, 30, 0), receiptId: 'r1'
  }
  assert.equal(orderPres.hasOrderProtection({ id: 'o3', protectionBrief: brief }), true)
  assert.equal(orderPres.formatOrderProtectionBudget(brief), '单笔最多补 ¥12.50')
  assert.equal(orderPres.formatOrderProtectionEffective(brief), '本政策自 2026-11-20 12:30 起生效')
})
