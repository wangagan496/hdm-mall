import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf } from './native-harness.mjs'
import { BusinessError, orderWriteFailure } from './order-write-boundaries.mjs'

test('交易错误不显示服务端技术原文，登录与价格错误有明确操作提示，未知结果仍保留未知分类', () => {
  assert.equal(orderWriteFailure(new BusinessError('SQLITE_CONSTRAINT raw detail', 400)).message, '当前操作无法完成，请刷新订单后重试')
  assert.equal(orderWriteFailure(new BusinessError('token invalid', 401)).message, '登录已过期，登录后继续')
  assert.equal(orderWriteFailure(new BusinessError('PRICE_CHANGED', 409)).message, '价格已更新，请核对后提交')
  assert.equal(orderWriteFailure(new BusinessError('upstream stack', 503)).unknownResult, true)
  assert.equal(orderWriteFailure(new Error('ECONNREFUSED 127.0.0.1')).message, '')
})

test('资料页保留业务错误原话，网络断开和服务端未知结果分别提示', () => {
  const instance = { interceptors: { request: { use() {} }, response: { use() {} } } }
  const { requestErrorMessage } = execute(sourceOf('shoph5-vue3/src/api/index.ts').replaceAll('import.meta.env', '({})'), {
    axios: { __esModule: true, default: { create: () => instance, isAxiosError: error => error?.isAxiosError === true } },
  }, { Error })
  assert.equal(requestErrorMessage(new Error('服务器返回的资料不完整，请重新加载')), '服务器返回的资料不完整，请重新加载')
  assert.equal(requestErrorMessage(new Error('登录已失效，请重新登录')), '登录已失效，请重新登录')
  assert.equal(requestErrorMessage(new Error('')), '暂时连不上服务，输入已保留')
  assert.equal(requestErrorMessage({ isAxiosError: true, code: 'ECONNABORTED' }), '暂时连不上服务，输入已保留，请检查网络后重试')
  assert.equal(requestErrorMessage({ isAxiosError: true, response: { status: 503 } }), '还在确认保存结果，输入已保留，请稍后重试')
  assert.equal(requestErrorMessage({ isAxiosError: true, response: { status: 401 } }), '登录已过期，请重新登录后继续')
})
