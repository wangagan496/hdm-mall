import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkBridge } from '../../shoph5-vue3/scripts/check-bridge.mjs'
import { sourceOf, execute } from './native-harness.mjs'
const types = sourceOf('shoph5-vue3/src/types/harmonyos.d.ts')
const native = sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/views/WebView.ets')
const models = sourceOf('mixed-development-h5/commons/models/src/main/ets/BusinessModels.ets')

test('桥接对象缺少网页字段或基本类型变化均拒绝，允许原生多余字段', () => {
  for (const field of ['nickname', 'token', 'avatar', 'birthday', 'gender', 'provinceCode']) {
    const declaration = new RegExp(`  ${field}\\??: string\\n`)
    assert.match(models, declaration)
    assert.throws(() => checkBridge(types, native, models.replace(declaration, '')), new RegExp(`HDMUser\\.${field}`))
    assert.throws(() => checkBridge(types, native, models.replace(declaration, `  ${field}: number\n`)), /基本类型不一致/)
  }
  assert.equal(checkBridge(types, native, models.replace('role?: string', 'role?: string\n  nativeOnly?: boolean')), 12)
})
test('真实桥接契约通过，缺实现、漏注册、改名、改参数及返回值均被拒绝', () => {
  assert.equal(checkBridge(types, native), 12)
  assert.throws(() => checkBridge(types, native.replace("'completeProfileFlush'", "'missingFlush'")), /completeProfileFlush/)
  assert.throws(() => checkBridge(types, native.replace('pickerPhoto(): Promise<string>', 'missingPhoto(): Promise<string>')), /pickerPhoto/)
  assert.throws(() => checkBridge(types, native.replace("'pickerPhoto',", '')), /pickerPhoto/)
  assert.throws(() => checkBridge(types.replace('pickerPhoto:', 'renamedPhoto:'), native), /Photo/)
  assert.throws(() => checkBridge(types, native.replace('pickerPhoto(): Promise<string>', 'pickerPhoto(limit: number): Promise<string>')), /参数或返回/)
  assert.throws(() => checkBridge(types, native.replace('pickerPhoto(): Promise<string>', 'pickerPhoto(): Promise<number>')), /参数或返回/)
})
test('旧账号资料不能被合并到新身份，身份字段保持当前会话', () => {
  const { mergeBridgeUser } = execute(sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/views/userBridgePresentation.ets'))
  const current = { id: 'b', token: 'b-token', account: 'b-account', role: 'buyer' }
  assert.throws(() => mergeBridgeUser(current, { id: 'a', token: 'a-token', nickname: '旧资料' }), /登录|账号|会话/)
  const updated = mergeBridgeUser(current, { id: 'b', token: 'b-token', account: 'changed', role: 'merchant', nickname: '新昵称' })
  assert.equal(updated.account, 'b-account'); assert.equal(updated.role, 'buyer'); assert.equal(updated.nickname, '新昵称')
})
