import { emptyCancelActions, cancelActionFailure } from './cancel-boundaries.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, execute, pageMethods, sourceOf, tick } from './native-harness.mjs'

const result = (page = 1, pages = 3, id = 'order') => ({ items: [{ id }], page, pages, counts: pages * 10, pageSize: 10 })
function fixture(identity = 'buyer') {
  const calls = [], notices = []
  const api = {
    relations: async page => result(page, 3, 'relation'),
    family: async page => result(page),
    merchant: async page => result(page, 3, 'shipment'),
  }
  const View = pageMethods('mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets', 'FamilyView', {}, {
    cancelActions: emptyCancelActions, cancelActionFailure,
    getFamilyRelationsPageAPI: (page, token) => { calls.push(['relations', page, token]); return api.relations(page, token) },
    getFamilyOrdersPageAPI: (page, token) => { calls.push(['family', page, token]); return api.family(page, token) },
    getMerchantOrdersPageAPI: (page, token) => { calls.push(['merchant', page, token]); return api.merchant(page, token) },
  })
  const page = new View()
  page.user = { account: 'member', identity, identities: ['buyer', 'merchant'], token: 'token', identityRevision: 1 }
  page.getUIContext = () => ({ getPromptAction: () => ({ showToast: value => notices.push(value.message) }) })
  return { page, api, calls, notices }
}

test('买家亲友与店主发货分别分页，末页因记录移除消失时回到最后一页', async () => {
  for (const identity of ['buyer', 'merchant']) {
    const { page, api, calls } = fixture(identity)
    const isMerchant = identity === 'merchant'
    const endpoint = isMerchant ? 'merchant' : 'family'
    const pageKey = isMerchant ? 'merchantPage' : 'familyPage'
    const requestedPage = isMerchant ? 3 : 2
    const lastPage = requestedPage - 1
    await page.loadFamilyCenter()
    await page.loadFamilyCenter(2, 3)
    assert.equal(page[pageKey], requestedPage)
    assert.ok(calls.every(call => call.at(-1) === 'token'))
    calls.length = 0
    api[endpoint] = async p => result(p, lastPage, 'last-order')
    await page.loadFamilyCenter()
    assert.deepEqual(calls.filter(call => call[0] !== 'relations'), [
      [endpoint, requestedPage, 'token'], [endpoint, lastPage, 'token'],
    ])
    assert.equal(calls.some(call => call[0] === 'relations'), !isMerchant)
    assert.equal(page[pageKey], lastPage)
    assert.equal((isMerchant ? page.ordersToShip : page.familyOrders)[0].id, 'last-order')
    assert.equal((isMerchant ? page.familyOrders : page.ordersToShip).length, 0)
  }
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
  page.user = { account: 'buyer', identity: 'buyer', token: 'new-token', identityRevision: 1 }
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

test('同一登录切回买家后，新身份版本丢弃上一次买家查询', async () => {
  const { page, api, calls } = fixture(), slow = deferred()
  api.relations = () => slow.promise
  const oldLoad = page.loadFamilyCenter()
  page.user = { ...page.user, identity: 'merchant', identityRevision: 2 }
  await page.loadFamilyCenter()
  assert.equal(page.familyRelations.length, 0)
  assert.equal(page.familyOrders.length, 0)
  assert.equal(page.ordersToShip[0].id, 'shipment')

  page.user = { ...page.user, identity: 'buyer', identityRevision: 3 }
  api.relations = async () => result(1, 1, 'current-relation')
  api.family = async () => result(1, 1, 'current-order')
  await page.loadFamilyCenter()
  const queryCount = calls.length
  slow.resolve(result(1, 1, 'old-relation'))
  await oldLoad
  assert.equal(calls.length, queryCount)
  assert.equal(page.familyRelations[0].id, 'current-relation')
  assert.equal(page.familyOrders[0].id, 'current-order')
  assert.equal(page.ordersToShip.length, 0)
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
