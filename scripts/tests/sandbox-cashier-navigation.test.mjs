import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf } from './native-harness.mjs'

const source = sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/components/SandboxCashier.ets')
const callbackStart = source.indexOf('.onLoadIntercept((event) => {') + '.onLoadIntercept((event) => {'.length
const callback = source.slice(callbackStart, source.indexOf('\n        })', callbackStart))
const feedback = source.slice(source.indexOf('      if (this.'), source.indexOf('      Web('))
const body = source.slice(source.indexOf('export struct SandboxCashier'), source.indexOf('  build()'))
  .replace('export struct', 'export class').replace(/@\w+(?:\([^)]*\))?\s*/g, '')
const hint = '请在下方网页中选择「继续浏览器付款」完成支付'

function fixture() {
  const messages = []
  let closed = 0
  const text = { fontSize() { return this }, id() { return this } }
  const { SandboxCashier } = execute(body + `\nintercept(event) {${callback}}\nrenderFeedback() {${feedback}}\n}`, {}, {
    webview: { WebviewController: class {} }, Text: value => { messages.push(value); return text },
  })
  const page = new SandboxCashier()
  page.onClose = () => closed++
  return { page, intercept: url => page.intercept({ data: { getRequestUrl: () => url } }),
    feedback: () => { messages.length = 0; page.renderFeedback(); return [...messages] }, closed: () => closed }
}

test('L3 支付宝客户端协议仍被拦截，但提示继续网页付款，不要求关闭收银台', () => {
  for (const url of ['alipays://platformapi/startapp?appId=test', 'alipay://platformapi/startapp', 'ALIPAYS://platformapi/startapp']) {
    const f = fixture()
    assert.equal(f.intercept(url), true)
    assert.deepEqual(f.feedback(), [hint])
    assert.equal(f.closed(), 0)
    assert.equal(f.intercept('https://mobileclientgw-sandbox.dl.alipaydev.com/cashier'), false)
    assert.deepEqual(f.feedback(), [hint])
  }
})

test('L3 任意协议、伪装域名及非 HTTPS 地址继续阻止，不冒充支付宝客户端提示', () => {
  for (const url of ['intent://pay', 'javascript:alert(1)', 'file:///tmp/pay', 'http://alipay.com',
    'https://alipay.com.evil.test/pay', 'https://alipay.com@evil.test/pay', 'https://evil.test/?next=alipays://pay',
    'https://alipay.com:444/pay', 'alipays-evil://pay', 'alipays.evil://pay', 'https://evil.test']) {
    const f = fixture()
    assert.equal(f.intercept(url), true, url)
    assert.equal(f.feedback().length, 1)
    assert.notEqual(f.feedback()[0], hint)
    assert.equal(f.closed(), 0)
  }
})

test('L3 支付宝 HTTPS 白名单保持放行，空事件安全拦截', () => {
  for (const url of ['https://alipay.com', 'https://open.alipay.com/', 'https://alipaydev.com:443/pay',
    'https://openapi-sandbox.dl.alipaydev.com/gateway.do', 'https://alipay.com/?next=alipays://pay']) {
    const f = fixture()
    assert.equal(f.intercept(url), false, url)
    assert.deepEqual(f.feedback(), [])
    assert.equal(f.page.intercept(undefined), true)
  }
})

test('L3 后续客户端跳转替换旧拦截提示，其他不可信导航仍显示阻止提示', () => {
  const f = fixture()
  f.intercept('https://evil.test')
  f.intercept('alipays://platformapi/startapp')
  assert.deepEqual(f.feedback(), [hint])
  f.intercept('https://evil.test')
  assert.notEqual(f.feedback()[0], hint)
})
