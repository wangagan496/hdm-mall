import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, execute, sourceOf, tick } from './native-harness.mjs'
const test = (name, run) => nodeTest(name, { timeout: 1500 }, run)

const path = 'mixed-development-h5/features/cart/src/main/ets/presentation/views/PayView.ets'
const source = sourceOf(path)
const body = source.slice(source.indexOf('struct PayView {'), source.indexOf('  build()'))
  .replace('struct PayView', 'export class PayView').replace(/@\w+(?:\([^)]*\))?\s*/g, '') + '\n}'
const row = (id = 'order-a', values = {}) => ({ id, orderState: 1, canPay: true, canInvitePayer: true,
  serverManaged: true, countdown: 100, payMoney: 19, ...values })
function fixture() {
  let user = { token: 'token-a' }, orderId = 'order-a', now = 1000
  let load = async id => row(id), relations = async p => ({ items: [{ id: 'r', friendId: 'friend-a' }], page: p, pages: 2 })
  let mutation = async () => ({ id: orderId }), overlay = async () => {}
  const queries = [], writes = [], navigations = [], messages = [], overlays = []
  const config = { DEMO_ORDER_FLOW: false }
  const presentation = execute(sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/utils/OrderPresentation.ets'), {
    models: execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/OrderState.ets')),
    '@kit.BasicServicesKit': { systemDateTime: { TimeType: { STARTUP: 0 }, getUptime: () => now } },
  })
  const { PayView } = execute(body, {}, {
    ...execute(sourceOf('mixed-development-h5/commons/storage/src/main/ets/RecoveryQuery.ets'), {}, {
      setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer },
    }),
    GlobalVariable: config, PAGE_PATH: { PAY_PAGE: 'pay', PAY_RESULT_PAGE: 'result' },
    auth: { getUserInfo: () => user }, ...presentation,
    demoOrderStore: { getOverlay: () => null, getEvaluation: () => null,
      setOverlay: (...args) => { overlays.push(args); return overlay(...args) } },
    getOrderDetailAPI: (id, token) => { queries.push(['order', id, token]); return load(id, token) },
    getPayerRelationsPageAPI: (p, token) => { queries.push(['relatives', p, token]); return relations(p, token) },
    startPaymentAPI: (...args) => { writes.push(['pay', ...args]); return mutation(...args) },
    resumePaymentAPI: (...args) => { writes.push(['resume', ...args]); return mutation(...args) },
    refreshPaymentAPI: (...args) => { queries.push(['refresh', ...args]); return Promise.resolve({paymentState:'confirming'}) },
    invitePayerAPI: (...args) => { writes.push(['payer', ...args]); return mutation(...args) },
  })
  const page = new PayView(); page.user = user; page.orderId = orderId
  page.safeToast = message => messages.push(message)
  page.stackPath = { getParamByName: () => [orderId], replacePath: value => navigations.push(value), pop: () => navigations.push('pop') }
  return { page, queries, writes, navigations, messages, overlays, config,
    setUser: value => { user = value; page.user = value }, setOrderId: value => { orderId = value },
    setLoad: fn => { load = fn }, setRelations: fn => { relations = fn }, setMutation: fn => { mutation = fn },
    setOverlay: fn => { overlay = fn }, advance: millis => { now += millis } }
}

test('收银台刷新期间和失败后不能付款或邀请，重试确认后才恢复', async () => {
  const f = fixture(); await f.page.load()
  const gate = deferred(); f.setLoad(() => gate.promise); const loading = f.page.load()
  await f.page.handlePayment(); await f.page.choosePayer('friend-a')
  assert.equal(f.writes.length, 0)
  gate.reject(new Error('offline')); await loading
  await f.page.handlePayment(); await f.page.choosePayer(null); assert.equal(f.writes.length, 0)
  f.setLoad(async id => row(id)); await f.page.load()
  await f.page.choosePayer('friend-a'); assert.deepEqual(f.writes[0], ['payer', 'order-a', 'friend-a', 'token-a'])
})

