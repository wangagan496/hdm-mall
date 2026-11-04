import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, pageMethods, tick } from './native-harness.mjs'

const test = (name, run) => nodeTest(name, { timeout: 2000 }, run)
const OrderState = { AWAITING_PAYMENT: 1, AWAITING_SHIPMENT: 2, AWAITING_RECEIPT: 3 }
const pageResult = (items, page = 1) => ({ items, page, pages: 3, counts: 21, pageSize: 10 })
const payment = { id: 'pay', orderState: 1, canPay: true, payMoney: 19, ownerAccount: 'owner' }
const receipt = { id: 'receipt', orderState: 3, canReceive: true, payMoney: 19 }
const shipment = { id: 'shipment', orderState: 2 }

function fixture() {
  const queries = [], writes = [], messages = [], dialogs = []
  let mutation = async () => ({ id: 'result' })
  const api = {
    relations: async p => pageResult([{ id: 'relation', ownerAccount: 'owner', friendAccount: 'member', status: 'pending' }], p),
    family: async p => pageResult([{ ...payment }, { ...receipt }], p),
    merchant: async p => pageResult([{ ...shipment }], p),
  }
  const write = (action, args) => { writes.push([action, ...args]); return mutation(action, args) }
  const View = pageMethods('mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets', 'FamilyView', {}, {
    OrderState,
    getFamilyRelationsPageAPI: (p, token) => { queries.push(['relations', p, token]); return api.relations(p, token) },
    getFamilyOrdersPageAPI: (p, token) => { queries.push(['family', p, token]); return api.family(p, token) },
    getMerchantOrdersPageAPI: (p, token) => { queries.push(['merchant', p, token]); return api.merchant(p, token) },
    inviteRelationAPI: (...args) => write('invite', args), updateRelationAPI: (...args) => write('relation', args),
    receiveOrderAPI: (...args) => write('receipt', args), familyPayAPI: (...args) => write('pay', args),
    shipOrderAPI: (...args) => write('ship', args),
  })
  const page = new View(); page.user = { token: 'token-a', account: 'member', role: 'merchant' }
  page.getUIContext = () => ({ getPromptAction: () => ({ showToast: value => messages.push(value.message) }),
    showAlertDialog: dialog => dialogs.push(dialog) })
  const invoke = action => {
    if (action === 'invite') { page.friendAccount = ' friend '; page.sendFamilyInvitation() }
    if (action === 'accept') page.acceptFamilyInvitation('relation')
    if (action === 'revoke') page.removeFamilyRelation('relation')
    if (action === 'ship') page.shipOrder(page.ordersToShip[0] || shipment)
    if (action === 'pay' || action === 'receipt') {
      if (action === 'pay') page.confirmFamilyPayment(page.familyOrders.find(item => item.id === 'pay') || payment)
      else page.confirmFamilyReceipt(page.familyOrders.find(item => item.id === 'receipt') || receipt)
      dialogs.at(-1)?.secondaryButton.action()
    }
  }
  return { page, api, queries, writes, messages, dialogs, invoke, setMutation: fn => { mutation = fn } }
}

test('亲友中心首次加载、刷新及失败保留的列表不能执行写操作', async () => {
  const f = fixture(); f.page.friendAccount = 'friend'; f.page.sendFamilyInvitation(); await tick()
  assert.equal(f.writes.length, 0)
  await f.page.loadFamilyCenter()
  const gate = deferred(); f.api.relations = () => gate.promise
  const loading = f.page.loadFamilyCenter()
  for (const action of ['invite', 'accept', 'revoke', 'ship', 'pay', 'receipt']) f.invoke(action)
  assert.equal(f.writes.length, 0); assert.equal(f.dialogs.length, 0)
  gate.reject(new Error('offline')); await loading
  for (const action of ['invite', 'accept', 'revoke', 'ship', 'pay', 'receipt']) f.invoke(action)
  assert.equal(f.writes.length, 0); assert.equal(f.dialogs.length, 0)
  f.api.relations = async p => pageResult([], p); await f.page.loadFamilyCenter()
  f.invoke('invite'); await tick(); assert.deepEqual(f.writes[0], ['invite', 'friend', 'token-a'])
})

