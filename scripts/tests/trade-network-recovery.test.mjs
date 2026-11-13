import test from 'node:test'
import assert from 'node:assert/strict'
import { pageMethods, deferred, tick, sourceOf } from './native-harness.mjs'

const familyPath = 'mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets'
const orderPath = 'mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderView.ets'

test('B-83 buyer cancellation reconciliation restores usable actions after failed list refresh', async () => {
  let pending = [{ orderId: 'order', action: 'request' }]
  const Page = pageMethods(orderPath, 'OrderView', {}, {
    OrderState: { ALL_TAB: 0 },
    cancelActions: { pending: () => pending, inspectPending: async () => { pending = [] } },
    orderCancellation: { pendingIds: () => [] },
    getOrderDetailAPI: async () => ({ id: 'order', orderState: 2, canWithdrawCancel: true }),
    isOrderStateInTab: () => true,
  })
  const page = new Page()
  page.user = { id: 'buyer', token: 'token' }
  page.sessionToken = 'token'
  page.loadedToken = 'token'
  page.loadedState = 0
  page.orders = [{ id: 'order', orderState: 2 }]
  page.pendingCancelActions = ['order']
  page.loadFailed = true
  page.replaceOnNextLoad = true
  await page.checkPendingOrder('order')
  assert.equal(page.orders[0].canWithdrawCancel, true)
  assert.equal(page.canUseOrder('order'), true, 'Recovered buyer cancellation leaves actions disabled')
})

function merchantFixture() {
  const jobs = []
  const submitted = deferred()
  const record = { orderId: 'order', action: 'reject-and-ship', reason: 'Already packed', requestKey: 'original-key' }
  const actions = { pending: () => [record], confirm: () => submitted.promise, recover: async () => {}, inspectPending: async () => { actions.pending = () => [] } }
  let cancelled = 0
  class RecoveryQuery {
    start(work) { jobs.push(work) }
    cancel() { cancelled++ }
  }
  const Page = pageMethods(familyPath, 'FamilyView', {}, { cancelActions: actions, RecoveryQuery })
  const page = new Page()
  page.user = { id: 'merchant', token: 'token', role: 'merchant' }
  page.sessionToken = 'token'
  page.sessionRole = 'merchant'
  page.loadedToken = 'token'
  page.ordersToShip = [{ id: 'order', canResolveCancel: true, cancelRequest: { id: 'request-1', state: 'pending' } }]
  page.safeToast = () => {}
  page.openCancelResolution(page.ordersToShip[0])
  page.rejectReason = record.reason
  page.loadFamilyCenter = async () => { page.errorText = '加载失败，请重新登录或重试' }
  return { page, submitted, record, jobs, actions, cancelled: () => cancelled }
}

test('B-86 merchant keeps entered rejection reason visible while accepted response is missing', async () => {
  const fixture = merchantFixture()
  const task = fixture.page.resolveCancellation('order', 'reject-and-ship', false, fixture.record.reason)
  await tick()
  const observed = { reason: fixture.page.rejectReason, visible: fixture.page.showCancelResolution }
  fixture.submitted.reject(new Error('操作结果待确认，请重新查询'))
  await task
  assert.deepEqual(observed, { reason: 'Already packed', visible: true })
})

test('B-85 B-86 merchant schedules automatic reconciliation after offline accepted response', async () => {
  const fixture = merchantFixture()
  const task = fixture.page.resolveCancellation('order', 'reject-and-ship', false, fixture.record.reason)
  fixture.submitted.reject(new Error('操作结果待确认，请重新查询'))
  await task
  assert.deepEqual(Array.from(fixture.page.pendingCancelActions), ['order'])
  assert.ok(fixture.jobs.length > 0, 'No automatic recovery query scheduled for merchant cancellation')
})

test('B-86 explicit rejection failure preserves reason and allows retry', async () => {
  const fixture = merchantFixture()
  fixture.page.loadFamilyCenter = async () => { fixture.page.loadRequestId++; fixture.page.errorText = '' }
  const task = fixture.page.resolveCancellation('order', 'reject-and-ship', false, fixture.record.reason)
  fixture.actions.pending = () => []
  fixture.submitted.reject(new Error('拒绝原因不符合要求'))
  await task
  assert.equal(fixture.page.rejectReason, 'Already packed')
  assert.equal(fixture.page.showCancelResolution, true)
  assert.equal(fixture.page.isSubmitting, false)
  assert.equal(fixture.page.currentResolution()?.id, 'order')
})

test('B-86 successful resolution clears reason only after confirmation', async () => {
  const fixture = merchantFixture()
  fixture.page.loadFamilyCenter = async () => {}
  const task = fixture.page.resolveCancellation('order', 'reject-and-ship', false, fixture.record.reason)
  assert.equal(fixture.page.rejectReason, 'Already packed')
  fixture.actions.pending = () => []
  fixture.submitted.resolve()
  await task
  assert.equal(fixture.page.showCancelResolution, false)
  assert.equal(fixture.page.rejectReason, '')
})