test('收银台换账号清除订单和亲友，监听前不能借新账号提交且资料更新不重复查询', async () => {
  const f = fixture(); await f.page.load()
  f.setUser({ token: 'token-b' })
  await f.page.handlePayment(); await f.page.choosePayer(null); assert.equal(f.writes.length, 0)
  const gate = deferred(); f.setLoad(() => gate.promise); f.page.reloadForCurrentAccount()
  assert.equal(f.page.order, null); assert.equal(f.page.relatives.length, 0); assert.equal(f.page.paying, false)
  gate.resolve(row()); await tick()
  const count = f.queries.length; f.setUser({ token: 'token-b', nickname: 'new' }); f.page.reloadForCurrentAccount()
  assert.equal(f.queries.length, count)
  f.setUser({}); f.page.reloadForCurrentAccount(); await tick()
  assert.equal(f.queries.length, count); assert.equal(f.page.order, null); assert.equal(f.page.loading, false)
})

test('旧付款和代付操作成功失败不干扰新页面或释放新操作锁', async () => {
  for (const action of ['pay', 'payer']) for (const changeAccount of [false, true]) for (const failed of [false, true])
    for (const sameOrder of [false, true]) {
    const f = fixture(), old = deferred(), newer = deferred(); await f.page.load()
    f.setMutation(() => old.promise)
    const pending = action === 'pay' ? f.page.handlePayment() : f.page.choosePayer('friend-a')
    assert.equal(f.writes[0].at(-1), 'token-a')
    f.page.aboutToDisappear(); if (changeAccount) f.setUser({ token: 'token-b' })
    const nextId = sameOrder ? 'order-a' : 'order-b'
    f.setOrderId(nextId); f.page.aboutToAppear(); await tick()
    f.setMutation(() => newer.promise)
    const next = f.page.choosePayer(null)
    assert.equal(f.writes.length, 2); assert.equal(f.page.paying, true)
    const queries = f.queries.length
    if (failed) old.reject(new Error('old failure')); else old.resolve({ id: 'order-a' })
    await pending
    assert.equal(f.page.paying, true); assert.equal(f.page.loadFailed, false)
    assert.equal(f.queries.length, queries); assert.equal(f.navigations.length, 0); assert.equal(f.messages.length, 0)
    newer.resolve({ id: nextId }); await next
    assert.equal(f.page.paying, false); assert.equal(f.messages.length, 1)
  }
})

test('收银台隐藏时不查询，旧成功失败不影响重进查询，换订单不显示旧资料', async () => {
  for (const failed of [false, true]) {
    const f = fixture(), old = deferred(), newer = deferred()
    f.setLoad(() => old.promise); const loading = f.page.load()
    f.page.aboutToDisappear(); f.page.refreshAfterForeground(); const hidden = f.page.load()
    assert.equal(f.queries.length, 1)
    await hidden
    f.setOrderId('order-b'); f.setLoad(() => newer.promise); f.page.aboutToAppear()
    assert.equal(f.page.order, null)
    if (failed) old.reject(new Error('old failure')); else old.resolve(row('order-a', { orderState: 2 }))
    await loading
    assert.equal(f.page.loading, true); assert.equal(f.navigations.length, 0)
    newer.resolve(row('order-b')); await tick()
    assert.equal(f.page.order.id, 'order-b'); assert.equal(f.page.loading, false)
  }
})

test('付款和邀请入口验证当前权限、订单状态、亲友选择和倒计时', async () => {
  for (const values of [{ canPay: false }, { orderState: 6 }, { orderState: 2 }]) {
    const f = fixture(); await f.page.load(); Object.assign(f.page.order, values)
    await f.page.handlePayment(); assert.equal(f.writes.length, 0); assert.equal(f.navigations.length, 0)
  }
  const f = fixture(); await f.page.load()
  f.page.order.canInvitePayer = false; await f.page.choosePayer('friend-a'); assert.equal(f.writes.length, 0)
  f.page.order.canInvitePayer = true; await f.page.choosePayer('foreign'); assert.equal(f.writes.length, 0)
  f.page.relativesLoadFailed = true; await f.page.choosePayer('friend-a'); assert.equal(f.writes.length, 0)
  await f.page.choosePayer(null); assert.equal(f.writes.length, 1)
  f.advance(101000); await f.page.handlePayment(); assert.equal(f.writes.length, 1)
  assert.ok(f.messages.some(message => message.includes('超时')))
})