test('换账号清空邀请输入和全部列表，资料变化不重读，注销与隐藏不查询', async () => {
  const f = fixture(); await f.page.loadFamilyCenter(); f.page.friendAccount = 'private-friend'
  f.page.user = { token: 'token-b', account: 'member-b', role: 'buyer' }
  f.page.sendFamilyInvitation(); assert.equal(f.writes.length, 0)
  const gate = deferred(); f.api.relations = () => gate.promise; f.page.reloadForCurrentAccount()
  assert.equal(f.page.friendAccount, ''); assert.equal(f.page.familyOrders.length, 0)
  assert.equal(f.page.ordersToShip.length, 0); assert.equal(f.page.familyRelations.length, 0)
  gate.resolve(pageResult([])); await tick()
  const count = f.queries.length
  f.page.user = { ...f.page.user, nickname: 'new' }; f.page.reloadForCurrentAccount(); await tick()
  assert.equal(f.queries.length, count)
  f.page.aboutToDisappear(); f.page.refreshAfterForeground?.(); await f.page.loadFamilyCenter()
  assert.equal(f.queries.length, count)
  f.page.user = {}; f.page.reloadForCurrentAccount(); await tick()
  assert.equal(f.page.familyOrders.length, 0); assert.equal(f.page.loading, false); assert.equal(f.queries.length, count)
})

test('亲友全部写入口固定凭证，旧成功失败及收尾不能干扰重进后的新操作', async () => {
  for (const action of ['invite', 'accept', 'revoke', 'ship', 'pay', 'receipt'])
    for (const changedAccount of [false, true]) for (const failed of [false, true]) {
    const f = fixture(), old = deferred(), newer = deferred(); await f.page.loadFamilyCenter()
    f.setMutation(() => old.promise); f.invoke(action)
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0].at(-1), 'token-a')
    f.page.aboutToDisappear()
    if (changedAccount) f.page.user = { ...f.page.user, token: 'token-b' }
    f.page.aboutToAppear(); await tick()
    f.setMutation(() => newer.promise); f.invoke('invite'); assert.equal(f.writes.length, 2)
    const count = f.queries.length
    if (failed) old.reject(new Error('old failure')); else old.resolve({ id: 'old' })
    await tick()
    assert.equal(f.page.isSubmitting, true); assert.equal(f.page.errorText, '')
    assert.equal(f.messages.length, 0); assert.equal(f.queries.length, count)
    newer.resolve({ id: 'new' }); await tick()
    assert.equal(f.page.isSubmitting, false); assert.equal(f.messages.length, 1)
  }
})

test('代付和代收旧确认框在账号切换、离页重进或刷新后不能提交', async () => {
  for (const action of ['pay', 'receipt']) for (const change of ['account', 'reenter', 'refresh']) {
    const f = fixture(); await f.page.loadFamilyCenter()
    if (action === 'pay') f.page.confirmFamilyPayment(f.page.familyOrders[0])
    else f.page.confirmFamilyReceipt(f.page.familyOrders[1])
    const confirm = f.dialogs[0].secondaryButton.action
    if (change === 'account') { f.page.user = { ...f.page.user, token: 'token-b' }; f.page.reloadForCurrentAccount(); await tick() }
    if (change === 'reenter') { f.page.aboutToDisappear(); f.page.aboutToAppear(); await tick() }
    if (change === 'refresh') await f.page.loadFamilyCenter()
    confirm(); await tick(); assert.equal(f.writes.length, 0, action + ':' + change)
    f.invoke(action); await tick(); assert.equal(f.writes.length, 1)
    f.dialogs.at(-1).secondaryButton.action(); await tick(); assert.equal(f.writes.length, 1)
  }
})

