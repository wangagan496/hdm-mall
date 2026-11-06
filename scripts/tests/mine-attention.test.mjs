import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, pageMethods, sourceOf, tick } from './native-harness.mjs'

function fixture() {
  const calls = [], routes = []
  const MineView = pageMethods('mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets', 'MineView', {}, {
    getOrderAttentionCountAPI: token => { const gate = deferred(); calls.push({ ...gate, token }); return gate.promise },
    PAGE_PATH: { LOGIN_PAGE: 'login', ORDER_PAGE: 'orders' },
  })
  const page = new MineView()
  page.user = { token: 'buyer-a' }
  page.stackPath = { pushPath: value => routes.push(value) }
  return { page, calls, routes }
}

test('我的页进入和订单页返回时读取当前账号未读数并隔离迟到账号响应', async () => {
  const f = fixture()
  f.page.aboutToAppear()
  assert.equal(f.calls[0].token, 'buyer-a')
  f.calls[0].resolve({ count: 2 }); await tick()
  assert.equal(f.page.attentionCount, 2)
  f.page.openOrders(0)
  assert.equal(f.routes.length, 1)
  assert.equal(f.calls[1].token, 'buyer-a')
  f.page.user = { token: 'buyer-b' }
  f.page.reloadAttentionForAccount()
  assert.equal(f.page.attentionCount, 0)
  assert.equal(f.calls[2].token, 'buyer-b')
  f.calls[1].resolve({ count: 5 }); await tick()
  assert.equal(f.page.attentionCount, 0)
  f.calls[2].resolve({ count: 1 }); await tick()
  assert.equal(f.page.attentionCount, 1)
  f.page.refreshAttentionOnOrdersReturn()
  assert.equal(f.calls[3].token, 'buyer-b')
  f.calls[3].resolve({ count: 0 }); await tick()
  assert.equal(f.page.attentionCount, 0)
})

test('未登录的我的页不请求订单提醒汇总', async () => {
  const f = fixture(); f.page.user = {}
  f.page.aboutToAppear(); await tick()
  assert.equal(f.calls.length, 0)
  assert.equal(f.page.attentionCount, 0)
})

test('真实订单路由返回回调刷新红点，隐藏后的迟到响应作废', async () => {
  const f = fixture()
  f.page.aboutToAppear(); f.calls[0].resolve({ count: 2 }); await tick()
  f.page.openOrders(0)
  assert.equal(typeof f.routes[0].onPop, 'function')
  f.page.setAttentionVisible(false)
  f.calls[1].resolve({ count: 9 }); await tick()
  assert.equal(f.page.attentionCount, 2)
  f.routes[0].onPop()
  assert.equal(f.calls.length, 3)
  f.calls[2].resolve({ count: 0 }); await tick()
  assert.equal(f.page.attentionCount, 0)
  f.page.setAttentionVisible(false); f.page.setAttentionVisible(true)
  assert.equal(f.calls.length, 4)
  f.page.user = {}; f.page.reloadAttentionForAccount()
  f.calls[3].resolve({ count: 9 }); await tick()
  f.routes[0].onPop()
  assert.equal(f.calls.length, 4)
  assert.equal(f.page.attentionCount, 0)
})