test('当前操作不重复提交，普通刷新不吞掉成功，未知写结果要求重读后再操作', async () => {
  for (const action of ['pay', 'payer']) {
    const f = fixture(), gate = deferred(); await f.page.load(); f.setMutation(() => gate.promise)
    const pending = action === 'pay' ? f.page.handlePayment() : f.page.choosePayer('friend-a')
    await f.page.handlePayment(); await f.page.choosePayer(null); assert.equal(f.writes.length, 1)
    await f.page.load(); gate.resolve({ id: 'order-a' }); await pending
    if (action === 'pay') assert.equal(f.navigations[0].param.orderId, 'order-a')
    else assert.equal(f.messages.length, 1)
    const failed = fixture(); await failed.page.load(); failed.setMutation(async () => { throw new Error('response lost') })
    const unknown = action === 'pay' ? failed.page.handlePayment() : failed.page.choosePayer(null)
    const staleRead = deferred(); failed.setLoad(() => staleRead.promise); const reading = failed.page.load()
    await unknown
    staleRead.resolve(row()); await reading
    assert.equal(failed.page.paying, false)
    if (action === 'pay') {
      assert.equal(failed.navigations[0].name, 'result')
    } else {
      assert.equal(failed.page.loadFailed, true)
    }
    await failed.page.handlePayment()
    await failed.page.choosePayer(null)
    assert.equal(failed.writes.length, 1)
    if (action === 'pay') assert.deepEqual(failed.messages, [])
    else assert.match(failed.messages[0], /未确认/)
  }
})

test('演示写入迟到不跳转新页面，已付与取消查询导航一次且错误订单不能操作', async () => {
  const f = fixture(), gate = deferred(); f.config.DEMO_ORDER_FLOW = true
  f.setLoad(async id => row(id, { serverManaged: false })); await f.page.load()
  f.setOverlay(() => gate.promise); const pending = f.page.handlePayment()
  f.page.aboutToDisappear(); f.setOrderId('order-b'); f.page.aboutToAppear(); await tick()
  gate.resolve(); await pending
  assert.equal(f.navigations.length, 0); assert.deepEqual(f.overlays, [['order-a', 2]])
  for (const state of [2, 6]) {
    const current = fixture(); current.setLoad(async id => row(id, { orderState: state }))
    await current.page.load(); await current.page.load()
    assert.equal(current.navigations.length, 1)
  }
  const mismatch = fixture(); mismatch.setLoad(async () => row('wrong-order')); await mismatch.page.load()
  await mismatch.page.handlePayment(); await mismatch.page.choosePayer(null)
  assert.equal(mismatch.writes.length, 0); assert.equal(mismatch.page.loadFailed, true)
})

test('真实开机时长倒计时归零或首次读到零时，收银页不发送付款', async () => {
  for (const countdown of [100, 0]) {
    const f = fixture()
    f.setLoad(async id => row(id, { countdown }))
    await f.page.load()
    f.advance(countdown * 1000)
    assert.equal(f.page.remainingCountdown(), 0)
    await f.page.handlePayment()
    assert.equal(f.writes.length, 0)
    assert.equal(f.navigations.length, 0)
    assert.ok(f.messages.some(message => message.includes('超时')))
  }
})

test('B-54：重进收银页仍为确认中时不能再次发起付款', async () => {
  const f = fixture()
  f.setLoad(async id => row(id, { paymentState: 'confirming', canPay: false, countdown: 0,
    paymentNotice: '正在确认付款结果，请勿重复付款' }))
  await f.page.load()
  assert.equal(f.page.order.paymentState, 'confirming')
  await f.page.handlePayment()
  assert.equal(f.writes.length, 0)
  assert.equal(f.page.order.paymentNotice, '正在确认付款结果，请勿重复付款')
  f.page.aboutToDisappear(); f.page.aboutToAppear(); await tick()
  await f.page.handlePayment(); assert.equal(f.writes.length, 0)
  f.setLoad(async id => row(id, { orderState: 2, paymentState: 'paid', canPay: false }))
  await f.page.load()
  assert.equal(f.navigations.at(-1).name, 'result')
  assert.equal(f.writes.length, 0)
})