test('B-85 B-86 automatic recovery only reads receipts then refreshes the visible list', async () => {
  const fixture = merchantFixture()
  const task = fixture.page.resolveCancellation('order', 'reject-and-ship', false, fixture.record.reason)
  fixture.submitted.reject(new Error('操作结果待确认，请重新查询'))
  await task
  assert.ok(fixture.jobs.length, 'Automatic receipt query is missing')
  fixture.actions.confirm = fixture.actions.recover = () => { assert.fail('Recovery must not submit again') }
  fixture.page.loadFamilyCenter = async () => { fixture.page.loadRequestId++; fixture.page.errorText = ''; fixture.page.ordersToShip = [] }
  assert.equal(await fixture.jobs[0](), true)
  assert.deepEqual(Array.from(fixture.page.pendingCancelActions), [])
  assert.equal(fixture.page.showCancelResolution, false)
  assert.equal(fixture.page.isSubmitting, false)
  assert.equal(fixture.page.errorText, '')
})

test('B-86 pending reason survives close while leaving the page cancels recovery', async () => {
  const fixture = merchantFixture()
  const task = fixture.page.resolveCancellation('order', 'reject-and-ship', false, fixture.record.reason)
  fixture.submitted.reject(new Error('操作结果待确认，请重新查询'))
  await task
  fixture.page.closeCancelResolution()
  assert.equal(fixture.page.rejectReason, 'Already packed')
  assert.equal(fixture.page.showCancelResolution, true)
  fixture.page.aboutToDisappear()
  assert.ok(fixture.cancelled() > 0, 'Leaving page did not cancel automatic recovery')
  assert.equal(fixture.page.showCancelResolution, false)
})

test('B-85 foreground recovery survives a failed list load without manual refresh', async () => {
  const fixture = merchantFixture()
  fixture.page.pendingCancelActions = ['order']
  fixture.page.errorText = '加载失败，请重新登录或重试'
  fixture.page.loadFamilyCenter = async () => { fixture.page.errorText = '' }
  fixture.page.refreshAfterForeground()
  await tick()
  assert.deepEqual(Array.from(fixture.page.pendingCancelActions), [])
  assert.equal(fixture.page.errorText, '')
})

test('RelationsProbe scrolls to pagination and revoke controls without relaxing touch bounds', () => {
  const script = sourceOf('scripts/device-trade-regression.ps1')
  const section = script.slice(script.indexOf("  if ($RelationsProbe) {"))
  assert.match(section, /Scroll-Text '关系下一页'/)
  assert.match(section, /Scroll-Text '解除绑定'/)
  assert.match(script, /2780/)
})

test('B-85 receipt success followed by failed list refresh keeps recovery pending', async () => {
  const fixture = merchantFixture()
  fixture.page.pendingCancelActions = ['order']
  assert.equal(await fixture.page.checkCancelAction('order'), false)
  assert.deepEqual(Array.from(fixture.page.pendingCancelActions), ['order'])
  assert.equal(fixture.page.showCancelResolution, true)
  fixture.page.loadFamilyCenter = async () => { fixture.page.errorText = '' }
  assert.equal(await fixture.page.checkCancelAction('order'), true)
  assert.equal(fixture.page.showCancelResolution, false)
})

test('B-85 late receipt after leaving or changing account cannot update visible state', async () => {
  for (const leave of [true, false]) {
    const fixture = merchantFixture()
    const gate = deferred()
    let refreshes = 0
    fixture.page.pendingCancelActions = ['order']
    fixture.actions.inspectPending = () => gate.promise
    fixture.page.loadFamilyCenter = async () => { refreshes++ }
    const task = fixture.page.checkCancelAction('order')
    if (leave) fixture.page.aboutToDisappear()
    else { fixture.page.user = { id: 'other', token: 'other-token', role: 'merchant' }; fixture.page.synchronizeFamilySession() }
    gate.resolve()
    await task
    assert.equal(refreshes, 0)
    assert.equal(fixture.page.showCancelResolution, false)
  }
})

test('B-86 retained reason sheet visibly distinguishes submitting and checking', () => {
  const source = sourceOf(familyPath)
  const sheet = source.slice(source.indexOf('private CancelResolutionSheet()'), source.indexOf('private OrderSummary('))
  assert.ok(sheet.includes("pendingCancelActions.includes(this.resolvingOrder?.id || '')"))
  assert.match(sheet, /正在核对取消结果/)
  assert.match(sheet, /正在提交取消处理/)
})

test('B-85 superseded recovery list query cannot clear the visible pending state', async () => {
  const fixture = merchantFixture()
  fixture.page.pendingCancelActions = ['order']
  fixture.page.loadFamilyCenter = async () => { fixture.page.loadRequestId++; await tick(); fixture.page.loadRequestId++; fixture.page.errorText = '' }
  assert.equal(await fixture.page.checkCancelAction('order'), false)
  assert.equal(fixture.page.showCancelResolution, true)
  assert.equal(fixture.page.rejectReason, 'Already packed')
})
