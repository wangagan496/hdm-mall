import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, execute, pageMethods, sourceOf, tick } from './native-harness.mjs'

const result = (page = 1, pages = 3, id = 'order') => ({ items: [{ id }], page, pages, counts: pages * 10, pageSize: 10 })
function fixture() {
  const calls = [], notices = []
  const api = {
    relations: async page => result(page, 3, 'relation'),
    family: async page => result(page),
    merchant: async page => result(page, 3, 'shipment'),
  }
  const View = pageMethods('mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets', 'FamilyView', {}, {
    getFamilyRelationsPageAPI: (page, token) => { calls.push(['relations', page, token]); return api.relations(page, token) },
    getFamilyOrdersPageAPI: (page, token) => { calls.push(['family', page, token]); return api.family(page, token) },
    getMerchantOrdersPageAPI: (page, token) => { calls.push(['merchant', page, token]); return api.merchant(page, token) },
  })
  const page = new View()
  page.user = { account: 'merchant', role: 'merchant', token: 'token' }
  page.getUIContext = () => ({ getPromptAction: () => ({ showToast: value => notices.push(value.message) }) })
  return { page, api, calls, notices }
}

test('亲友与发货页独立翻页，末页因记录移除消失时回到最后一页', async () => {
  const { page, api, calls } = fixture()
  await page.loadFamilyCenter()
  await page.loadFamilyCenter(2, 3)
  assert.equal(page.familyPage, 2); assert.equal(page.merchantPage, 3)
  assert.ok(calls.every(call => call.at(-1) === 'token'))
  calls.length = 0
  api.family = async p => result(p, 1, 'last-family')
  api.merchant = async p => result(p, 2, 'last-shipment')
  await page.loadFamilyCenter()
  assert.deepEqual(calls.filter(call => call[0] !== 'relations').map(call => call.slice(0, 2)), [['family', 2], ['family', 1], ['merchant', 3], ['merchant', 2]])
  assert.equal(page.familyPage, 1); assert.equal(page.merchantPage, 2)
  assert.equal(page.familyOrders[0].id, 'last-family')
})

test('翻页失败保留当前页和内容，重试后才切换页码', async () => {
  const { page, api } = fixture()
  await page.loadFamilyCenter(1, 1)
  api.family = async () => { throw new Error('offline') }
  await page.loadFamilyCenter(2, 1)
  assert.equal(page.familyPage, 1); assert.equal(page.familyOrders[0].id, 'order')
  assert.equal(page.loading, false); assert.match(page.errorText, /加载失败/)
  api.family = async p => result(p, 3, 'next')
  await page.loadFamilyCenter(2, 1)
  assert.equal(page.familyPage, 2); assert.equal(page.familyOrders[0].id, 'next'); assert.equal(page.errorText, '')
})

test('迟到翻页不覆盖新结果，换账号后不继续请求旧列表或借用新会话', async () => {
  const { page, api, calls } = fixture(), gate = deferred()
  api.relations = async () => gate.promise
  const old = page.loadFamilyCenter(3, 3)
  page.user = { account: 'buyer', role: 'buyer', token: 'new-token' }
  api.relations = async () => result(1, 1, 'new-relation')
  page.reloadForCurrentAccount(); await tick()
  gate.resolve([]); await old; await tick()
  assert.equal(page.familyPage, 1); assert.equal(page.merchantPage, 1)
  assert.equal(page.ordersToShip.length, 0)
  assert.ok(calls.filter(c => c[0] !== 'relations').every(c => c.at(-1) === 'new-token'))
  assert.ok(!calls.some(c => c[0] === 'merchant'))
  const slow = deferred()
  api.family = async () => slow.promise
  const previousPage = page.loadFamilyCenter(2, 1); await tick()
  api.family = async () => result(3, 3, 'latest')
  await page.loadFamilyCenter(3, 1)
  slow.resolve(result(2, 3, 'old')); await previousPage
  assert.equal(page.familyPage, 3); assert.equal(page.familyOrders[0].id, 'latest')
})

test('加载期间不提交操作，重新登录或离页后的操作回应不提示旧成功也不刷新新页', async () => {
  const { page, notices, calls } = fixture()
  let submits = 0
  page.loading = true
  await page.submitThenRefresh(async () => { submits++ }, '成功')
  assert.equal(submits, 0)
  page.loading = false
  await page.loadFamilyCenter()
  calls.length = 0
  const gate = deferred()
  const submit = page.submitThenRefresh(async () => { submits++; await gate.promise }, '成功')
  assert.equal(submits, 1)
  page.user = { ...page.user, token: 'relogin' }
  gate.resolve(); await submit
  assert.equal(notices.length, 0); assert.equal(calls.length, 0)
  const loadGate = deferred(), f = fixture()
  f.api.relations = async () => loadGate.promise
  const loading = f.page.loadFamilyCenter()
  f.page.aboutToDisappear(); loadGate.resolve([]); await loading
  assert.equal(f.calls.length, 1); assert.equal(f.page.familyOrders.length, 0)
})

test('原生分页封装发送固定页大小和发起时的会话', async () => {
  const calls = []
  const api = execute(sourceOf('mixed-development-h5/features/mine/src/main/ets/data/api/family.ets'), {
    network: { RequestAxios: { getForSession: async (...args) => { calls.push(args); return result() } } },
  })
  await api.getFamilyOrdersPageAPI(2, 'family-session')
  await api.getMerchantOrdersPageAPI(3, 'merchant-session')
  await api.getFamilyRelationsForSessionAPI('relations-session')
  await api.getFamilyRelationsPageAPI(2, 'relations-page-session')
  assert.deepEqual(calls, [
    ['/member/family-orders/page?page=2&pageSize=10', 'family-session'],
    ['/merchant/orders/page?page=3&pageSize=10', 'merchant-session'],
    ['/member/relations', 'relations-session'],
    ['/member/relations/page?page=2&pageSize=10', 'relations-page-session'],
  ])
})