test('G：沙箱下单打开收银台，关闭只核对订单，不把网页返回当付款成功', async () => {
  const f = fixture(); f.setLoad(async id => row(id, { paymentChannel: 'alipay-sandbox' })); await f.page.load()
  const url = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do?test=1'
  f.setMutation(async () => ({ id:'order-a', orderId:'order-a', paymentId:'p1', checkoutUrl:url, sandbox:true }))
  await f.page.handlePayment()
  assert.equal(f.page.sandboxCheckoutUrl, url); assert.equal(f.navigations.length, 0)
  f.setLoad(async id => row(id, { paymentChannel:'alipay-sandbox', paymentState:'confirming', canPay:false, canResumePayment:true }))
  await f.page.closeSandboxCashier()
  assert.ok(f.queries.some(q=>q[0]==='refresh' && q[1]==='order-a' && q[2]==='token-a'))
  assert.equal(f.page.sandboxCheckoutUrl, ''); assert.equal(f.navigations.length, 0)
  assert.equal(f.page.order.paymentState, 'confirming')
  f.page.aboutToDisappear()
})

test('G：沙箱续付复用接口，换账号和隐藏后旧响应不能打开收银台', async () => {
  for (const stale of [false, true]) {
    const f = fixture(); f.setLoad(async id => row(id, { paymentChannel:'alipay-sandbox', paymentState:'confirming', canPay:false, canResumePayment:true })); await f.page.load()
    const gate = deferred(); f.setMutation(() => gate.promise)
    const pending = f.page.resumeSandboxPayment(); assert.deepEqual(f.writes[0], ['resume','order-a','token-a'])
    if (stale) { f.setUser({token:'token-b'}); f.page.reloadForCurrentAccount(); f.page.aboutToDisappear() }
    gate.resolve({id:'order-a',orderId:'order-a',checkoutUrl:'https://openapi-sandbox.dl.alipaydev.com/gateway.do?test=1',sandbox:true})
    await pending
    assert.equal(Boolean(f.page.sandboxCheckoutUrl), !stale); assert.equal(f.navigations.length,0)
    f.page.aboutToDisappear(); assert.equal(f.page.sandboxCheckoutUrl,'')
  }
})

test('G：沙箱返回错误订单或非固定 HTTPS 沙箱域名时不打开页面', async () => {
  for (const url of ['https://openapi-sandbox.dl.alipaydev.com.evil.test/gateway.do','https://openapi.alipay.com/gateway.do','http://openapi-sandbox.dl.alipaydev.com/gateway.do','https://evil.test/']) {
    const f = fixture(); f.setLoad(async id => row(id,{paymentChannel:'alipay-sandbox'})); await f.page.load()
    f.setMutation(async () => ({id:'order-a',orderId:'order-a',checkoutUrl:url,sandbox:true}))
    await f.page.handlePayment(); assert.equal(f.page.sandboxCheckoutUrl,''); assert.equal(f.navigations.length,0)
    f.page.aboutToDisappear()
  }
})

test('G：订单列表可续开同一沙箱支付单，模拟确认中仍禁止重付', () => {
  const presentation = execute(sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/utils/OrderPresentation.ets'), {
    models: execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/OrderState.ets')),
    '@kit.BasicServicesKit': {systemDateTime:{TimeType:{STARTUP:0},getUptime:()=>1000}},
  })
  assert.equal(presentation.canOpenPayment(row('o',{canPay:false,paymentState:'confirming',paymentChannel:'alipay-sandbox',canResumePayment:true})),true)
  assert.equal(presentation.canOpenPayment(row('o',{canPay:false,paymentState:'confirming'})),false)
})