test('亲友操作验证当前列表、身份和状态，确认时再次核对金额与资格', async () => {
  const f = fixture(); await f.page.loadFamilyCenter()
  f.page.acceptFamilyInvitation('missing'); f.page.removeFamilyRelation('missing')
  f.page.shipOrder({ ...shipment, id: 'missing' }); f.page.confirmFamilyPayment({ ...payment, id: 'missing' })
  f.page.confirmFamilyReceipt({ ...receipt, id: 'missing' })
  assert.equal(f.writes.length, 0); assert.equal(f.dialogs.length, 0)
  f.page.familyRelations[0].friendAccount = 'other'; f.page.acceptFamilyInvitation('relation')
  assert.equal(f.writes.length, 0)
  f.page.confirmFamilyPayment(f.page.familyOrders[0]); const confirmPay = f.dialogs.at(-1).secondaryButton.action
  f.page.familyOrders[0].payMoney = 21; confirmPay(); await tick(); assert.equal(f.writes.length, 0)
  f.page.confirmFamilyReceipt(f.page.familyOrders[1]); const confirmReceipt = f.dialogs.at(-1).secondaryButton.action
  f.page.familyOrders[1].canReceive = false; confirmReceipt(); await tick(); assert.equal(f.writes.length, 0)
  f.page.ordersToShip[0].orderState = 3; f.invoke('ship'); assert.equal(f.writes.length, 0)
  f.page.user = { ...f.page.user, role: 'buyer' }; f.invoke('ship'); assert.equal(f.writes.length, 0)
})

test('普通刷新不吞当前操作成功，写结果未知后旧读取不能恢复操作', async () => {
  const f = fixture(), gate = deferred(); await f.page.loadFamilyCenter()
  f.setMutation(() => gate.promise); f.invoke('invite'); f.invoke('invite'); assert.equal(f.writes.length, 1)
  await f.page.loadFamilyCenter(); gate.resolve({ id: 'ok' }); await tick()
  assert.equal(f.messages.length, 1); assert.equal(f.page.isSubmitting, false)
  const failure = deferred(), stale = deferred(); f.setMutation(() => failure.promise); f.invoke('invite')
  f.api.relations = () => stale.promise; const loading = f.page.loadFamilyCenter()
  failure.reject(new Error('lost response')); await tick()
  stale.resolve(pageResult([])); await loading
  f.invoke('invite'); assert.equal(f.writes.length, 2)
  assert.match(f.page.errorText, /未确认/)
  f.api.relations = async p => pageResult([], p); f.setMutation(async () => ({ id: 'ok' }))
  await f.page.loadFamilyCenter(); f.invoke('invite'); await tick(); assert.equal(f.writes.length, 3)
  const saved = fixture(); await saved.page.loadFamilyCenter()
  saved.api.relations = async () => { throw new Error('refresh failed') }
  saved.invoke('invite'); await tick()
  assert.deepEqual(saved.messages, ['绑定邀请已发送']); assert.match(saved.page.errorText, /加载失败/)
  saved.invoke('invite'); assert.equal(saved.writes.length, 1)
})

test('隐藏后账号和角色变化清除旧列表，旧串行查询不继续请求或解除新加载', async () => {
  for (const failed of [false, true]) {
    const f = fixture(), old = deferred(), current = deferred()
    f.api.relations = () => old.promise; const loading = f.page.loadFamilyCenter()
    f.page.aboutToDisappear(); f.api.relations = () => current.promise; f.page.aboutToAppear()
    if (failed) old.reject(new Error('old')); else old.resolve(pageResult([]))
    await loading; assert.equal(f.page.loading, true); assert.equal(f.queries.length, 2)
    current.resolve(pageResult([])); await tick()
    f.page.aboutToDisappear(); const count = f.queries.length
    f.page.user = { ...f.page.user, role: 'buyer' }; f.page.reloadForCurrentAccount()
    assert.equal(f.page.ordersToShip.length, 0); assert.equal(f.queries.length, count)
    f.page.showFamilyCenter(); await tick(); assert.equal(f.page.ordersToShip.length, 0)
    const visibleQueries = f.queries.length
    f.page.refreshAfterForeground(); await tick(); assert.equal(f.queries.length, visibleQueries + 2)
  }
})
